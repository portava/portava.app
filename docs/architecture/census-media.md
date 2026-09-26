# Portava Media v2 — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt` |
| **`.docx` reconciliation** | Extracted `word/document.xml`, stripped tags, whitespace-normalised, diffed against the `.txt`. **The only differences are three XML entity escapes** (`&amp;` in the title, and no `&lt;`/`&gt;` in this spec). The `.txt` is a faithful transcription; the "`.docx` is authority" clause never had to be exercised. |
| **Section count** | The brief said 50 sections. **50 top-level sections is correct**, but the spec also carries **11 numbered subsections** (§4.1, §6.1, §15.1, §15.2, §16.1, §16.2, §16.3, §23.1, §31.1, §46.1, §46.2) — **61 numbered units**. Counting only the 50 undercounts §16 (three subsections, 31 requirements) and §46 (two subsections, 14 requirements) badly. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. Backend paths relative to `artifacts/api-server/src/`, client paths to `travel-buddy-standalone/` unless stated. |
| `head_commit` | `1fe72289b` — RE-DECLARED 2026-09-15 at the squash merge of PR #482. The previous value was `80a8d655a`, a commit on the pre-merge branch. **The squash made it an orphan**: it still exists in a clone that fetched the branch, but it is on no line of history leading to `main`, and `check:census-freshness` refuses an orphan because the check would pass locally and fail in a fresh clone. Nothing about this census was re-measured and NO verdict moves — `1fe72289b` is the commit its previous declaration's tree became, so zero counted files have changed since it. The prior declaration and its reasoning follow. — RE-DECLARED 2026-09-14 by §16, replacing `42aeac38`. RE-DECLARED 2026-09-14 by the Media pass, which re-measured **all 153 non-`C` rows** and moved none — the finding being that what remains is client screens, seeded-off flags and rankers outside any lane's file set. Eight counted files changed, all of them that pass's own refusal work. It does **NOT** certify the 297 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `42aeac38` — DECLARED 2026-09-11, and **it starts a clock rather than certifying a past**. Read the next row before quoting it. |
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

> **METHOD RESTATED 2026-09-14 — the first half stands; "pre-existing" is renamed UNKNOWN.**
>
> **What stands.** The attributable test is positive evidence and it is the good kind: the
> artifact's own header names this spec or one of its phases (the list of headers directly
> above this paragraph is that evidence), or a migration in the declared Media v2 band created
> it. **216 — and, after §14's ten, 226 — is a count of rows carrying that evidence, and it
> does not move.**
>
> **What does not.** The *"pre-existing"* test is *"the artifact predates the programme and the
> spec merely happens to describe it"*. Predating a programme is a fact about file history, not
> about what its author was working from; a specification can be written and worked from long
> before this repository has a copy, so predating it is consistent with both answers. The owner
> has ruled that inference out of this corpus. **Read every `P` below as UNKNOWN**: *no evidence
> was found attributing this artifact to this spec, and none was gathered attributing it
> anywhere else either.* Some of the named artifacts carry a hint of provenance in this
> document's own parenthesis — `lib/mediaProcessing.ts` *"written for the privacy audit"*,
> `lib/delayedPostPublisher.ts` *"a pre-existing product feature"* — and a **P** becomes
> **attributable-elsewhere** as soon as that hint is a citation in the file itself rather than a
> note here.
>
> **What this changes in the numbers: nothing.** 216 A and 75 P still sum to the 291 correct
> verdicts. The 75 are now 75 UNKNOWN rather than 75 "not this spec's", and the sentence
> *"the spec inherited rather than commissioned"* below is an inference the evidence does not
> carry — it may well be true, and it is not measured.
> See `docs/architecture/attribution-method.md`.

| | count | share of 450 |
| --- | --- | --- |
| BUILT-AND-CORRECT, spec-attributable | **216** | **48.0 %** |
| BUILT-AND-CORRECT, attribution UNKNOWN (was labelled "pre-existing") | 75 | 16.7 % |
| (BUILT-AND-CORRECT, total) | 291 | 64.7 % |

Per-section split of the 291 correct verdicts, so the 216 can be re-derived rather than
taken on trust — `A` = attributable to this spec (evidenced), `P` = attribution UNKNOWN
(the mark formerly read "pre-existing"; see the method restatement above):

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
| *Offline / degraded mode on device (§39)* | **NOT-BUILT ×7, C ×1** | §39 names seven things to cache. The tree has one: `state/freshness.ts` `cachedAsOfLabel`, used once (`MediaWorldShell.tsx:102#cachedAsOfLabel(ageMinutesFrom(world.generatedAt))`). There is no media cache, no trip-media bundle, no saved-place cache, no gem cache, no map-thumbnail cache. Absence is a construction fact. |
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
| MD2 | World-first, not creator-first | **W** | World-first exists (`services/media/MediaProjectionService.ts:455` groups by zone before anything else; `lib/media/mediaProjection.ts:95` comments the contributor as *"visible but secondary"*). The live ranker is creator-first: `services/ranking/MediaFeedRankingService.ts:11-15` lists `activeCreatorBoost`, `newCreatorBoost`, `returningCreatorBoost`, `underexposedBoost` as its boost layer and `:16` a per-creator fatigue layer. Creator identity is the ranking axis there, not the world. |
| MD3 | No infinite-feed dependency | **W** | `src/components/media/WatchFeed.tsx:1-8` — *"full-screen vertical video feed … renders a paging list"* — is the default mode of the shipped tab. The World shell has no infinite feed; the shell is not what ships. |
| MD4 | Media does not own truth; Live Intelligence owns current claims and confidence | **C** | `MediaProjectionService.ts:719#export async function readCurrentState(` is the only source of a current-state label and it delegates to `lib/liveClaimRead.readLiveClaimEnvelopes`; `:1-22` states the rule. `lib/media/mediaFreshness.ts:2-12` keeps media freshness a pure age function. |
| MD5 | A photo or video may become an evidence candidate but never becomes truth automatically | **C** | `lib/media/mediaEvidenceLink.ts:130` — `if (!(await isFlagEnabled(sc, MEDIA_EVIDENCE_FLAG))) return refuse("flag_disabled")` — the seam is dark, and even ON it produces a *link*, not a claim: `:69-74` is a refusal taxonomy, and the module never writes `intel_claims`/`intel_state_snapshots`. |
| MD6 | Observed, inferred, user-claimed, generated and predicted information remain distinguishable | **C** | `lib/media/mediaTimeBands.ts:16-32` — Typical is tagged `historical_pattern`, Likely-Next `portava_prediction`, both `NON_OBSERVATION` source classes, both constructed `live:false`. `mediaEvidenceEligibility.ts:38-48` carries the §6 eight-value source vocabulary including `generated`. |
| MD7 | Every meaningful media object connects to action or context | **C** | `services/media/MediaActionResolver.ts:1-33` resolves a per-item action set against the same authorization gate as each target endpoint; `routes/mediaActions.ts:43` serves it. Contextual open: `MediaWorldShell.tsx:63-78` stages the place's other perspectives rather than a global feed. |
| MD8 | Authentic media outranks generated fallback media | **N** | *Unguarded absence.* No `source_type` / provenance term appears in `MediaFeedRankingService.ts` or in the World-shell ordering (`MediaProjectionService.ts:864-866` sorts by `capturedAt` only). Nothing would prevent generated media from outranking authentic media if any existed. |
| MD9 | Privacy, location precision, blocks, trust and eligibility resolve before client projection | **C** | `routes/mediaWorld.ts:18-33` states the invariant and `MediaProjectionService.ts:673#export async function projectCandidatesProtected(` `projectCandidatesProtected` enforces it — every non-owner projection passes `lib/mediaEligibility.filterEligibleMediaCandidates` and then the `lib/mediaLocationVisibility` choke point before shaping. |
| MD10 | Hidden Gems are first-class and require stronger protection than normal Places | **C** | `lib/mediaLocationVisibility.ts:354` `resolveMediaLocationWithGemProtection` applies the stricter of asset tier and gem ceiling; `:542` `gemCeilingForItem` matches by canonical place **and** coordinate proximity; `:601` `loadRestrictiveGems` throws so the caller treats the batch as undetermined rather than open. |
| MD11 | Success is measured by useful real-world outcomes, not merely minutes watched | **W** | The outcome vocabulary exists (`src/features/media/telemetry/mediaTelemetry.ts:71-78`, eight §45 events) and is dark. The live ranker multiplies by `watchCompletionRate`, `qualifiedViewCount` and `rewatchRate` (`MediaFeedRankingService.ts:60-70`) — minutes watched is a first-class ranking input on the surface that ships. |

### §3 Primary Navigation — the six lenses

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD12 | NOW — current visual state around the viewer (city visual pulse, changing-now zones, relevant opportunities) | **C** | `MediaProjectionService.ts:455` `buildWorldProjection` → `cityVisualState` + `forYouNow` + `changingNow`; client `screens/MediaWorldScreen.tsx`. |
| MD13 | PLACES — visual reality organised around canonical Places (Current View mosaics, time rail, place state, actions) | **C** | `MediaProjectionService.ts:519` `buildPlaceProjection`; client `screens/MediaPlacesScreen.tsx:223#{mode === 'time' ? (` and `screens/MediaPlacesScreen.tsx:228#) : mode === 'map' ? (` renders time and map modes. |
| MD14 | EXPERIENCES — media organised around real-world experiences | **C** | `services/media/MediaExperienceResolver.ts:1-14`, resolving a canonical Event or Trip; client `screens/MediaExperiencesScreen.tsx:56`. |
| MD15 | HIDDEN GEMS — protected discovery and current Gem state | **W** | The lens exists but is not a Media v2 projection: `MediaWorldShell.tsx:24` imports the **pre-existing** `components/media/GemsFeed.tsx` and there is no `/media/gems` endpoint in `routes/mediaWorld.ts` (the seven registered routes at `:96,120,149,196,221,245,271` do not include one). §43's `GET /media/gems` is unserved and the lens shows the old feed. |
| MD16 | PEOPLE — explicitly social lens | **C** | `MediaProjectionService.ts:1125#export async function buildPeopleProjection(` `buildPeopleProjection` (the only builder that requests `needFollows: true`, `routes/mediaWorld.ts:214`); client `screens/MediaPeopleScreen.tsx`. |
| MD17 | MY WORLD — owner library and personal experience history | **C** | `MediaProjectionService.ts:1244#export async function buildMyWorldProjection(` `buildMyWorldProjection`; `services/media/MyWorldMemoryService.ts:1-33`; client `screens/MyWorldMediaScreen.tsx`. |

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
| MD25 | Media Map | **N** | No `MediaMapScreen`. The §21 *projection* exists server-side (`MediaProjectionService.ts:1625#export async function buildMediaMapProjection(`); the screen does not, and `MyWorldMediaScreen.tsx:95-99` renders the map mode as a placeholder — *"A map of everywhere you've been arrives with the Media Map phase."* |
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
| MD37 | `sourceType` is the eight-value set camera/library/provider/official/community/generated/screenshot/derivative | **W** | `2250:98-108` adds the CHECK — as a **superset including the legacy `'user'`**, documented as such (*"legacy default (0191); kept, not rewritten"*). `0191:28` still defaults `source_type` to `'user'`, so every row written on the dark path lands outside the §6 vocabulary. *(pointer corrected 2026-09-26, §28.11)* |
| MD38 | `version` — the asset is a versioned aggregate | **W** | `0191:36` `version INTEGER NOT NULL DEFAULT 1` exists; no writer increments it and no reader compares it. A column, not a concurrency contract. |
| MD39 | `capturedAt` is distinct from `uploadedAt` | **C** | `lib/mediaAssets.ts:26-50` is an unusually candid header: the column, the type and every consumer existed but *"NO production caller ever supplied a non-null value"*. `capturedAtFromImageBytes` (`:69-84`) now reads EXIF from the raw buffer **before** `processImage` strips it, and rejects anything outside `[1990-01-01, now+24h]` — an implausible capture time stays `null` rather than becoming a lie. |
| MD40 | `MediaAttachment` contract (asset↔entity link) | **C** | `0191:45-55` *(pointer corrected 2026-09-26, §28.11)*, with `UNIQUE (media_asset_id, entity_type, entity_id)`. Read on a live path at `services/wall/WallCandidateLoaders.ts:243#.select("entity_id, is_cover, position, media_assets(captured_at)")`. *(POINTER REFRESH 2026-09-22 (§17): the Wall lane moved this read 31 lines and the old pointer landed on a bare `}`. Re-read at this head — the same table, the same four projected columns, the same `entity_type`/`entity_id` predicate. The only edit inside the block wraps the envelope in `rowsOrThrow`, which raises a PostgREST `{ error }` into the catch that already stood there; that catch returns the same empty map the swallowed error produced, so the contract this row grades is untouched.)* |
| MD41 | `entityType` covers post/postcard/memory/trip/place/event/hidden_gem/shared_moment/observation | **W** | `0191:48` *(pointer corrected 2026-09-26, §28.11)* is bare `TEXT` with **no CHECK** — nine required values, zero enforced. `2250:47-51` explicitly asserts only position/is_cover/visibility_override. Writers exist for `memory` (`PassportMemoryService.ts:133`) and `hidden_gem` (`HiddenGemService.ts:150`); `shared_moment` and `observation` have none. |
| MD42 | `position` / `isCover` ordering and cover selection | **C** | `0191:50-51` plus the partial cover index `:59-60` *(pointer corrected 2026-09-26, §28.11)*; read at `services/wall/WallCandidateLoaders.ts:243#.select("entity_id, is_cover, position, media_assets(captured_at)")` and applied at `services/wall/WallCandidateLoaders.ts:260#if (!cur || (cover && !cur.cover) || (cover === cur.cover && position < cur.position)) {` — cover wins, then lowest `position`. *(POINTER REFRESH 2026-09-22 (§17): repointed after the Wall lane's edits; the selection expression is byte-identical.)* |
| MD43 | `visibilityOverride` on the attachment | **W** | `0191:52` *(pointer corrected 2026-09-26, §28.11)* `visibility_override TEXT` exists and **nothing reads it**: no non-test reference outside `database.types.ts`. A stored override that no serving path consults is not an override. |
| MD44 | A single asset participates in multiple product objects without duplicating the underlying file | **W** | The *schema* makes it possible (`UNIQUE (media_asset_id, entity_type, entity_id)` allows fan-out from one asset). The *product* does the opposite: `.agents/memory/posts-media-urls-vs-post-media.md` records that `posts.media_urls` and `post_media` are *"separate stores that are not kept in sync"*, that `routes/posts.ts` creation *"writes `media_urls` and inserts no `post_media` row in the same handler"*, and that `lib/mediaAccess.ts` authorises by `.contains("media_urls",[publicUrl])` as a **distinct branch** from its `post_media` branch. The file's identity is duplicated across two stores that can disagree, and the canonical third is dark. |

### §7 Context Graph

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD45 | MediaAsset → Person | **C** | `lib/media/mediaProjection.ts:176` `projectContributor` (handle-first, presentation-name opt-in applied by the caller). |
| MD46 | → Place | **C** | `MediaActionResolver.ts:203` `refs.push({ kind:"place", … })`, through the location choke point. |
| MD47 | → Neighborhood | **C** | `mediaProjection.ts:89-91` carries `neighborhood`/`city`/`country` as coarse labels. |
| MD48 | → Event | **C** | `MediaExperienceResolver.ts:113#kind` `kind: "event" | "trip"`, emitted at `:269#event`, gated by `checkEventEligibility` (imported at `:17#checkEventEligibility` from `routes/events.ts`). |
| MD49 | → Trip | **C** | `MediaActionResolver.ts:260` `kind:"trip"`, emitted only when the viewer may see the trip. |
| MD50 | → Hidden Gem | **C** | `MediaActionResolver.ts:276#mayDiscloseGemIdentity`, and only for a gem the viewer may be told about (`HiddenGemPrivacyGuard.mayDiscloseGemIdentity`, cited at `:31-33`). |
| MD51 | → Shared Moment | **C** | *(CLOSED 2026-09-14 by the Media lane.)* The edge was in the schema and nothing read it: `shared_moment_contributions.post_id` references `posts(id)` (`artifacts/api-server/src/migrations/2064_shared_moments_foundation.sql:38#post_id UUID REFERENCES posts(id) ON DELETE SET NULL`). It is now resolved on the media context graph at `artifacts/api-server/src/services/media/MediaActionResolver.ts:362#kind: "shared_moment"`, behind three gates that are the Shared Moments surface's OWN, not new policy: the capability chain (`:342#areSharedMomentsEnabled`), an APPROVED contribution, and accepted membership via `lib/places/sharedMoments.momentRole` — the same predicate `GET /shared-moments/:id` answers `not_member` on. A non-member is told nothing: not the id, not the title. Proof: `artifacts/api-server/src/test/mediaActionsCompass.test.ts` "MD51 — a media item resolves to the Shared Moment it was contributed to" (5 cases). Mutations that turned it red: dropping the membership gate; accepting a pending contribution; dropping the capability chain; treating an archived Moment as active. **One implementation note that is a cross-lane request, not a caveat:** the kind rides on `MediaGraphKind` (`artifacts/api-server/src/services/media/MediaActionResolver.ts:84#MediaGraphKind`) rather than on `MediaEntityKind`, because `compass/CompassMediaContext.ts:305` builds `Record<MediaEntityRef["kind"], string>` and widening that union is a compile-breaking edit to a file this lane does not own. §14.3. |
| MD52 | → Time | **C** | `mediaProjection.ts:84` `capturedAt`; the writer is `lib/mediaAssets.ts:69-84`. |
| MD53 | → Observation | **W** | The only media→observation path is `lib/media/mediaEvidenceLink.ts`, which is a *link* table behind `media_evidence_enabled` (`:130`), and no projection carries an observation ref. The edge is drawn in code and severed at runtime. |
| MD54 | Context resolution is server-side | **C** | `routes/mediaWorld.ts:18-33`; `resolveMediaEntities` runs in `services/media/`, and the client's `services/mediaProjection.ts` only fetches. |

### §8 Four-Layer Media Model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD55 | Social layer (creator, caption, Stamp, comments, shares) owned by Media/Post systems | **C** | `routes/mediaFeed.ts:2099,2126,2251,2305` — like/react/share/comments all on the post spine. |
| MD56 | Context layer (place, area, Event, Trip, people, time) owned by canonical entity systems | **C** | `MediaActionResolver.ts:199-263` resolves refs into the canonical systems rather than storing a copy. |
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
| MD67 | LIVE INTELLIGENCE | **C** | `lib/liveClaimRead.readLiveClaimEnvelopes`, consumed at `MediaProjectionService.ts:719#export async function readCurrentState(`; fail-closed to `[]`. |
| MD68 | MEDIA / DISCOVERY / MAP / COMPASS outputs | **C** | `routes/mediaWorld.ts` (media), `MediaProjectionService.ts:1625#export async function buildMediaMapProjection(` map clusters, `compass/CompassMediaContext.ts:232` consumed at `routes/compass.ts:1654#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, turnNowMs);`. |

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
| MD86 | Place Current View — trend, updated-at, current-picture strength, perspective/contributor counts, group chips, what's-changing, actions | **C** | `MediaProjectionService.ts:519` `buildPlaceProjection` returns `currentState` + `perspectives` + `freshness`; rendered by `screens/MediaPlacesScreen.tsx` with `components/CurrentPictureBadge.tsx` and `components/PerspectiveMosaic.tsx`. |
| MD87 | The viewer is contextual, not a TikTok-style vertical stranger-video feed | **W** | The contextual viewer exists (`screens/MediaPerspectiveViewerScreen.tsx`, entered via `MediaWorldShell.tsx:63-78` which stages the place's other perspectives). It is not the viewer a user reaches: `app/media-viewer/[id].tsx` is the shipped one and its §15 rail is gated at `:568` on the dark shell flag; opening from the Watch feed lands in the paging vertical player. |
| MD88 | Entry context **Place** → swipe collection is that Place's other perspectives | **C** | `MediaWorldShell.tsx:63-78` `openPlacePerspectiveViewer` sets `kind:'place'` with the place's groups and hero media, then routes to `/media-perspective/`. |
| MD89 | Entry context **Event** → other Event perspectives | **N** | `state/perspectiveViewerContext.ts` accepts an entry-context kind, and `setPerspectiveViewerContext` has exactly one caller (`MediaWorldShell.tsx:74#kind: 'place',`) passing exactly one kind. No event producer. |
| MD90 | Entry context **People** → that person / social context | **N** | As MD89. |
| MD91 | Entry context **Trip** → Trip media | **N** | As MD89. |
| MD92 | Entry context **Map** → current geographic cluster | **N** | As MD89, and there is no Media Map screen to enter from (MD25). |
| MD93 | Related-perspectives strip on the viewed item | **C** | `MediaPerspectiveService.ts` groups; `components/PerspectiveMosaic.tsx` renders; the collection is the staged entry context. |

### §15 Media Actions · §15.1 I Want This · §15.2 Do This Experience

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD94 | Go There / Show on Map / Directions | **W** | `MediaActionResolver.ts:381-387` emits `show_on_map`, targeting `/api/media/places/:placeId` — a projection, deliberately coordinate-free. There is **no directions action**: no `directions` id in the resolver's thirteen (`:335,343,351,361,381,388,399,416,424,439,461,482,498`), and `directions_tap` exists only as a telemetry name (`routes/mediaAnalyticsBatch.ts:41`) with no emitter. "Go There" and "Directions" are unbuilt; "Show on Map" is built and correct. |
| MD95 | Ask Compass | **C** | `MediaActionResolver.ts:19-20` (Compass-gated) → `compass/CompassMediaContext.ts:232` `buildCompassMediaContext`, consumed at `routes/compass.ts:1654#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, turnNowMs);`. |
| MD96 | Save Place | **C** | Resolved to the existing saved-places endpoint and served at `routes/mediaActions.ts:43,82`. |
| MD97 | Add to Trip | **C** | `MediaActionResolver.ts:16-18` — offered only when `canEditPlan` passes, which is the exact gate the trip-plan-item endpoint enforces, so the rail can never grant access the endpoint would deny. |
| MD98 | Create Plan | **C** | Same resolver, Compass-gated (`:19-20`). |
| MD99 | Meet Here | **C** | `MediaActionResolver.ts:18-19` — respects the new-event kill switch. |
| MD100 | Invite People | **C** | *(CLOSED 2026-09-14 by the Media lane.)* `artifacts/api-server/src/services/media/MediaActionResolver.ts:574#id: "invite_people",` → `POST /api/shared-moments/:id/invites`, an EXISTING endpoint, offered only to an owner/manager of the Shared Moment the media belongs to — the exact `ownerOrManager` gate that endpoint enforces (`artifacts/api-server/src/routes/sharedMoments.ts:119#if (!(await ownerOrManager(ctx.sc, params.data.id, ctx.userId))) { sendError(res, "forbidden"); return; }`), so §47 holds: the rail asks the same question the endpoint asks. A plain member sees the Moment and is NOT offered the invite; media with no Moment gets no action (no dead actions). Proof: `artifacts/api-server/src/test/mediaActionsCompass.test.ts` "MD100 — Invite People, gated by the endpoint's own ownerOrManager check" (6 cases). Mutations red: offering it to any member; removing the action. |
| MD101 | Find Similar / Cheaper / Quieter / Busier | **W** | "Find somewhere like this" reaches Compass as a structured ask (`CompassMediaContext.ts:9-12`). There is no cheaper / quieter / busier comparator anywhere — no comparative modifier in the resolver, the Compass media context, or the projection. One of four. *(EVIDENCE CORRECTED 2026-09-13 by the integrating lane; **the verdict does NOT move**. One third of the sentence above is no longer true: `fa5d7c25d` — census-compass §12's CM-03 build — put a comparator INTO the Compass media context, `artifacts/api-server/src/compass/CompassMediaContext.ts:81#export const COMPARATOR_AXIS_CLAIM` mapping *quieter* to `crowd.level` and *cheaper* to `price.cover`, with `artifacts/api-server/src/compass/CompassMediaContext.ts:199#export function buildComparatorBaselines` reporting per axis whether a permitted, unexpired claim exists — provenance only, never a value. The other two thirds were re-measured rather than assumed and still hold: `grep -rn "quieter|cheaper|busier"` over `artifacts/api-server/src/services/media/` returns NOTHING, so neither the resolver nor the projection has a comparative modifier, and **busier has one nowhere on this path**. `W` therefore stands on what this row actually grades — the §23.1 media ACTION set, which still offers `find_similar` and no comparative action, one of four.)* |
| MD102 | See Nearby | **C** | `MediaActionResolver.ts:388-395` — emitted only when a place resolves, targeting `GET /api/media/map` scoped to the media's coarse city. No coordinate leaves the server; the client positions the clusters through the Map gateway it already holds. |
| MD103 | View Event / Passport | **W** | Event refs resolve (`MediaExperienceResolver.ts:269#kind: "event",`). Passport does not: `MediaActionResolver.ts:57` `MediaEntityKind = "media" \| "place" \| "trip" \| "gem"` has no passport member, and §29 keeps Passport on Postcards. Half built. |
| MD104 | Share through Telegraph | **W** | The action is emitted (`MediaActionResolver.ts:343-347`) and the endpoint accepts the target (`routes/mediaFeed.ts:2295` `z.enum(["native","copy_link","telegraph"])`) — but the handler **ignores it**: `:2297-2299` records a share event and returns a `shareUrl`, and no Telegraph thread, message or intent is created on any branch. The action resolves to a URL, not to Telegraph. |
| MD105 | Report / Not Relevant | **C** | `routes/mediaFeed.ts:1070` `POST /media/:id/report`; not-interested/hide are consumed as ranking penalties at `MediaFeedRankingService.ts:65-70`. |
| MD106 | §15.1 "I Want This" — an intent signal, explicitly not a Like | **C** | `2256_media_intent_signals.sql:1-21` gives it its own table and its own grant posture and states the rule — *"a want is never conflated with an engagement count"*; written only through the service-role endpoint at `routes/mediaActions.ts:161`, read at `MediaActionResolver.ts:615`. **Table absent from production** (§3). |
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
| MD118 | §16.1 fan-out to DISCOVERY / MAP / MEDIA / COMPASS | **C** | `routes/mediaFeed.ts:795` gems feed; `services/hiddenGems/CompassHiddenGemService.ts`; `MediaActionResolver.ts:276#mayDiscloseGemIdentity` gem refs. |
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
| MD140 | EARLIER band | **C** | `lib/media/mediaTimeBands.ts:451` `assembleTimeBands`, called at `MediaProjectionService.ts:1586#const { bands, neverLiveRemoved } = assembleTimeBands({`; Earlier is the observed media record. |
| MD141 | NOW band | **C** | `MediaProjectionService.ts:1583#readCurrentState(sc, opts.placeId ?? null, nowMs),` reads `readCurrentState` (gated `liveClaimRead`); empty when live is off, so no fabricated now. |
| MD142 | TYPICAL band | **C** | `mediaTimeBands.ts:22-24` — Typical items are tagged `historical_pattern` and constructed `live:false`; sourced from `readIntelTimeSubstrate` off the live path. |
| MD143 | LIKELY NEXT band | **C** | `mediaTimeBands.ts:23-25` — tagged `portava_prediction`, `live:false`. |
| MD144 | Historical and forecast states must be visually distinct | **C** | `mediaTimeBands.ts:50-57` `TimeBandRenderClass = "observed" \| "typical" \| "predicted"` is emitted for the client to key distinct treatments; `components/MediaTimeRail.tsx` + `state/timeBands.ts` consume it. |
| MD145 | Forecasts carry confidence | **C** | `mediaTimeBands.ts:25-27` — *"a forecast (Likely-Next) MUST carry a confidence band; a predicted item with no derivable confidence is OMITTED, never surfaced bare"*, and `findNeverLiveViolations` drops violators fail-closed with `MediaProjectionService.ts:900-907` logging the removal. |
| MD146 | Media Perspective Resolver stage | **C** | `MediaPerspectiveService.ts:1-15`. |
| MD147 | Independent Sources stage | **W** | The *count* is displayed nowhere and computed nowhere in the media path: `MediaPerspectiveService` counts `contributorCount`, which is distinct contributors, not independent sources. The independence machinery exists (`lib/intelIndependence.ts` merges crews/shared-media/synchronised units) but nothing in Media calls it. |
| MD148 | Coverage Analysis stage | **C** | `routes/mediaViewRequest.ts:111` `GET /v1/media/places/:placeId/visual-coverage` over `lib/missionGeneration` / `intel_mission_candidates`. |
| MD149 | Corroboration stage | **C** | *(CLOSED 2026-09-14 by the Media lane.)* A place's mosaic now carries an agreement measure: `artifacts/api-server/src/services/media/MediaConsensusService.ts:186#export function buildVisualConsensus` counts INDEPENDENT SOURCES (MD147's `lib/intelIndependence` clusters, exported for reuse at `artifacts/api-server/src/services/media/MediaPerspectiveService.ts:120#export function countIndependentSources`) among the perspectives inside the FRESH window, and grades them `none \| single_source \| corroborated \| well_corroborated`. It inherits the anti-manipulation posture rather than restating it: one account posting three photos, two accounts posting one file, and a trip crew each corroborate NOTHING. Stale perspectives corroborate nothing about the current picture. Served on `PlaceProjection` (`artifacts/api-server/src/services/media/MediaProjectionService.ts:954#consensus: buildVisualConsensus(media, currentState.claims, nowMs, {`) and on every `WorldZone` (`:830#buildVisualConsensus`). Proof: `artifacts/api-server/src/test/mediaIndependentSources.test.ts` "MD149 — corroboration counts INDEPENDENT sources inside the fresh window" (5 cases). Mutations red: counting contributors instead of clusters; ignoring the fresh window; dropping the field from the projection. |
| MD150 | Contradiction stage | **C** | *(CLOSED 2026-09-14 by the Media lane.)* The media path now REACHES `lib/intelConflict` — it does not fork it. The conflict state was already riding on every gated live-claim envelope Media fetches (`artifacts/api-server/src/lib/liveClaimRead.ts:136#conflictState: ConflictState;`) and Media was dropping it on the floor; `artifacts/api-server/src/services/media/MediaConsensusService.ts:156#function worstContradiction(` folds it into a place/zone-level `contradiction` block through the canonical `normalizeConflictState`, so an unrecognised stored value still reads as `material` — the stricter direction. A photograph asserts no value, so perspectives are NOT scored against each other; inventing a value axis for them would be fabrication and is refused explicitly in the module header. Proof: `artifacts/api-server/src/test/mediaIndependentSources.test.ts` "MD150 — the contradiction stage reaches lib/intelConflict from a media path" (4 cases), including an end-to-end fixture that promotes a scope and serves a `conflict_state = material` snapshot. Mutations red: returning no contradiction; reading the state leniently instead of through `normalizeConflictState`. |
| MD151 | Visual Consensus Projection | **C** | *(CLOSED 2026-09-14 by the Media lane.)* The consensus object exists and is served: `artifacts/api-server/src/services/media/MediaConsensusService.ts:119#export interface VisualConsensus {` — `state` (`insufficient \| corroborated \| mixed`), the corroboration measure (MD149), the contradiction block (MD150), the §18 uncertainty label and a `requestAnotherObservation` flag that routes to the EXISTING §19 Request-a-View surface. It is on `PlaceProjection` (`artifacts/api-server/src/services/media/MediaProjectionService.ts:860#consensus: VisualConsensus;`) and on `WorldZone` (`:760#VisualConsensus`). Empty input yields `insufficient`, never agreement. Proof: `artifacts/api-server/src/test/mediaIndependentSources.test.ts` "MD151 — a Visual Consensus Projection object exists and is well-formed" + "the consensus object is SERVED on the place projection". |
| MD152 | When reports disagree, surface uncertainty ("Mixed reports — conditions may be changing") | **C** | *(CLOSED 2026-09-14 by the Media lane.)* The copy is `artifacts/api-server/src/services/media/MediaConsensusService.ts:77#export const MIXED_REPORTS_LABEL = "Mixed reports — conditions may be changing";`, emitted as `consensus.uncertaintyLabel` on the place projection and on every world zone, and the consensus `state` flips to `mixed`. THRESHOLD, stated because it is the whole judgement: the banner fires only on a **material** conflict, the same threshold `lib/intelConflict` itself uses to suppress a Live label; a `minor` disagreement is recorded in the block and gets no banner, because escalating it would put "Mixed reports" on every venue where two honest people said 'busy' and 'packed'. A material dispute OUTRANKS corroboration — four agreeing photographs do not settle a disputed live claim. CAVEAT, the same one MD159 carries: with the intel spine holding zero rows in production (`docs/architecture/intel-spine-liveness.md`) no live claim can conflict there yet, so the banner is correct and currently unreachable in prod. Proof: `artifacts/api-server/src/test/mediaIndependentSources.test.ts` "MD152 — when reports disagree, the uncertainty is SURFACED" (3 cases) plus the end-to-end promoted-scope fixture. Mutations red: nulling the label; giving `minor` the banner; letting corroboration outrank the dispute. |
| MD153 | §19 "Last visual update Nm ago" / "Show what's happening?" mission prompt | **C** | `components/RequestAViewPrompt.tsx`; freshness copy from `state/freshness.ts`. |
| MD154 | §19 Request a View — a user requests a specific current perspective | **C** | `services/media/MediaViewRequestService.ts:1-27` + `routes/mediaViewRequest.ts:61`; it **consumes** the existing `intel_mission_candidates` machinery rather than forking a parallel mission system. |
| MD155 | §19 control: opt-in contributor eligibility | **C** | `MediaViewRequestService.ts:20-24` — *"only opted-in + eligible + un-blocked contributors are selected as recipients; block state that cannot be read ⇒ ask nobody"*; opt-in written at `routes/mediaViewRequest.ts:111#/v1/media/view-requests/opt-in`. *(Repointed and ANCHORED 2026-09-15: the line was 94 and the `recipientsDetermined` provenance comment pushed it down 17. `check:doc-citations` did NOT catch it — the citation was UNANCHORED, so the only thing checked was that the file is long enough, which is exactly the blind spot that pass names. Anchored now so the next shift fails loudly.)* |
| MD156 | §19 control: throttling | **C** | `MediaViewRequestService.ts:14-17` — per-viewer **and** per-place fixed windows via `lib/rateLimit`. |
| MD157 | §19 control: safety | **C** | `MediaViewRequestService.ts:17-20` — a place hosting a restrictive gem or protected location is refused, and an **undetermined** gem lookup is refused rather than guessed. |
| MD158 | §19 control: anti-spam | **C** | `MediaViewRequestService.ts:16` — a near-duplicate OPEN request for the same (place, family) is refused. |
| MD159 | §20 World / City Visual Pulse | **C** | `MediaProjectionService.ts:455-503` — zones with `perspectiveCount`, `freshness`, and a state label **only** from a gated live claim (`:479-492`), with `changingNow` filtered to zones that actually have one (`:495`). Client `components/CityVisualPulse.tsx` + `ChangingNowCard.tsx`. Caveat: with the intel spine holding zero rows in production (`docs/architecture/intel-spine-liveness.md`), the state labels the §20 mockup shows ("Building ↑", "Peak ●") can never appear. |
| MD160 | §21 Media Map consumes the canonical Map projection; it does not own a second location engine | **C** | `MediaProjectionService.ts:924-932` — *"This projection deliberately carries NO geometry: geographic placement is delegated to the canonical Map projection (spec §21)"*, and `:952-955` **omits** any cluster without a canonical place id rather than inventing a position. |
| MD161 | §21 Perspective counts per canonical place | **C** | `MediaProjectionService.ts:1625#export async function buildMediaMapProjection(` `buildMediaMapProjection`; served at `routes/mediaWorld.ts:271`. |
| MD162 | §22 Crowd-flow integration — "where the night is moving" from recent perspectives | **N** | Nothing in `services/media/` or `lib/media/` references `crowdFlow` / `crowd_flow`. The producer exists (`lib/mapProducers/crowdFlowProducer.ts`) and Media does not consume it. |
| MD163 | §22 Never expose individual routes | **C** | Satisfied structurally by the producer Media would consume: `lib/crowdFlowProducer.ts:14-30` — *"There is no per-actor path type, anywhere. The input unit is ONE HOP … so a path cannot be assembled even internally."* Vacuous on the Media side (MD162), but the guarantee is real and would hold if Media were wired in. |

### §23 Experience Projections · §23.1 Experience Chains

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD164 | `MediaExperienceProjection` contract | **C** | `services/media/MediaExperienceResolver.ts:111#export interface MediaExperienceProjection {` onward; served at `routes/mediaWorld.ts:149`. |
| MD165 | An experience resolves from a canonical Event **or** a Trip (`placeIds`, `eventId`, `tripId`) | **C** | `MediaExperienceResolver.ts:113#kind` `kind: "event" | "trip"`, with event eligibility reusing `routes/events.checkEventEligibility` (imported at `:17#checkEventEligibility`) rather than re-implementing it. |
| MD166 | `currentState` on an experience | **C** | `MediaExperienceResolver.ts:24-27` reads current state only through the gated live-claim read. |
| MD167 | `perspectiveCount` + `contributorCount` | **C** | Assembled from `MediaPerspectiveService` group counts. |
| MD168 | `freshness` | **C** | `lib/media/mediaFreshness.aggregateFreshness`, imported at `MediaExperienceResolver.ts:29`. |
| MD169 | `confidence` | **W** | The field exists on the shape but no experience-level confidence is computed — the only confidence in the media path is the per-forecast band in `mediaTimeBands`. A declared-but-unfilled field. |
| MD170 | `heroMedia` drawn through the eligibility gate and coarse projector | **C** | `MediaExperienceResolver.ts:10-13` + `projectCandidatesProtected`. |
| MD171 | §23.1 Experience chains (Dinner → Rooftop → Nightclub) | **C** | *(CLOSED 2026-09-14 by the Media lane.)* `artifacts/api-server/src/services/media/MediaExperienceResolver.ts:77#export function buildExperienceChain(media: readonly MediaProjection[]): ExperienceChain {` derives an ORDERED multi-place chain and `MediaExperienceProjection` now carries it (`:61#ExperienceChain`), on both the event and the trip branch (`:281#buildExperienceChain`, `:356#buildExperienceChain`). THE ORDER IS OBSERVED, NOT ASSERTED: a stop's position is the FIRST observed perspective at that place, and the object says so in a `derivedFrom: "observed_capture_times"` field so the claim travels with the data. Nothing infers a route, a traveller's path or an intention: a place with no perspective is not a stop, a place the lib/mediaLocationVisibility choke point withheld is not a stop, one place is not a chain, and an empty experience gets an empty chain. Proof: `artifacts/api-server/src/test/mediaWorldProjection.test.ts` "MD171 — an experience carries an ORDERED chain derived from observed capture times" (6 cases). Mutations red: keeping page order; keying on the last perspective instead of the first; admitting a withheld place; calling one place a chain. |
| MD172 | §23.1 action: Follow This Night | **C** | *(CLOSED 2026-09-14 by the Media lane.)* `artifacts/api-server/src/services/media/MediaActionResolver.ts:650#id: "follow_this_night",` → `GET /api/media/experiences/:experienceId`, the projection that carries the chain, offered ONLY when the media's experience actually has one (`chain.isChain`, i.e. two or more distinct DISCLOSABLE places with observed perspectives) and only when `resolveExperience` re-passes the viewer gate. A trip the viewer may not see yields no action. Proof: `artifacts/api-server/src/test/mediaActionsCompass.test.ts` "MD172/MD173 — the §23.1 chain actions" (5 cases). Mutations red: offering it without a chain. |
| MD173 | §23.1 action: Save Route | **W** | *(PARTLY CLOSED 2026-09-14 by the Media lane — the verdict moves N → W, not to C.)* WHAT CLOSED: a media action now reaches the canonical route-plan system, which is the whole of what the row said was missing. `artifacts/api-server/src/services/media/MediaActionResolver.ts:670#id: "save_route",` → `POST /api/route-plans`, with the chain's stops as canonical place ids, capped at the endpoint's own `max(20)` and offered only when the chain clears its own `min(2)` (`artifacts/api-server/src/routes/routePlan.ts:62#  stops: z.array(CandidateStopSchema).min(2).max(20),`) — so the rail never offers a route the endpoint would reject. WHAT IS STILL OPEN: `CandidateStopSchema` requires `lat`/`lng` (`:48#lat:`) and this rail is coordinate-free by construction, so the emitted stops are not directly submittable — the client must complete each stop through the Map gateway it already holds, exactly as it does for `show_on_map`. **WHAT WOULD TURN THIS RED:** a client call site that takes this action's `stops`, resolves their geometry through the Map gateway and posts a route plan that comes back with an id — or, alternatively, a `sourceType`/`sourceId` branch in `POST /route-plans` that resolves a canonical place id server-side, which would close it without a client. Neither exists today. |
| MD174 | §23.1 action: Add to Trip (on an experience) | **C** | `MediaActionResolver.ts:16-18` — the same `canEditPlan`-gated trip-plan-item action, offered on experience-bound media. |
| MD175 | §23.1 action: Remix | **N** | No remix concept anywhere in the tree. |
| MD176 | §23.1 action: Ask Compass (on an experience) | **C** | `CompassMediaContext.ts:232` carries the experience's entity refs into the Compass ask. |

### §24 Ranking

Two blocks: sixteen named input signals and eight objective terms. The ranker that serves
the surface a user reaches is `services/ranking/MediaFeedRankingService.ts` over
`lib/portavaRank.ts` (`DEFAULT_WEIGHTS` at `:182-201`); the World shell does not rank at
all — `MediaProjectionService.ts:864-866` sorts by `capturedAt` and `:472-475` by zone size.

| id | Requirement (input signal) | V | Evidence |
| --- | --- | --- | --- |
| MD177 | Viewer intent | **N** | No intent input in `portavaRank.RankCandidate`/`ViewerContext` or in `MediaFeedRankingService`; §15.1's want-signal store is not a ranking input (`media_intent_signals` is read only by `MediaActionResolver.ts:615` for the button's own state). |
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
| MD192 | Safety | **C** | Same gate: moderation states that must never reach a social surface are refused upstream (`services/wall/WallCandidateLoaders.ts:1155#moderation states that must never reach a social surface (media_assets).`; `lib/mediaEligibility`). *(POINTER REFRESH 2026-09-22 (§17): repointed 1119→1155 after the Wall lane's edits; the deny-list's members are byte-identical, and §9's standing caveat about which LAYER that list runs on (media_assets, not post_media) is unchanged.)* |
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
| MD204 | Contributor Reliability — usefulness and historical acceptance of structured observations | **C** | `services/media/MediaContributorReputationService.ts:27` `ACCEPTED_STATES`, reading `intel_observations` acceptance. |
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
| MD216 | The People lens prioritises followed users, Trip Crew, Shared Moment participants and relevant creators | **W** | `MediaProjectionService.ts:1125#export async function buildPeopleProjection(` `buildPeopleProjection` is the only builder requesting `needFollows: true` (`routes/mediaWorld.ts:214`) — followed users and creators are handled. Trip Crew and Shared Moment participants are not: no `trip_members` or shared-moment read in the builder. Two of four. |
| MD217 | Uploading media does not imply precise live location | **C** | `lib/mediaProcessing.ts:1-22` strips **all** EXIF including GPS on re-encode, and `lib/videoMetadata.ts` strips the MP4/MOV capture-location atoms; `mediaProjection.ts:76-97` has no coordinate field to carry one even if it survived. |
| MD218 | MediaAsset = photo or video file | **C** | `0191_media_assets.sql:18` `media_type IN ('image','video')`. |
| MD219 | Post = social publication | **C** | `posts` spine; `routes/posts.ts`. |
| MD220 | Postcard = curated travel narrative, Passport-facing media expression | **C** | `passport_postcards`, `routes/postcards.ts`; counted as its own My-World bucket at `MediaProjectionService.ts:1373#{ key: "postcards", label: "Postcards"`. |
| MD221 | Memory = preserved meaningful experience | **C** | `memories` table; `services/passport/PassportMemoryService.ts:133`; `MyWorldMemoryService.ts:1-33` consumes rather than forking it. |
| MD222 | Shared Moment = permitted shared real-world experience | **W** | The object exists (`routes/sharedMoments.ts`, shared-moment Wall renderer) but it is **outside the media context graph** (MD51) and outside the People lens (MD216); §28 requires it as a media object semantic and Media cannot address one. |
| MD223 | Perspective = visual contribution to world context | **C** | `MediaPerspectiveService.ts:1-15`. |
| MD224 | Observation = structured intelligence input | **C** | `intel_observations` + `lib/intelContracts.ts`; distinct from every media object, which is the requirement. |
| MD225 | Passport continues to use Postcards as its primary media expression | **C** | `services/passport/` reads `passport_postcards`; no media-world projection is mounted inside Passport. |
| MD226 | Do not duplicate the full Media product inside Passport | **C** | `MyWorldMemoryService.ts:1-33` — the My-World memory reader *consumes* the §12 derived-memory core and reuses `PassportRemembersService`'s suppression filter rather than forking it; `:14-23` is explicit that the allow/deny boundary is shared, not copied. |
| MD227 | My World filters: All · Posts · Postcards · Memories · Trips · Tagged · Hidden Gems | **C** | `MyWorldMediaScreen.tsx:5-7`; server counts at `MediaProjectionService.ts:759-763`. |
| MD228 | Search my world | **W** | *(PARTLY CLOSED 2026-09-14 by the Media lane — N → W.)* WHAT CLOSED: the owner-scoped search exists server-side. `artifacts/api-server/src/services/media/MediaSearchService.ts:320#export async function searchMedia` takes `scope: "me"` and narrows through the shared loader's single-author path, so "Show my Bangkok rooftop photos" is answerable as `q` + `city` + `scope=me` (proved by `mediaWorldProjection.test.ts` "scope=me returns only the viewer's own media"). WHAT IS STILL OPEN, unchanged: `MyWorldMediaScreen.tsx` has no search input, and `GET /media/me` still takes no `q` — the owner library and the search are two endpoints, not one. **WHAT WOULD TURN THIS RED:** a search field on the My World surface that issues `GET /media/search?scope=me`, or a `q` parameter on `GET /media/me`. The first is client work this lane does not own; the second is a ten-line change to `routes/mediaWorld.ts` that was deliberately NOT made, because duplicating the matcher in a second endpoint is how the two drift apart. |
| MD229 | Owner-only buckets: Drafts · Archived · Uploads · Processing | **C** | `MediaProjectionService.ts:697-729` builds `drafts`/`archived`/`processing` from the owner's own rows and `:759` counts uploads; the route resolves identity from the session only (`routes/mediaWorld.ts:225-231`). |

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
| MD242 | The `CompassMediaContext` contract | **C** | `compass/CompassMediaContext.ts:232` `buildCompassMediaContext`, wired into the real ask path at `routes/compass.ts:1654#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, turnNowMs);`. |
| MD243 | `entityRefs` — coarse, opaque, viewer-permitted | **C** | `CompassMediaContext.ts:26-53` — refs come from `resolveMediaEntities`, which runs the location/gem choke point, so a hidden venue, a gem-ceilinged place, and a protected gem's **name** are all withheld before anything is rendered into the prompt. |
| MD244 | `viewerContext` | **C** | `CompassMediaContext.ts:69-74` — `viewerCountry` and `subjectCity` only, *"never a coordinate"*. |
| MD245 | `permittedIntelligenceRefs` | **C** | `CompassMediaContext.ts:19-25` — filtered **twice**: the intel comes only from the gated fail-closed live-claim read, then is filtered to refs whose place the viewer is eligible to see. |
| MD246 | Question: "Is this worth going to now?" | **C** | `CompassMediaContext.ts:9-12` names it as the driving case; the context lines are appended to the ask at `routes/compass.ts:1654#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, turnNowMs);`. |
| MD247 | Question: "Find somewhere like this." | **C** | Same; `find_similar` action at `MediaActionResolver.ts:399`. |
| MD248 | Question: "Is this still busy?" | **C** | Answerable from `permittedIntelligenceRefs` (gated live claims); returns nothing rather than guessing when live is off. |
| MD249 | Question: "Where is this?" | **C** | `entityRefs` carry the coarse place label subject to the owner's tier and any gem ceiling. |
| MD250 | Question: "Build a plan around this." | **C** | `create_plan` action (`MediaActionResolver.ts:426`), Compass-gated. |
| MD251 | Question: "What's nearby?" | **C** | `see_nearby` (`MediaActionResolver.ts:390`) + the map projection. |
| MD252 | Question: "Where should we go after this?" | **N** | No sequencing concept in the media→Compass context: no next-stop, no chain (MD171), no time-of-evening term. *(STATED ABSENCE FALSIFIED 2026-09-13, and **this verdict is owed a re-read this note does not perform**. `fa5d7c25d` added a sequencing concept to exactly the context this row says has none: `artifacts/api-server/src/compass/CompassMediaContext.ts:225#export function buildSequencingAnchor` carries the canonical place the media resolved to, the coarse city, and a `chainable` flag that is FALSE — with the prompt saying the question cannot be answered — when the location/gem choke point withheld the place, and the block is rendered into the real ask at `routes/compass.ts:1654#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, turnNowMs);`. census-compass §12.1 records the build as CM-03 `W → C` and cites this row by name. The letter is left at `N` because moving a row onto `C` is a media re-measure with mutations, not an integrator's note; the debt is recorded here and in this census's entry in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` rather than silenced.)* |
| MD253 | Question: "Find a quieter or cheaper version." | **N** | See MD101 — no comparative modifier exists anywhere in the media path. *(STATED ABSENCE FALSIFIED 2026-09-13, and **this verdict is owed a re-read this note does not perform** — see MD101, whose correction above states what is now true and what still is not. The comparator this row says exists nowhere exists in the Compass media context as of `fa5d7c25d`, for two of its three words, and reaches the ask; census-compass §12.1's CM-03 records the build. The letter is left at `N` for MD252's reason, and the debt is recorded rather than silenced.)* |
| MD254 | Question: "Add this to my Trip." | **C** | `add_to_trip` (`MediaActionResolver.ts:594#id: "add_to_trip"`), gated by `canEditPlan`. |

### §33 Privacy Model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD255 | `MediaVisibility = public \| followers \| following \| trip_crew \| shared_moment \| private` | **W** | The real enum is three values: `0103_post_media.sql:72` states it outright — *"post_visibility enum only has public, trip_only, private — no followers branch"* — and `lib/mediaEligibility.ts:304-328` branches on exactly `public`/`private`/`trip_only`. `media_assets.visibility` (`0191:35`) is bare `TEXT DEFAULT 'inherit'` with **no CHECK at all**. Three of the six named audiences cannot be expressed. |
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
| MD269 | Safety moderation | **C** | `media_assets.moderation_status` (`0191:29-30` *(pointer corrected 2026-09-26, §28.11)*), `routes/adminMedia.ts`, `post_media_moderation_ledger` (in production), `lib/moderationAudit.ts`. |
| MD270 | Privacy validation | **C** | `lib/mediaLocationVisibility` choke point + `lib/protectedLocations` + the boundary scrub. |
| MD271 | Context qualification | **C** | `resolveMediaEntities` + `lib/mediaEligibility.filterEligibleMediaCandidates`. |
| MD272 | Intelligence eligibility | **C** | `mediaEvidenceEligibility.computeIntelligenceEligibility`, called at `lib/mediaAssets.ts:129`. |
| MD273 | Distribution | **C** | `lib/mediaEligibility.filterEligibleMediaCandidates` is the fail-closed distribution gate; `services/wall/WallCandidateLoaders.ts:1155#moderation states that must never reach a social surface (media_assets).` names the moderation states that must never reach a social surface. *(POINTER REFRESH 2026-09-22 (§17): repointed 1119→1155; members byte-identical.)* |
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
| MD287–MD293 | The seven example queries: "What does An Thuong look like right now?" · "Show hidden beaches near Da Nang." · "Nightlife that looks social tonight." · "Show my Bangkok rooftop photos." · "Where was this photo taken?" · "Show festival media from my Vietnam Trip." · "Find places that look like this." | **W** ×7 | *(RE-GRADED 2026-09-14 by the Media lane — N ×7 → W ×7.)* The stated basis of the N was three clauses and one of them is now false: `GET /media/search` exists (MD367) over `MediaSearchService` (MD349). Per query, so the ×7 is not a wave of the hand: **answerable today, server-side** — "Show my Bangkok rooftop photos" (`scope=me` + `city` + `q`), "Where was this photo taken?" (`mediaId` → the coarse place, proved by `mediaWorldProjection.test.ts` "MD291 — 'Where was this photo taken?' resolves a media id to its coarse place"), "Show festival media from my Vietnam Trip." (`tripId` + `q`), "What does An Thuong look like right now?" (`q` + `freshOnly`). **Partly answerable** — "Show hidden beaches near Da Nang." (`city` + `q` + gem results, but "near" is city-coarse, never a radius) and "Nightlife that looks social tonight." (`category` + `freshOnly`, but nothing models "looks social"). **Not answerable at all** — "Find places that look like this.": there is no cross-place visual index; `lib/media/pHashUtils` + `mediaDedupWorker` are a near-duplicate collapser over one place's own uploads and are NOT a similarity search, and the service says so in `MEDIA_SEARCH_UNSUPPORTED` rather than implying otherwise. And NO USER CAN ASK ANY OF THE SEVEN: MD27 and MD324 are still N. **WHAT WOULD TURN THIS RED:** a client search surface issuing these queries (MD27/MD324), a radius parameter resolved through the canonical Map rather than a city string, a modelled "social"/"busy-looking" signal on the perspective, and a cross-place visual-similarity index. Each is a separate, named build; none is a wording change. |
| MD294 | Result types: Media · Places · Hidden Gems · Events · Trips · Experiences · People | **W** | *(PARTLY CLOSED 2026-09-14 by the Media lane — N → W.)* A result union now exists and is served: `artifacts/api-server/src/services/media/MediaSearchService.ts:127#export interface MediaSearchResults {` carries `media`, `places`, `people`, `hiddenGems` and `experiences`. FIVE KINDS COVERING FIVE OF THE SEVEN NAMED TYPES. Events and Trips are NOT separate result kinds: both reach results only as an `experience` item (the existing `MediaExperienceProjection`, which carries `kind: "event" \| "trip"`), so a search cannot return an event that no media is attached to, or a trip with no perspectives. **WHAT WOULD TURN THIS RED:** an `events` and a `trips` array on `MediaSearchResults`, each populated from the canonical event/trip surfaces through their own eligibility gates (`checkEventEligibility`, trip visibility) rather than through media attachment — i.e. a search that finds the Beach Festival because it is called Beach Festival, not because somebody photographed it. |

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
| MD302 | Cached intelligence must show last-updated time and never be presented as live | **C** | `src/features/media/state/freshness.ts` `cachedAsOfLabel` ("Cached · updated Nm ago"), used at `MediaWorldShell.tsx:102#cachedAsOfLabel(ageMinutesFrom(world.generatedAt))`; and the never-live guarantee is structural — media freshness cannot take the value `live` (`lib/media/mediaFreshness.ts:21`). The one §39 requirement that is built is the one that matters most. |

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
| MD324 | `services/mediaSearch.ts` | **N** | Absent. The SERVER half now exists (`artifacts/api-server/src/services/media/MediaSearchService.ts:320#export async function searchMedia` + `GET /media/search`, MD349/MD367), so this row is no longer blocked on "there is nothing to call" — it is blocked only on the client module. **WHAT WOULD TURN THIS RED:** `travel-buddy-standalone/src/features/media/services/mediaSearch.ts` calling `GET /api/media/search` and typed against `MediaSearchResults`, with a registered test. Client paths are outside the Media backend lane's ownership; this needs the client lane or an explicit hand-off. |
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
| MD339 | MediaAttachmentService | **W** | Same module (`recordMediaAsset` writes both), same gate. Attachments are written on the Memory and Hidden-Gem paths (`PassportMemoryService.ts:133`, `HiddenGemService.ts:150`) and are read on one live path (`services/wall/WallCandidateLoaders.ts:243#.select("entity_id, is_cover, position, media_assets(captured_at)")`) — so the read side works against rows the write side cannot create. *(POINTER REFRESH 2026-09-22 (§17): repointed after the Wall lane's edits. Counted rather than assumed — `from("media_attachments")` occurs 8 times in non-test `artifacts/api-server/src`, the same 8 before and after that lane, and the Wall read named here is the same one. The asymmetry this row grades is a WRITE-side gap and no Wall edit can close or widen it, so **W** stands.)* |
| MD340 | MediaProjectionService | **C** | `services/media/MediaProjectionService.ts:1-23`. |
| MD341 | MediaContextResolver | **C** | `MediaActionResolver.resolveMediaEntities` (`:197-260`) + `MediaExperienceResolver.ts`. Merged into two modules rather than named separately. |
| MD342 | MediaPrivacyGateway | **C** | `lib/mediaLocationVisibility.ts` (the choke point, `:354,468,542`) + `lib/mediaEligibility` + `lib/media/mediaLocationSafety.scrubPreciseLocation` as the boundary backstop. |
| MD343 | MediaProvenanceService | **W** | `mediaEvidenceEligibility.initProvenance/appendEdit/normalizeProvenance` exist and are pure; the only caller is on the dark write path (`mediaAssets.ts:126`). No served object has provenance. |
| MD344 | MediaEvidenceQualifier | **C** | `lib/media/mediaEvidenceEligibility.ts:1-31` — the qualifier itself is complete, fail-closed and independently testable. |
| MD345 | MediaPerspectiveService | **C** | `services/media/MediaPerspectiveService.ts`. |
| MD346 | MediaExperienceResolver | **C** | `services/media/MediaExperienceResolver.ts`. |
| MD347 | HiddenGemMediaService | **C** | `services/hiddenGems/HiddenGemService.ts` + `HiddenGemContributionService.ts` + `lib/hiddenGemState.ts`. |
| MD348 | MediaRankingService | **W** | `services/ranking/MediaFeedRankingService.ts` exists and ranks the **legacy** feed on engagement multipliers (§24); the World shell has no ranking stage at all (`MediaProjectionService.ts:864-866` sorts by capture time). Neither is §24's ranker. |
| MD349 | MediaSearchService | **C** | *(CLOSED 2026-09-14 by the Media lane.)* `artifacts/api-server/src/services/media/MediaSearchService.ts:320#export async function searchMedia` — free text plus city / category / place / trip / scope / freshness / media-id criteria over the SHARED candidate loader and coarse projector, not a second read path. That is the load-bearing property and it is what the tests mostly assert: a blocked author, a private account, a coordinate and an undisclosable hidden gem are each absent from results because `loadEligibleCandidates` + `projectCandidatesProtected` are the only way in. Free text is matched AFTER projection, against the caption plus the DISCLOSURE-APPLIED labels, so a viewer cannot confirm "there is media at a place called X" for a venue the choke point just declined to name them. A criteria-free search returns nothing — it never degrades into the feed. Proof: `artifacts/api-server/src/test/mediaWorldProjection.test.ts` "MD349 — MediaSearchService: text recall" (5 cases) + "search is NOT a second read path: every gate still binds" (3) + "MD294 — the result kinds this search actually produces" (5). Mutations red: querying `posts` directly instead of the shared loader; ignoring the text term; dropping the empty-means-empty guard; dropping `mayDiscloseGemIdentity`; ignoring `freshOnly`; un-narrowing `scope=me`; emitting a place whose id was withheld. Known bounds, stated in the module header not hidden: no visual similarity, no radius, and free-text recall is capped by the shared loader's page. |
| MD350 | MediaActionResolver | **C** | `services/media/MediaActionResolver.ts`. |
| MD351 | MediaModerationService | **C** | `routes/adminMedia.ts` + `lib/moderationAudit.ts` + `post_media_moderation_ledger` + `lib/mediaEligibility` as the distribution gate. |
| MD352 | MediaProcessingService | **C** | `lib/mediaProcessing.ts` + `lib/mediaPipeline.ts` (one policy for both transports) + `lib/videoMetadata.ts`. |

### §42 Projection Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD353 | Media Context Gateway — canonical systems feed one gateway | **C** | `MediaProjectionService.ts:1-23` is that gateway: *"A THIN reader/aggregator … It owns NO truth."* |
| MD354 | Viewer Eligibility resolves next | **C** | `MediaProjectionService.ts:673#export async function projectCandidatesProtected(` `projectCandidatesProtected` is the only shaping path for a non-owner projection, and it runs eligibility then the location choke point. |
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
| MD367 | `GET /media/search` | **C** | *(CLOSED 2026-09-14 by the Media lane.)* Registered as the eighth endpoint of the §43 router at `artifacts/api-server/src/routes/mediaWorld.ts:308#  "/media/search",`, `requireUser` + a tighter rate limit than the browse lenses (30/min — a search box is the cheapest enumeration primitive on any surface that has one), and it answers through `sendProjection`, so the fail-closed precise-location boundary scrub applies to it like every other route. Reachability is proved, not assumed: `artifacts/api-server/src/test/mediaWorldProjection.test.ts` "MD367 — GET /media/search is a reachable, auth-gated endpoint" starts the router on a loopback port and asserts 401/403 rather than 404, with an unregistered sibling path as the 404 control, and separately asserts `routes/index.ts` mounts `mediaWorldRouter` BEFORE `mediaFeedRouter` — the one line that keeps `/media/search` from being swallowed by `mediaFeed`'s `/media/:id`. `mediaWorldBoundaryScrub.test.ts`'s per-route segment count was raised 7 → 8 in the same pass, so the new endpoint is inside the boundary guard rather than beside it. |
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
| MD405 | Geographic context and Map integration | **W** | Server-side yes (`MediaProjectionService.ts:924-932` delegating placement to the canonical Map). Client-side no: there is no Media Map screen (MD25), no map store (MD329), and My World's map mode is a placeholder (`MyWorldMediaScreen.tsx:95-99`). |
| MD406 | Time rails and temporal state as first-class UI | **C** | `components/MediaTimeRail.tsx` + `state/timeBands.ts` over the four §17 bands; Time is a first-class presentation mode for NOW and PLACES (`state/lens.ts:25-26`). |
| MD407 | Subtle current-state pulses; no fake-live treatment | **C** | `components/FreshnessBadge.tsx` renders a `live` class as a calm recency label; media freshness cannot be `live` at all (`mediaFreshness.ts:21`), so a fake-live treatment has no value to render. |
| MD408 | Minimal visible vanity metrics | **W** | True of the shell (no counts on `PerspectiveTile`), false of the product: `WatchItemOverlay.tsx:134,403-437` renders stamp, comment and save counts through `formatCompactCount` as the primary rail. |
| MD409 | Clear freshness / confidence language | **C** | `state/freshness.ts` (`cachedAsOfLabel`, age copy), `components/CurrentPictureBadge.tsx`, and forecast confidence bands from `mediaTimeBands` (a forecast without one is omitted, MD145). |
| MD410 | Observed, inferred and predicted states use distinct visual treatments | **C** | `mediaTimeBands.ts:50-57` emits `TimeBandRenderClass = "observed" \| "typical" \| "predicted"` precisely so the client can key three treatments; `state/stateColors.ts` + `MediaTimeRail.tsx` consume it. |
| MD411 | Hidden Gems use distinct discovery/protection visual language | **C** | `src/lib/gems/gemStateDisplay.ts` + `components/media/GemsItemOverlay.tsx`; the ten §16 states each get their own label. |
| MD412 | Compass is a primary intelligence/action control | **W** | It is a primary control in the dark rail (`MediaActionRail.tsx`, `ask_compass` at `MediaActionResolver.ts:531#id: "ask_compass",`). On the shipped viewer the primary control is Stamp; Compass is not present on `WatchItemOverlay` at all. |
| MD413 | Creator identity is visible but secondary in world-first lenses | **C** | `lib/media/mediaProjection.ts:95` — the contributor field is commented *"visible but secondary in world-first lenses (§46)"*, and `:176-186` projects handle-first with presentation-name opt-in left to the social caller. The World lens groups by zone before contributor (`MediaProjectionService.ts:455`). |

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
| MD430 | Places owns canonical Place identity | **C** | `places` + the canonical bridge; `MediaActionResolver.ts:203` carries `places.id` opaquely and never re-derives identity from a name or coordinate. |
| MD431 | Hidden Gems owns gem identity and gem-specific state | **C** | `hidden_gems` + `lib/hiddenGemState.ts:13-18`, which derives state at read time so it cannot drift from the owner. |
| MD432 | Trips owns Trip context | **C** | Media reads `trips`/`trip_members` and never writes them; `MediaActionResolver.ts:594#id: "add_to_trip"` hands "Add to Trip" to the trip endpoint under that endpoint's own gate. |
| MD433 | Events owns event identity and lifecycle | **C** | `MediaExperienceResolver.ts:1-14` reuses `routes/events.checkEventEligibility` rather than re-implementing event visibility. |
| MD434 | Live Intelligence owns current claims, evidence, confidence, freshness | **C** | `lib/liveClaimRead` is the sole source of a current-state label for Media (`MediaProjectionService.ts:719#export async function readCurrentState(`); media freshness is typed so it cannot claim `live` (`mediaFreshness.ts:21`). |
| MD435 | Discovery owns opportunity ranking | **W** | `services/ranking/DiscoveryRankingService.ts` exists, and Media has its **own** ranker (`MediaFeedRankingService.ts`) with its own boost flags — the ownership line is crossed in the direction §48 forbids. |
| MD436 | Compass owns recommendation and decision support | **C** | `compass/CompassMediaContext.ts:1-14` — *"It does NOT fork the Compass engine; the engine stays propose-only."* Media supplies context and reads nothing back as truth. |
| MD437 | Map owns geographic projection | **C** | `MediaProjectionService.ts:924-932` — the media map carries **no geometry** and omits any cluster it cannot bind to a canonical place (`:952-955`). The strongest ownership boundary in the census. |
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
| MD449 | Phase 9 — My World + Memory: Grid/Timeline/Map, experience grouping, Memories/Postcards | **W** | Grid, Timeline, grouping and Memories/Postcards delivered (`MyWorldMemoryService.ts:47-53`, `MediaProjectionService.ts:759-763`); Map is a placeholder (`MyWorldMediaScreen.tsx:95-99`). |
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
plus a second clause naming line 1155 (line 1119 when that paragraph was written) of `services/wall/WallCandidateLoaders.ts` as the place
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
`artifacts/api-server/src/services/wall/WallCandidateLoaders.ts:1156#const QUICK_MEDIA_BLOCKED_MODERATION`,
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
   crosses — `artifacts/api-server/src/lib/mediaEligibility.ts:369#if (hiddenPostIds.has(c.id)) return false;`
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
| WRITER | `POST /api/posts/:postId/hide` — `artifacts/api-server/src/routes/posts.ts:2648#router.post("/posts/:postId/hide"`, an idempotent upsert on the same conflict target §9 later duplicated |
| READER | the following feed — `artifacts/api-server/src/routes/posts.ts:1246#.from("post_hides")` |
| READER | the global feed — `artifacts/api-server/src/routes/posts.ts:1388#.from("post_hides")` |
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
the gate at `artifacts/api-server/src/lib/mediaEligibility.ts:369#if (hiddenPostIds.has(c.id)) return false;`
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
`artifacts/api-server/src/routes/posts.ts:2666#const hidden = await hidePostForViewer(sc, user.id, postId);`
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
`artifacts/api-server/src/routes/posts.ts:882#sourceType: 'post',` hands the new
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
(`artifacts/api-server/src/routes/mediaFeed.ts:2226#router.post("/media/:id/like", asyncHandler(async (req, res) => {`)
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
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:543#export async function loadPlaceNeighborhoods(`
   batches one `places` read over the page's distinct `canonical_place_id`s —
   the same column `buildPlaceProjection` already reads for a place header, so
   Media does not open a second neighborhood source (§48: Places owns place
   identity) — and
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:683#const [ctx, neighborhoods] = await Promise.all([`
   runs it alongside the gem context. The label is handed to the choke point as
   an **input**, never written onto the projection, so `coarsenMediaLocation`
   still decides: a gem-ceilinged or privacy-coarsened item names no
   neighborhood. The gem lookup beside it stays fail-CLOSED while this one is
   fail-SOFT, and the asymmetry is argued in the function's own header rather
   than left to look like an oversight — losing the gem context would WIDEN
   disclosure, losing this one only removes a label.
2. **The §30 Tagged bucket reads the table that was there all along.**
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:1419#export async function loadTaggedPostIds(`
   reads `tags` for `status='approved'`, `source_type='post'`, and
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:1472#export async function loadTaggedMedia(`
   puts those ids through `loadEligibleCandidates` and
   `projectCandidatesProtected` — **being tagged is not consent to see the
   post**, so the blocks / mutes / suspension / visibility / moderation gate,
   the private-account guard and the location choke point all still run. Bound
   stated rather than hidden: `feedType: "for_you"` means a tagged `trip_only`
   or `private` post is withheld rather than guessed at, because admitting it
   would need a membership proof this bucket does not hold.
3. **§44 Stamp and Save emit.**
   `artifacts/api-server/src/routes/mediaFeed.ts:2254#recordMediaEvent("like", {`
   and `artifacts/api-server/src/routes/mediaFeed.ts:2360#recordMediaEvent("save", {`
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
`artifacts/api-server/src/routes/mediaFeed.ts:2462#router.get("/media/:id/comments", asyncHandler(async (req, res) => {`
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
  `artifacts/api-server/src/routes/mediaActions.ts:429#.from("media_intent_signals")`
  is the DELETE, and
  `artifacts/api-server/src/services/media/MediaActionResolver.ts:965#.from("media_intent_signals")`
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
   repointed at `routes/mediaFeed.ts:2340#.from("post_saves")`. `check:doc-citations` found it,
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
(`` `artifacts/api-server/src/services/media/MediaExperienceResolver.ts:310#.from("trip_members")` ``).

**Why the two populations were not merely missing but unreachable.** The lens
loaded `feedType: "following"` alone, and that feed type's per-item visibility
gate refuses any author the viewer does not follow —
`` `artifacts/api-server/src/lib/mediaEligibility.ts:395#if (authorId !== viewerCtx.viewerUserId && !viewerCtx.followedCreatorIds.has(authorId)) {` ``.
A Trip Crew member was therefore structurally absent from this lens no matter
what they posted. Meanwhile the client's own copy named both populations to the
user — *"Perspectives from people you follow, your Trip Crew, and Shared Moments
will appear here"*
(`` `travel-buddy-standalone/src/features/media/screens/MediaPeopleScreen.tsx:45#message="Perspectives from people you follow, your Trip Crew, and Shared Moments will appear here."` ``)
— so the lens was advertising two populations the server could not supply.

**Built.** `` `artifacts/api-server/src/services/media/MediaProjectionService.ts:1004#export async function loadPeopleAffinities(` ``
resolves both populations in two hops each, where the FIRST hop is the viewer's
own accepted membership — an invitation the viewer never accepted yields nobody,
and an invitation somebody else never accepted does not make them crew. The lens
then runs TWO lanes
(`` `artifacts/api-server/src/services/media/MediaProjectionService.ts:1125#export async function buildPeopleProjection(` ``):
the follow lane unchanged, and an affinity lane that is `feedType: "for_you"`
NARROWED to the crew and Shared Moment ids by a new composing filter
(`` `artifacts/api-server/src/services/media/MediaProjectionService.ts:297#if (filter.authorIds && filter.authorIds.length > 0) {` ``).

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
(`` `artifacts/api-server/src/services/media/MediaProjectionService.ts:869#function partyTokensByPostId(` ``)
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
`census-telegraph.md` cites the same file twice at `:978`, now `:1164`, and both
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

## 13. MD227's C was awarded against a fixture, and the column it read does not exist

| | |
|---|---|
| **Measured at** | `32f07232f` — the tip of `claude/sweet-fermat-fmx7up` when this pass started. The document's `head_commit` row (§0) is **not** moved: this section re-reads ONE function, not 450 rows. |
| **Found by** | `check:write-path-columns` on the `api-server · check:all + live_pulse gate` job of PR #483, which runs with credentials against the sanctioned CI project and is therefore the only check in this repository that compares a select list against a live `information_schema`. Not by a test, and not by reading the code. |

### 13.1 What was wrong

§11.3.2 moved **MD227** W → C on the sentence *"The Tagged bucket reads `tags`"*, and
§12 restated it as *"the §30 Tagged bucket reads the table that was there all
along."* Both sentences are true about the TABLE and false about the read.
`artifacts/api-server/src/services/media/MediaProjectionService.ts:1419#export async function loadTaggedPostIds(`
selected and ordered by `tags.tagged_at`. **There is no such column.** The
canonical `0043_tags_hashtags.sql` declares it and it was never applied —
`migrations/README.md` line 12 says so in as many words, and `docs/migrations.md`
line 26 records it in the schema-audit allowlist for exactly that reason. Live
`tags` carries `created_at`.

PostgREST rejects an unknown column with 42703 and fails the WHOLE statement,
and supabase-js RESOLVES that rejection rather than throwing. So the read landed
in the function's own `if (error)` branch and returned `[]` with a warn line.
**The Tagged bucket was empty for every viewer, on every request, since the row
was moved to C** — and it was empty in the one way nothing above it could
detect, because "you have no tags" is the documented degradation and looks
identical.

### 13.2 Why four tests over this function did not notice

`src/test/mediaProjectionGaps.test.ts` covers `loadTaggedPostIds` four times and
all four passed, because every fixture row carried a `tagged_at` key. The
fixtures had been written to match the code, so the tests proved the code
matched the fixture and proved nothing about the database. This is the same
failure shape `src/test/helpers/schemaStrictSupabase.ts` was built for after the
Memory/Compass lane shipped five of them, and the helper existed in this tree the
whole time — the media lane simply did not reach for it.

### 13.3 What now backs the row

`artifacts/api-server/src/test/mediaTaggedBucketLiveSchema.test.ts:60#describe("§30 Tagged bucket — every column it names is a column the live tags table has", () => {`
drives the production function through `makeSchemaStrictClient`, which validates
every column named in a select list or a filter against
`generated/liveColumns.json` — the live `information_schema` — and answers 42703
exactly as production does. Watched RED first: **3 of 3 failed** before the
repair, each reporting `column tags.tagged_at does not exist`; **3 of 3 pass**
after. The four `tagged_at` fixture keys in `mediaProjectionGaps.test.ts` were
replaced with `created_at` in the same commit, so no fixture in this tree
re-plants the dead column.

### 13.4 No verdict moves, and that is the uncomfortable part

**MD227 stays C**, so no percentage in this document changes and none is
restated. That is not a clean outcome: the row was C for the whole interval
between §11.3.2 and this section while the feature it grades returned nothing,
and the census had no way to say so because a verdict records a judgement, not
the date the judgement stopped being true. The honest summary is that
**CORRECT% was overstated by one row for that interval** and the correction is
visible only here, in prose, rather than in the count.

### 13.5 What would have caught it sooner, and what still would not

Only `check:write-path-columns`, and only in a job with live credentials — which
is why this was found by CI on a pull request and not by the 20,000-test local
suite, `run-all-checks.sh`, or any reviewer reading the diff. The general lesson
is narrow and worth stating plainly: **in this repository a column name is not
checkable by reading code, tests, or migrations.** The canonical migration chain
asserted this column exists; it was wrong, and it had been wrong in writing since
the file was authored. `check:missing-live-columns` reads migrations against the
live schema from the other direction and passed on this same run, because
`tags.tagged_at` is in ITS allowlist — the allowlist entry recorded the drift and
then silenced the only other check that could have named it.

---

## 14. The Media lane pass — ten rows closed, and a falsifier for every row left open

This section is the record of the 2026-09-14 Media lane pass. It did three
things: it built and certified ten requirements, it re-graded eight more in the
direction the evidence pointed, and it attached a concrete falsifier — *what
would turn this red* — to every one of the 153 requirements still not C. The
third is the part that makes the other two auditable: a census whose open rows
have no stated falsifier is a list of complaints.

### 14.1 What was built, and the mutation that proved each test

Every test below was written FIRST, run, and seen to fail for the right reason
before any implementation existed. Every implementation was then mutated and the
test seen to go red. The mutations are listed per row above; the summary:

| Rows | What was built | Files |
| --- | --- | --- |
| MD149 · MD150 · MD151 · MD152 | §18 Corroboration → Contradiction → Visual Consensus, served on `PlaceProjection` and every `WorldZone`, with the §18 "Mixed reports" copy | `artifacts/api-server/src/services/media/MediaConsensusService.ts` (new), `MediaProjectionService.ts`, `MediaPerspectiveService.ts` |
| MD349 · MD367 | §38 media search + `GET /media/search`, over the SHARED candidate loader and coarse projector | `artifacts/api-server/src/services/media/MediaSearchService.ts` (new), `routes/mediaWorld.ts` |
| MD51 · MD100 | §28 Shared Moment in the media context graph, and §15 Invite People behind the invite endpoint's own gate | `artifacts/api-server/src/services/media/MediaActionResolver.ts` |
| MD171 · MD172 | §23.1 experience chains ordered by observed capture time, and Follow This Night | `artifacts/api-server/src/services/media/MediaExperienceResolver.ts`, `MediaActionResolver.ts` |

Twenty-nine mutations were run across the four clusters. **Two of them did not
redden the suite on the first attempt, and that is reported rather than quietly
fixed**, because a mutation that fails to redden is the census's own warning
that a test is weaker than its name:

1. **Dropping `mayDiscloseGemIdentity` from the search left every test green.**
   The "a PROTECTED hidden gem yields no gem result" case was passing for a
   different reason than its name claimed: a protected gem makes the LOCATION
   choke point withhold the place id upstream, so the gem lookup was never
   handed a place to look under and the predicate was unreached. A second case
   was added — an `archived` but `public` gem, which is not restrictive (so the
   place stays disclosable) and is not identity-disclosable (so the predicate
   must refuse it). The mutation now reddens. The original case was kept, and
   relabelled to say what it actually proves.
2. **Two chain mutations did not redden**: keying a stop on its LAST perspective
   instead of its first, and admitting a place the disclosure choke point had
   withheld. The first fixture happened to have no stop that was revisited, so
   first and last ordered identically; the second produced an ANONYMOUS stop
   (`placeId: null`) rather than a named one, which the assertion did not look
   for. Both fixtures were rewritten — a Dinner → Rooftop → Dinner night where
   the two keys give opposite orders, and an assertion that every stop carries a
   real canonical place id. Both mutations now redden.

A third mutation (`sendProjection` → `res.json` on the new search route) did not
redden the search suite and DID redden `mediaWorldBoundaryScrub.test.ts`, which
is the file that owns that guarantee. That one was a mis-aimed mutation, not a
weak test.

### 14.2 Rows found mis-graded or mis-cited

| Row | Finding |
| --- | --- |
| MD162 | **Mis-cited.** It cites `lib/mapProducers/crowdFlowProducer.ts`; no such file exists. The producer is `artifacts/api-server/src/lib/crowdFlowProducer.ts:265#export const CROWD_FLOW_FLAG = "map_crowd_flow_enabled";`, which is where MD163 correctly points. The verdict is unaffected — Media still does not consume it — but the row is one of the 18 citations §0 says name no file in the tree, and this is which file it should have named. |
| MD152 | **Partly overstated, in the direction that flatters the gap.** "No uncertainty state on `PlaceProjection` or `WorldZone`" was true at the OBJECT level and false at the field level: the per-claim `conflictState` was already riding inside `currentState.claims[]` / `liveClaims[]`, so a client that knew to look could already find it. What was genuinely absent was any place-level or zone-level state and any copy. The row is now C on both. |
| MD287–MD293 | **Re-graded N ×7 → W ×7.** See the row. |
| MD228 · MD294 · MD173 | **Re-graded N → W.** Each says in its own cell which part closed and which did not. |
| MD149 | **Re-graded W → C**, and the W was correct when written — `MediaContributorReputationService` really is contributor corroboration, not perspective corroboration. |
| Headline | **Already drifted before this pass.** The `## Headline` table at the top of the document still reads C 291 / W 69 / N 88 / X 2, which has not described the rows since §11.10; `check:census-integrity` reads the LAST restated headline (§12.10, C 287 / W 74 / N 87 / X 2) and that one did reconcile. The top table is left as the historical record it is, and §14.5 restates from the rows. |

### 14.3 Cross-lane requests

1. **`artifacts/api-server/src/compass/CompassMediaContext.ts`** — add
   `shared_moment: "shared moment"` to `REF_KIND_LABEL` (`:305`). MD51's edge is
   currently carried on a second union, `MediaGraphKind`, purely because that
   file builds `Record<MediaEntityRef["kind"], string>` and widening
   `MediaEntityKind` would not compile. With the label added, `MediaGraphKind`
   collapses back into `MediaEntityKind` and `ResolvedMediaEntities.graphRefs`
   back into `.refs`. This is a one-line change and a strictly better shape; it
   was not made because the file is not this lane's.
2. **`artifacts/api-server/package.json`** — no new test file was created, so no
   registration is needed. Stated because it was checked, not assumed: all new
   cases were added to four ALREADY-REGISTERED suites
   (`mediaIndependentSources.test.ts`, `mediaWorldProjection.test.ts`,
   `mediaActionsCompass.test.ts`, `mediaWorldBoundaryScrub.test.ts`).
3. **`services/ranking/**`** — sixteen of the open rows (§14.4 family F9) are
   about the ranker, and `services/ranking/MediaFeedRankingService.ts` is outside
   the Media lane's paths. Whichever lane owns it needs the family F9 falsifiers.
4. **Four ANCHORED citations in three other censuses were displaced by this
   pass's code and must be repointed by the lanes that own those documents.**
   This is the anchored-citation mechanism working exactly as §12.9 describes —
   the anchors caught their own decay, loudly, on the run that broke them — and
   the repoints are not made here because "any census other than your own" is off
   limits. Each has been re-located by exact original line text, not by offset,
   so the new number is verified rather than arithmetic:
   - `docs/architecture/census-highlights-memories.md:469` cites the My World
     "gems" bucket at line 1091 of MediaProjectionService; it is now at
     `artifacts/api-server/src/services/media/MediaProjectionService.ts:1378#key: "gems"`.
   - `docs/architecture/census-telegraph.md:346` and `docs/architecture/census-telegraph.md:1164`
     both cite the owner-scoped table read at line 1214; it is now at
     `artifacts/api-server/src/services/media/MediaProjectionService.ts:1502#.from(table)`.
   - `docs/architecture/census-trust.md:738` cites the viewer profile select at
     lines 108-112; it is now at
     `artifacts/api-server/src/services/media/MediaProjectionService.ts:110#.select("location_country")`.
   (The stale line numbers are given as plain numbers above, deliberately: written
   in citation shape they would be re-parsed as citations of THIS document and
   would fail `check:doc-citations` here instead of there.)
   The fifteen displaced anchors inside THIS census were repointed in the same
   pass, the same way. `check:doc-citations` was ALREADY failing before this pass,
   across many documents and for unrelated reasons — the largest cluster is
   `docs/discovery/ROADMAP.md` — so this pass did not break that check and cannot
   fix it. What it can account for is its own share: **twenty** anchored
   citations were displaced by this pass's code, **sixteen** of them live in this
   census and are repointed, and the four above do not and are not.

### 14.4 WHAT WOULD TURN THIS RED — the falsifier register

One entry per requirement still not C, grouped ONLY where the falsifier is
literally the same artifact. The rule for an entry: it names a thing that could
be built or measured, and says who can supply it. "More work" is not an entry.

**F1 — The compliant surface is built and dark.** `MEDIA_WORLD_SHELL_ENABLED` is
seeded `false` (`artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql:36-42`)
and the Media tab's default mode is `'watch'`. Every row here is "the §46-shaped
thing exists; the thing users reach is the other one".
*Settled by:* a migration seeding that flag `true` **and** a `mediaStore` default
that is not `'watch'` **and** a `docs/architecture/mobile-reachability-ledger.md`
entry showing the World shell reachable. *Who:* the integration owner — lanes may
not enable a feature flag (LANE-RULES §6) — plus the client lane for the default.
Rows: MD1, MD2, MD3, MD11, MD15, MD29, MD33, MD87, MD286, MD402, MD408, MD412, MD428.

**F2 — The forbidden thing is built and shipping.** These four are §46.2
prohibitions the tree VIOLATES, so nothing is missing; something is present.
*Settled by:* the full-screen paging autoplay feed no longer the seeded default
mode, and the Stamp/comment/save count rail no longer the primary overlay —
evidenced by the seed row and by `WatchItemOverlay`'s rail. *Who:* client lane +
integration owner. Rows: MD419, MD424, MD425, MD427.

**F3 — A named client module simply does not exist.** Each row names a file.
*Settled by:* that file existing under `travel-buddy-standalone/src/features/media/`,
reachable from a route, with a registered test. *Who:* the client lane; the Media
backend lane cannot supply any of them and says so rather than leaving them to
look like backend debt. Rows: MD21 (`HiddenGemsMediaScreen`), MD25 (`MediaMapScreen`),
MD26 (`MediaTimelineScreen`), MD27 (`MediaSearchScreen`), MD28 (`MediaContributionScreen`),
MD313 (`HiddenGemCard.tsx`), MD314 (`MediaContextSheet.tsx`), MD316 (`MediaContributionSheet.tsx`),
MD320 (`services/mediaProcessing.ts`), MD321 (`services/mediaPrivacy.ts`),
MD322 (`services/mediaContext.ts`), MD323 (`services/mediaIntelligence.ts`),
MD324 (`services/mediaSearch.ts` — now unblocked server-side, see its row),
MD325 (`services/mediaCache.ts`), MD329 (`state/mediaMapStore.ts`),
MD331 (`state/mediaFilterStore.ts`), MD332 (`state/myMediaStore.ts`),
MD35 and MD405 and MD449 (all three are the My World **Map** mode placeholder at
`MyWorldMediaScreen.tsx:95-99`, and all three fall together the moment that mode
renders the canonical Map projection the server already produces at
`MediaProjectionService.ts:1625#export async function buildMediaMapProjection(`), MD415 and MD416 (gem glow / map contour — the
DATA exists at `mediaLocationVisibility.ts:98`; no client draws it).

**F4 — Offline / degraded mode (§39) has no store.** Nothing in the media tree
persists CONTENT; `AsyncStorage` holds mode and toggles only.
*Settled by:* a client cache module that persists a scoped, curated set, with an
eviction policy, a trip/place scope, and a visible last-updated stamp that is
never rendered as live (§39's own closing sentence). *Who:* client lane.
Rows: MD295, MD296, MD297, MD298, MD299, MD300 (currently an HTTP image cache,
which is caching but not §39), MD301.

**F5 — The canonical asset store is dark and unread.** `lib/mediaAssets.ts:118`
returns `null` before writing whenever `media_canonical_enabled` is off, and it
is off; `attachCanonicalMedia` has no caller; `media_attachments` is empty in
both databases.
*Settled by:* (a) the flag enabled in a real environment, (b) a backfill so
`media_assets` covers live media rather than 8 rows, and (c) at least one READ
path calling `attachCanonicalMedia` — after which `canonical_media` stops being
absent on every row and `firstCanonicalMedia` stops returning null on every row.
*Who:* integration owner (flag + backfill); the read-path caller is Media lane
work that is pointless before (a) and (b). Rows: MD36, MD38, MD43, MD44, MD57,
MD60, MD338, MD339, MD343, MD429.
Three of the family need a MIGRATION as well, which LANE-RULES §2 forbids a lane
to author unasked: MD37 (drop the legacy `'user'` default from `0191:31` so every
write lands inside the §6 eight-value set), MD41 (a CHECK on
`media_attachments.entity_type` over the nine §5 values, plus writers for
`shared_moment` and `observation`), MD255 (a `visibility` CHECK admitting the six
§33 audiences — today the column is bare `TEXT DEFAULT 'inherit'` and the post
enum has three values), MD274 (flip the DEFAULT to a §36 value and migrate the
legacy rows, which `2250` deliberately did not do).

**F6 — The media → intelligence boundary is a refusal, not a gap.** These rows
are W/N because a seam was built and deliberately left unwired.
| Row | What would settle it |
| --- | --- |
| MD53 | `media_evidence_enabled` on **and** an observation ref carried on a media projection. Today the link table exists behind the flag (`lib/media/mediaEvidenceLink.ts:130`) and no projection carries the ref. |
| MD63 | Any pixel/frame/scene analysis at all. `mediaEvidenceEligibility` classifies from DECLARED source and edit list; there is no decode step anywhere, and for video there is no decoder (F11). A stage that does not exist cannot be partly built. |
| MD65 · MD66 | A media path that writes `intel_observations` / `intel_claims`. `mediaEvidenceLink.ts:1-13` states it never does. Settling this is a SAFETY decision before it is a code change, and should be recorded as one. |
| MD58 | Corroboration, observation refs and expiration on a media projection. Corroboration is now half-answered — §18's consensus (MD149) puts an agreement measure on the place, but `MediaProjection` itself still carries none, and observation refs and expiry are still absent. |
| MD71 | Either `freshnessClass` gaining `'live'` (which `mediaFreshness.ts:21` types out on purpose and which this census judges SAFER than the spec), or the spec conceding the cap. This row cannot be closed by code alone; it needs a spec decision. |
| MD73 | A `locationConfidence` scalar distinguishing a GPS-verified capture from a hand-typed venue. The inputs exist (`mediaAssets.ts:105` has a boolean `hasLocation`; EXIF is stripped server-side) — what is missing is a captured provenance bit saying WHICH, recorded at upload. |
| MD75 · MD78 | An `expiresAt` on an asset's intelligence eligibility. `mediaEvidenceEligibility.ts:29-31` declines it by design, with a reason. Settled by the spec conceding, or by a migration adding the column and a writer. |
| MD76 · MD77 | A `MediaTemporalState` contract and a `socialExpiresAt` column. Neither exists under any name; a grep for the type returns nothing in either tree. |
| MD79 | A path from "shown" back to "hidden". `delayedPostPublisher` only ever begins disclosure. Settled by a scheduled re-hide, or by the spec accepting one-way disclosure. |
| MD445 | MD65 closing. Its first half (qualification) is delivered. |

**F7 — Perspective vantages (§12).** `MediaPerspectiveService.ts:8-12` declines
to invent a vantage the data does not support, and buckets from `category`.
*Settled by:* a perspective/vantage value CAPTURED at contribution time (a
column, or a composer affordance that asks), not a classifier guessing from a
photo — the service's refusal is correct until the data exists. *Who:* schema +
client capture. Rows: MD82, MD83, MD84, MD85, and MD444 (three of its four parts
are delivered; the vantages are the fourth).

**F8 — Entry contexts (§14).** `setPerspectiveViewerContext` has exactly one
caller passing exactly one kind. *Settled by:* a second producer for each kind —
an Event surface, a People surface, a Trip surface, and a Media Map (MD25) —
each passing its own entry-context kind. Rows: MD89, MD90, MD91, MD92.

**F9 — Ranking (§24).** `services/ranking/**` is outside this lane's paths; see
§14.3.
| Row | What would settle it |
| --- | --- |
| MD8 | A provenance term in the ordering: `source_type` reaching the ranker/projection and `generated`/`derivative` ordering below `camera`/`official`. Today no ordering reads provenance, and the World-shell sort is `capturedAt` only. This is an UNGUARDED ABSENCE, so it can also be settled by a guard + test proving generated media cannot outrank authentic — which is cheaper than the feature and is the honest minimum. |
| MD177 | A viewer-intent input on `RankCandidate`/`ViewerContext`. `media_intent_signals` is written (§15.1) and read only by the action rail for its own button state (`artifacts/api-server/src/services/media/MediaActionResolver.ts:965#.from("media_intent_signals")`); the store exists and is not a ranking input. |
| MD179 | A viewer-trip affinity term in `DEFAULT_WEIGHTS`. `kindPrior` has a `trip` CANDIDATE kind, which is a different thing. |
| MD184 · MD201 | A live-claim term in either ranker, and a penalty on low-confidence ones. MD201 is unguarded: a live term could be added tomorrow with no penalty and nothing would object. |
| MD187 | A quality term that is not an engagement proxy — resolution, sharpness, duration fit, composition. Today quality IS `watchCompletionRate` / `qualifiedViewCount` / `rewatchRate`, which is the thing §45 forbids optimising for. |
| MD188 | A `source_type`/provenance term (with MD8). Author trust is not asset provenance. |
| MD194 | A predicted real-world action, not a per-candidate-kind constant. `actionability 0.9` is a genuine partial and is a property of the kind. |
| MD195 · MD196 · MD198 | An experience-fit term, a connection-usefulness term, a narrative-value term. None exists under any name. |
| MD197 | A call site for `MediaContributorReputationService` inside `services/ranking/`. **CORRECTED 2026-09-26 by §18:** "nothing reads it" was true when written and is now FALSE — `routes/mediaViewRequest.ts:26#import` reads `readContributorReputation`. The row still does not move, because the RED WHEN is a RANKING call site and there is still none under `services/ranking/`; what changed is that the scorer is no longer unread, only unranked. |
| MD207 | A fourth reputation dimension reading journey history. `computeContributorReputation` computes three. |
| MD348 · MD356 | A ranking stage between projection and client in the World-shell pipeline. `buildWorldProjection` sorts zones by item count and `buildTimelineProjection` by capture time; neither is a ranker. |
| MD435 | Media ceasing to own a second ranker, or §48 conceding it. The ownership line is crossed in the direction §48 forbids, and that is a design decision, not a bug. |

**F10 — Telemetry names with no emitter (§44/§45).** `mediaTelemetry.ts` declares
several transitions "reserved: no rail trigger yet"; `mediaAnalyticsBatch.ts:41`
allow-lists some names that nothing sends.
*Settled by,* per row: a PRODUCER that emits the event, plus a test that fails
without it. The allow-list is this lane's file; the emitters are the client's.
| Row | Producer that would settle it |
| --- | --- |
| MD213 · MD378 · MD396 | A directions tap on a §15 surface emitting `media_route`. `directions_tap` exists on the legacy gems surface only, and there is no Directions action to tap (MD94). |
| MD214 · MD399 | An arrival detector on a media path. None exists; the geofence machinery is trip-scoped. |
| MD374 | An event name for a Visual Opportunity open, plus the World shell's opportunity cards emitting it. |
| MD376 | A gem-open event name in the batch allow-list, plus an emitter. `gems_filter_change` is allow-listed; an open is not. |
| MD381 | An invite event. **The action now exists (MD100)**, so this row's stated blocker — "no invite action" — is gone; what remains is the event name and the emitter. |
| MD382 | An experience-completion detector. `completion` in the allow-list is VIDEO completion, the opposite signal. |
| MD383 · MD400 | A contribution surface (MD28) emitting `media_contribution`. |
| MD385 | A creation event on the Memory/Postcard path. `MyWorldMemoryService` is read-only by design, so this needs the writer side. |
| MD387 · MD393 | A server touchpoint for comment-create and profile-open on a media surface. Both are client navigations today. |
| MD209 | Producers for `save` and `place_open`. Neither exists in either tree. |
| MD215 | The counts ceasing to dominate — see F2. |

**F11 — The video tier has no decoder.** `lib/mediaProcessing.ts:18-19` states
that videos are sniffed and size-capped, never transcoded, because there is no
ffmpeg in this tier.
*Settled by:* a processing tier that can decode — which is an infrastructure
decision with a cost, not a code change, and should be recorded as such.
| Row | What would settle it |
| --- | --- |
| MD275 | A writer filling `media_assets.thumbnail_path` for video. The column exists. |
| MD276 | A server-side probe of the container. Duration is whatever the uploader declared. |
| MD277 | An HLS/DASH manifest. `WatchVideoCell.tsx:158` plays one progressive URL. |
| MD280 | A caption/subtitle track on the asset and a `textTrack` on the player. |
| MD281 · MD284 | A chunked/resumable upload with a resume token, and a background task registration. `uploadMedia` is a single foreground `fetch`. |
| MD282 | Transcoding. Images are already re-encoded and capped; video is not. |
| MD283 | MD282 plus F12 — video is never decoded, so no classifier could run on it even if one existed. |

**F12 — Moderation decides nothing.** Rows MD269, MD351.
*Settled by:* a classifier with a hold state and a queue that a decision can come
out of — today the postcard transport promotes to approved unconditionally and
what exists is an admin route, an audit writer, an inert table and the
distribution gate. *Who:* needs a moderation-provider decision first.

**F13 — Actions and Compass, the parts still open.**
| Row | What would settle it |
| --- | --- |
| MD94 | A `directions` action. It needs a canonical directions endpoint to target; there is none, and the rail's rule is that every action resolves to an EXISTING endpoint, so inventing one here would be the wrong fix. "Go There"/"Show on Map" are built. |
| MD101 · MD253 | The third comparator. `CompassMediaContext.ts:81#export const COMPARATOR_AXIS_CLAIM` now maps *quieter* and *cheaper*; *busier* and *find similar to this specific thing* are not mapped. Compass lane. |
| MD103 | A `passport` member in the entity graph. §29 keeps Passport on Postcards, so this is a SPEC boundary question before it is a build: settled either by §29 conceding, or by a passport ref with its own eligibility gate. |
| MD104 | A Telegraph thread/message/intent actually created when `target = "telegraph"`. `routes/mediaFeed.ts:2297-2299` records a share event and returns a URL on every branch. This is Media-lane code and a Telegraph-lane contract; it was not built here because inventing the thread shape unilaterally is how two lanes end up with two share paths. |
| MD107 | A compilation into a **Compass** plan from a Trail / recap / itinerary source. Today "Do This Experience" adds items to a TRIP, which is a smaller, different thing that works. |
| MD173 | See its row — a client call site, or a server-side place-id resolution in `POST /route-plans`. |
| MD175 | A remix concept anywhere. There is none, and building one from nothing is a product decision, not a census repair. |
| MD252 | The re-read this census still owes. `CompassMediaContext.ts:225#export function buildSequencingAnchor` exists and the row's stated absence is false; the verdict was deliberately left at N by the correcting lane and **is still owed a re-read**. This pass did not perform it either, because the file is the Compass lane's and the row turns on that lane's build. Recorded again rather than silently inherited. |

**F14 — Hidden Gems (§16).**
| Row | What would settle it |
| --- | --- |
| MD112 | Duplicate detection running at SUBMISSION, not only in the admin queue. The scorer is real and the placement is the gap. |
| MD120 | A gem outcome record — a table or a claim linking a visit back to the gem. `compass_outcome_events` is Compass's and carries no gem semantics. |
| MD360 | `GET /media/gems` serving a §16 gem-STATE projection. The lens falls back to `GET /media/gems-feed`, a ranked social feed. This is squarely in this lane's paths and was NOT built this pass — the four clusters above were chosen instead, and that is a prioritisation, not a blocker. It is the cheapest remaining row in the census for this lane. |

**F15 — Everything else, one at a time.**
| Row | What would settle it |
| --- | --- |
| MD162 | Media consuming the canonical crowd flow. The producer is `lib/crowdFlowProducer.ts` (NOT the path this row cites — see §14.2), and `deriveCrowdFlow` has no production caller anywhere, so Media would be its first consumer. Note the producer currently reports two wired signal families and refuses to publish below `MIN_SIGNAL_FAMILIES` for most buckets, so a Media consumer would correctly render nothing today — settled by the consumer PLUS evidence that a flow can actually be produced. Media perspectives cannot themselves become a family: a photograph declares no ORIGIN zone, which is `UNFED_FAMILY_BLOCKERS`' `no_declared_origin`, the blocker no amount of wiring removes. |
| MD169 | An experience-level `confidence` computation. The field is declared and unfilled; the only confidence on the media path is the per-forecast band in `mediaTimeBands`. |
| MD222 | **Partly closed by MD51** — the Shared Moment is now IN the media context graph and addressable from the rail. Still open: the People lens (MD216) does not carry shared-moment participants as a population. Settled by `buildPeopleProjection` emitting the `shared_moment` relation it already types. |
| MD228 · MD294 · MD287–MD293 | See their rows. |
| MD369 | A `POST /media/:id/attachments` route. Attachments are written only from inside `PassportMemoryService` and `HiddenGemService`. This lane's path; not built this pass, and pointless before F5 (the write is a no-op under the seeded-off flag). |
| MD370 | A contribution endpoint distinct from the §15.1 intent signal. Gem contributions go to `routes/hiddenGems.ts`. Blocked with MD28 on there being a contribution surface to serve. |
| MD403 (X) | A measured contrast ratio and a dynamic-type pass on a device. This census agrees it is genuine runtime QA — it is the ONE §46 item where it agrees. Settled by a QA artifact, not by reading the tree. |
| MD441 (X) | The Phase 0/1 media audit DOCUMENT. The WORK landed (`0191`, `2250` name their phase); `docs/media/` holds no audit. Settled by the audit artifact being committed, or by the programme recording that it was never written. |
| MD446 | "Show Me Now" existing under some name. Four of its six parts are delivered; "Go There" is MD94. |

### 14.5 Restated headline

> | Measure | Was, §12.10 | Now |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 287 | **297** |
> | BUILT-BUT-WRONG | 74 | **83** |
> | NOT-BUILT | 87 | **68** |
> | CANNOT-VERIFY | 2 | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | 80.2 % | **380 / 450 = 84.4 %** |
> | **CORRECT%** (raw) = C/450 | 63.8 % | **297 / 450 = 66.0 %** |
>
> Restated from `pnpm -s check:census-integrity`, not by hand. The moves are ten
> N/W → C (§14.1) and ten N → W (MD173, MD228, MD294, MD287–MD293). Construction
> moves this time, by 4.2 points, and it moves for the ordinary reason: nineteen
> requirements that had NOTHING now have something. The gap between the two
> figures is **18.4** points, up from 16.2 — which is the honest shape of a pass
> that opened more than it finished, and the register in §14.4 is where that
> extra distance is itemised rather than averaged away.

The **spec-attributable** figure (§0: 216 / 450) is restated ONCE and only
because the addition is checkable rather than estimated: all ten newly-C rows
were built in this pass against a named section of this spec (§15, §18, §23.1,
§28, §38), so attribution rises by exactly ten to **226 / 450 = 50.2 %**. No
pre-existing row's attribution was re-judged, and if that re-judgement ever
happens this number must be re-derived, not adjusted.

### 14.6 The least flattering true thing about this pass

**It closed the rows it could reach, and the rows it could reach are not the
rows that matter most.** The single largest fact about Media is unchanged and
untouched by anything above: the §46-compliant surface is behind a flag seeded
`false`, and the surface users reach is the full-screen autoplaying stranger-video
feed §46.2 forbids twice. Thirteen rows sit in family F1 and four more in F2, and
this pass moved none of them, because a lane may not enable a feature flag and
may not edit the client. Everything built here — the consensus object, the search,
the Shared Moment edge, the chains — is served by endpoints inside that same dark
shell. **They are correct, they are tested, and today nobody can see any of them.**

A second, smaller one: **MD360 was the cheapest row in this census for this lane
and it was not built.** `GET /media/gems` is one route in a file this lane owns,
over a projection service this lane owns, and it would have closed a row and
un-blocked two more (MD15, MD33). It lost to four clusters that each closed more.
That is a defensible prioritisation and it is still a row that should have been
easier to finish than to explain.

## 15. The Hidden Gems lens, §23 confidence, and two rows that were open on evidence that had already expired

This section is the record of the 2026-09-15 Media lane pass. It closed **four**
requirements — two by building, two by performing re-reads this census had
already written down that it owed — and it leaves the document **STALE rather
than acknowledged**, which is §15.5 and is the least comfortable thing here.

Four is a small number and it is said plainly rather than padded. §14.4's
falsifier register is why: it sorts the 151 open rows into fifteen families, and
**eleven of the fifteen are settled by something this lane may not do** — enable a
feature flag, write a migration, edit the client, decode a video, or choose a
moderation provider. What was left inside this lane's reach was F14's MD360,
F15's MD169, and the two rows whose stated absence had already been falsified by
somebody else's build.

### 15.1 What was built

| Row | Was | Now | What was built |
| --- | --- | --- | --- |
| MD360 | **N** | **C** | `GET /media/gems` — the §16 Hidden Gems lens, registered as the NINTH endpoint of the §43 router at `artifacts/api-server/src/routes/mediaWorld.ts:420#sendProjection(res,` over `artifacts/api-server/src/services/media/MediaGemStateService.ts:330#buildGemStateProjection(`. |
| MD169 | **W** | **C** | §23 `confidence` on `MediaExperienceProjection`, at `artifacts/api-server/src/services/media/MediaExperienceResolver.ts:473#buildExperienceConfidence(`, served on the event branch, the trip branch and the "not available to you" shape. |

**MD360 — the lens is not a second feed, and that is the whole requirement.**
The row said the gems lens "falls back to `GET /media/gems-feed` … a ranked
social feed, not a §16 gem-state projection". §14.6 called it the cheapest row in
the census and did not build it. What makes it more than a route is that
`gems-feed`'s ordering comes from `HiddenGemDiscoveryService`, which weights
saves and visits — and §16.2 forbids that in its own words (*"No popularity-first
ranking"*, *"Suppress aggressive recommendations if a small place is being
overloaded"*). So the lens serves the ten-state `HiddenGemState` **derived at read
time**, a bounded confidence in which `save_count` is accepted and ignored, and an
ordering from `rankGems` — reusing `lib/hiddenGemState`'s pure policy layer
verbatim rather than writing a third scorer. A gem is NAMED only when
`mayDiscloseGemIdentity` allows it, the same predicate `MediaSearchService` uses;
undisclosable gems are dropped WHOLE, so no id, name or place of theirs appears
anywhere in the payload. **No coordinate column is selected at all**, so the lens
cannot disclose a point it never loaded.

**MD360's honest debt, stated in the code as well as here.** The service gathers
its own observation aggregates instead of calling
`HiddenGemContributionService.batchDeriveGemProjections`, which computes the same
two values. The reason is not taste: that module's aggregate reader logs a
warning and returns an empty aggregate on failure, so a caller cannot tell an
unreadable `hidden_gem_contributions` from a gem with no observations — and the
difference is not cosmetic, because `closed` / `access_changed` / `too_crowded`
are exactly the observations that move a gem to `temporarily_unavailable`. Losing
that read serves a gem the community has reported CLOSED as though it were fine.
Teaching that reader to report determinedness would move
`HiddenGemContributionService.ts` line 186 — a line MD130–MD138 cites by number
here and which census-sensing, census-discovery and census-trust also cite — and
three of those four documents are not this lane's to repoint. So the POLICY is
reused and the GATHERING is duplicated, the duplication is written into the
file's own header as a known gap, and the right end state (one exported gatherer
that reports determinedness, living in the file that already has the reader) is
named there.

**MD169 — the field is filled from two engines that already existed.** The row
graded it *"a declared-but-unfilled field"*. Confidence is defined once in this
tree, in `lib/confidenceScore`, whose header states the formula is the
specification's and that the module *"never invents"* one; and §18's
`buildVisualConsensus` already turns a set of perspectives into an
**independent-source** count with `lib/intelIndependence`'s clustering applied and
reads the canonical conflict engine's state off the gated live claims. So
`buildExperienceConfidence` is an assembler over both, not a third scorer.

The design decision worth recording is that **presence is counted in witnesses,
not in files**. MediaPerspectiveService's header is explicit that *"a photograph
ASSERTS NO VALUE"*; a presence term keyed on the raw perspective count would let
one loud account out-score two witnesses, which is popularity wearing an evidence
label. And the two components media structurally cannot supply —
`sourceReliability` and `evidenceQuality`, both asset-provenance questions that
family **F5** records as dark — are listed in `absentComponents` on every result
rather than left as an invisible zero, because a zero nobody can see is how a
structural absence becomes an apparently-measured low score.

### 15.2 The mutation results, in full, including the one that survived

Both tests were written FIRST and seen to fail for the right reason. Nineteen
mutations were run. **Eighteen reddened on the first attempt; one survived and is
reported rather than quietly fixed.**

`src/test/mediaGemStateLens.test.ts` (9 cases) against `MediaGemStateService.ts`:

| # | Mutation | Result |
| --- | --- | --- |
| M1 | remove the ranking entirely (serve input order) | RED — the §16.2 popularity and overcrowding cases |
| M2 | order by `save_count` descending (popularity-first) | RED — both §16.2 cases |
| M3 | drop the `mayDiscloseGemIdentity` filter | RED — the disclosure and owner-bypass cases |
| M4 | pass `null` as the viewer (drop the owner bypass) | RED — owner bypass |
| M5 | an unreadable `hidden_gems` reads as an empty city | RED — `determined:false` |
| M6 | an unreadable aggregate reports `determined:true` | RED — the undetermined-state case |
| M7 | serve the stored `status` instead of the derived state | RED — the derived-state case |
| M8 | copy a coordinate onto a lens item | RED — proves the no-coordinates assertion is not vacuous |

`src/test/mediaExperienceConfidence.test.ts` (8 cases) against
`buildExperienceConfidence`:

| # | Mutation | Result |
| --- | --- | --- |
| M1 | presence counts FILES (`fresh / 5`) instead of witnesses | RED |
| M2 | stale perspectives corroborate (drop the fresh-window filter) | RED |
| M3 | a material conflict carries no penalty | RED |
| M4 | ANY conflict is treated as material | RED |
| M5 | withheld places still score specificity | RED |
| M6 | `absentComponents` reported empty | RED |
| M7 | an empty experience floors at presence 0.5 | RED |
| M8 | `independence = sources / SAT` instead of `(sources − 1) / (SAT − 1)` | **SURVIVED**, then killed |

**M8 is the one worth reading.** It hands a lone account a positive independence
term, and the suite stayed green because the case that was supposed to catch it —
"eight photographs from one account do not out-score two from two accounts" —
compares two scores, and two witnesses still beat one loud account either way.
What M8 actually changes is the FLOOR, not the ordering. A case was added that
pins the floor directly (`components.independence === 0` for a single source),
the mutation now reddens, and the older case was kept because the ordering
property is also worth holding. A mutation that fails to redden is this census's
own warning that a test is weaker than its name, and this one was.

Two existing guards were also touched, both deliberately:
`src/test/mediaWorldBoundaryScrub.test.ts` asserts a route COUNT for the §43
router, and its own comment says that count is *"part of the guard, not
bookkeeping: a NEW endpoint added to this router has to come here and be looked
at"*. It went red on the gems route, exactly as designed; it was raised from 8 to
9 and now additionally asserts that `/media/gems` is one of them.

### 15.3 Two rows that were open on expired evidence

Neither of these cost a line of product code. Both are cases where the census was
holding a row open on a sentence that had stopped being true, and §14.4 names one
of them as a debt in so many words.

| Row | Was | Now | The re-read |
| --- | --- | --- | --- |
| MD222 | **W** | **C** | §14.4's F15 entry says the remaining half is *"the People lens (MD216) does not carry shared-moment participants as a population. Settled by `buildPeopleProjection` emitting the `shared_moment` relation it already types."* **That falsifier was already satisfied when it was written.** §12.2 had moved MD216 `W → C` in the same squash, and the lens emits the relation at `artifacts/api-server/src/services/media/MediaProjectionService.ts:1167#affinities.sharedMomentIds.has(cid))`, fed by a viewer-scoped two-hop read of `shared_moment_memberships`. It is TESTED: `src/test/mediaPeopleLensPopulations.test.ts` "a Shared Moment participant the viewer does NOT follow reaches the lens" and "orders the populations as §27 names them". Mutations red: deleting the `shared_moment` branch from `relationOf`; un-scoping the membership read from the viewer. With MD51's graph edge (closed §14.1) and this, both halves of MD222 are delivered. |
| MD252 | **N** | **C** | **THE RE-READ THIS CENSUS HAS OWED TWICE IS PERFORMED HERE.** The row's stated absence — *"no sequencing concept in the media→Compass context"* — is false. `artifacts/api-server/src/compass/CompassMediaContext.ts:225#export function buildSequencingAnchor` carries the anchor place, the coarse city and a `chainable` flag that is FALSE when the location/gem choke point withheld the place; the block is rendered into the real Compass ask, and when there is no anchor the prompt says the question *cannot be answered* rather than choosing a plausible city. TESTED by `src/test/compassCensusClosure.test.ts` B5/B6/B8/B9. Mutations red: `chainable` forced true with no anchor; a withheld place leaking its city; the sequencing block dropped from the prompt. The row's second clause (*"no chain (MD171)"*) was closed by §14.1. **Its third clause is still literally true — there is no time-of-evening term anywhere** — but §32 does not name one; it names the QUESTION, and the question is answered from structured truth or refused in words. |

A note on why MD252 was re-read by this lane and not by the Compass lane: the
file is Compass's and the verdict is this census's. §14.4 declined it on the
first ground; the correcting lane at §9.5 declined it on the second. A row that
two passes decline for opposite reasons stays open forever, so this pass read the
file, ran the mutations against the Compass lane's own suite, and moved the
letter — **without editing one character of a file this lane does not own.**

### 15.4 Falsifier register — corrections and what stays open

Corrections to §14.4, which remains otherwise in force:

1. **F15/MD222's entry was stale on the day it was written.** See §15.3. The
   remaining-open sentence named a build that already existed and was already
   graded `C` elsewhere in this document.
2. **F13/MD252's entry is now spent** — the re-read it asks for is §15.3.
3. **F14/MD360's entry is spent.** MD15 and MD33 are the two rows it said this
   would unblock; **both remain `W` and neither moved.** The blocker was never
   only the endpoint: MD15's own cell says `MediaWorldShell.tsx` imports the
   pre-existing `GemsFeed`, and MD33's says the mode bar is drawn over a
   component that ignores it. Those are client changes in a tree this lane does
   not own, and the server half existing does not close them. Saying so is the
   point of the register.

Three rows this lane could reach and did NOT close, each with the exact blocker
rather than a note that more work is needed:

| Row | Why it did not move |
| --- | --- |
| MD8 | The falsifier offers a cheaper settlement than the feature — *"a guard + test proving generated media cannot outrank authentic"*. It was not built, and the reason is measurable: provenance is `media_assets.source_type`, and the canonical store is family **F5** — `canonical_media` is absent on every projected row, because no SELECT in this tree produces it. A guard can be written and tested against a synthetic row, but its ordering term would read `null` on every real one, so it would be a guard over a column the projection cannot see. That is worth doing WITH F5 and misleading before it. Additionally, the row's own citation is stale: it says the World-shell ordering is at `MediaProjectionService.ts` lines 846-848; the `capturedAt` sorts are now at lines 1086 and 1452 and the World-shell zone sort is by item count. |
| MD228 | Settled by *"a `q` parameter on `GET /media/me`"*, and the row records that this was deliberately not built because *"duplicating the matcher in a second endpoint is how the two drift apart"*. Delegation rather than duplication would answer that, but the matcher (`haystack` + `captionsById`) is module-private to `MediaSearchService`, which imports FROM `MediaProjectionService` — so exporting it and calling it from the My World builder makes an import cycle, and the honest fix is to lift it into `lib/media/`. That is a two-file refactor across files carrying eleven anchored citations between them, and it was judged too large to do well in the remainder of this pass. The blocker is scope, and it is named as scope rather than dressed as a dependency. |
| MD369 | `POST /media/:id/attachments` is one route in this lane's own file, and §14.4 already records why it is pointless: `lib/mediaAssets.ts` returns `null` before writing whenever `media_canonical_enabled` is off, and it is off. The endpoint would accept a request, write nothing, and report success. Unchanged: blocked on F5(a), which is the integration owner's. |

### 15.5 THIS CENSUS IS LEFT STALE, AND AN ACKNOWLEDGEMENT WOULD HAVE BEEN FALSE

`check:census-freshness` reports `census-media.md` STALE after this pass, exit
code **1**, naming exactly six counted files —
`services/media/MediaGemStateService.ts` (new),
`services/media/MediaExperienceResolver.ts`, `routes/mediaWorld.ts` and the three
proof suites `src/test/mediaWorldBoundaryScrub.test.ts`,
`src/test/mediaGemStateLens.test.ts` and
`src/test/mediaExperienceConfidence.test.ts` — and
`src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` is NOT extended to cover them.
That is deliberate and it is the correct outcome of the rule, not a lapse:

- **An acknowledgement asserts the change cannot have moved a verdict.** Two
  verdicts moved *because of* these files — MD360 and MD169 — and §15.1 is the
  record of it. Writing an entry claiming otherwise would be false in the one
  sentence an acknowledgement consists of. The ledger's own opening line says an
  entry is for a counted file that changed *"WITHOUT the census being
  re-measured"*, and this is the opposite case.
- **`head_commit` cannot be re-declared here either.** The declaration must name
  a commit on `main`, verified with `git merge-base --is-ancestor`. This work is
  on `claude/media-lane-wave` and this repository squash-merges, so every commit
  on this branch becomes an orphan the moment it lands — which is precisely the
  failure the `1fe72289b` re-declaration at the top of this document exists to
  record.

**So the resolution belongs to the integrator, and it is one line:** re-declare
`head_commit` at the squash commit of this branch, exactly as was done for
`1fe72289b` at PR #482's squash. Until then the STALE reading is accurate — four
counted files have changed since `1fe72289b` — and a green check bought with a
false sentence would be worth less than a red one that is true.

### 15.6 Guard results, verbatim

| Check | Exit | Note |
| --- | --- | --- |
| `check:doc-citations` | 0 | RESULT clean. Every edit in this pass was made ZERO-SHIFT where an anchored citation sat below it: the gems route and the whole of §23 confidence are APPENDED at end-of-file with their imports beside them, and the two interface/return-site changes were merged onto existing lines. `"/media/search"` is still line 277 and `buildExperienceChain` is still on lines 266 and 330. |
| `check:census-integrity` | 0 | |
| `npx tsc --noEmit -p .` | 0 | |
| `check:census-freshness` | **1** | STALE. §15.5 is the reason and it is intentional. |
| `check:census-scope-coverage` | 0 | §15 cites a THIRD media proof suite by path, which dropped coverage to 95% against a 96% floor. Resolved the way the checker's own message says to — by WATCHING five of this census's own mutation-proof suites (`mediaIndependentSources`, `mediaActionsCompass`, `mediaPeopleLensPopulations`, and §15's own two) in `CENSUS_SCOPE`, named one by one rather than by scoping all of `src/test/`, which would age this document on every unrelated surface's test work. Coverage is 134/138 = 97%. **The floor was not lowered** — the checker says that is the one response never right, and it is right about that. |
| `check:census-row-move-labels` | 0 | |
| `check:test-registration` | 0 | Two new suites registered. |
| `check:media-objects` | **2** | CANNOT RUN — it needs live credentials and its production guard refuses an unset target. Exit 2 is "did not run", not "failed". No row in this census grades the ~1069 orphan `post-media` objects it reports when it does run, so that finding is not evidence for or against anything here. |
| `check:write-path-columns` | **2** | Same reason. |
| `check:citation-targets` | 0 | 247 unanchored citations land on nothing, against a ceiling of 248. The ratchet was **not** lowered: this is a shared file, several lanes are working concurrently against this base, and the one-citation gain could not be attributed to this lane's edits. Lowering a shared ratchet on an unattributed gain would fail the next lane for someone else's improvement. |

**One context claim checked and confirmed, recorded because it was worth
checking.** `routes/mediaFeed.ts` writes `rank_events` with `surface:
"watch_feed"` on media impressions — the writes are at lines 1751, 1787, 2081 and
2111 of that file — fire-and-forget, so a rejected insert surfaces only in a warn
log. Any claim that `watch_feed` is writerless is FALSE. **No row in this census
makes that claim**: `grep -n watch_feed docs/architecture/census-media.md` returns
nothing. It is recorded here so the next pass does not have to check again.

### 15.7 Restated headline

> | Measure | Was, §14.5 | Now |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 297 | **301** |
> | BUILT-BUT-WRONG | 83 | **81** |
> | NOT-BUILT | 68 | **66** |
> | CANNOT-VERIFY | 2 | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | 84.4 % | **382 / 450 = 84.9 %** |
> | **CORRECT%** (raw) = C/450 | 66.0 % | **301 / 450 = 66.9 %** |
>
> Restated from `check:census-integrity`, not by hand. The moves are two builds
> (MD360 `N → C`, MD169 `W → C`) and two re-reads (MD222 `W → C`, MD252
> `N → C`). **Construction moves by 0.5 points and correctness by 0.9**, and the
> gap between them NARROWS for the first time in three passes — from 18.4 to
> 18.0 — for the unglamorous reason that half of what moved was already built and
> only mis-graded.

The **spec-attributable** figure rises by **two**, not four, to **228 / 450 =
50.7 %**. MD360 and MD169 were built in this pass against named sections of this
spec (§16/§43 and §23). MD222 and MD252 were not built here at all; re-judging
the attribution of work an earlier pass delivered is a different measurement from
the one §14.5 performed, and §14.5's rule — *"no pre-existing row's attribution
was re-judged"* — is kept rather than quietly bent to make a number bigger.

### 15.8 The least flattering true thing about this pass

**It moved four rows and left the census red.** Both halves of that are worth
sitting with. The four are real and mutation-proved, and two of them were free —
the code already existed and the census was wrong about it, which means this
document's own error rate is a live term in its numbers and nobody is measuring
it. And the freshness check now fails on a branch that did honest work, because
the only two ways to make it pass are a sentence that would be false and a commit
that does not exist yet.

The larger fact is unchanged from §14.6 and this pass did not touch it: the
§46-compliant surface is still behind a flag seeded `false`, the surface users
reach is still the full-screen autoplaying stranger-video feed §46.2 forbids
twice, and **`GET /media/gems` — the endpoint this section is mostly about — is
served by a router inside that same dark shell.** It is correct, it is tested,
and today nobody can see it.

### 15.9 The Replit port's video work: MD280 does NOT move, and the old evidence clause was becoming false

ADDED 2026-09-16 by the INTEGRATING LANE, after merging the media lane of the
Replit Media/Map/Sensing port.

The port added real video playback to `MediaPerspectiveViewerScreen.tsx` —
play/pause, persisted mute, ±10 s seek, a progress bar, buffering and retry
states, and a control the UI labels **Captions**. The media lane declined to
write a staleness acknowledgement for this change and said so plainly, on the
grounds that it plausibly bears on MD280, MD285 and MD87. That was the right
refusal: an acknowledgement asserts a change moved no verdict, and that has to be
checked against the rows, not assumed.

Checked. **No verdict moves.** But one evidence clause had to be corrected,
because it is on its way to being false in a way that would mislead.

**MD280 Captions stays `N`.** §15's criterion for it is explicit — *"A
caption/subtitle track on the asset and a `textTrack` on the player."* Neither
exists. What the port added is a toggle that shows `media.note`, the creator's
own note, in a box over the video (`MediaPerspectiveViewerScreen.tsx:288`,
`:428-434`, `:446-448`). That is an overlay of authored text, not a timed text
track: it has no cue timings, it is not derived from the audio, it is not
selectable by language, and it does not travel with the asset. A deaf viewer
gains nothing from it that reading the post did not already give them.
`grep -rln textTrack travel-buddy-standalone/src` still returns nothing.

So the verdict is unchanged and the ROW's evidence is now imprecise rather than
wrong-in-substance: "No caption/subtitle/`textTrack` anywhere in the client" was
true when written, and is still true of tracks, but the client now contains a
control *named* Captions. Anyone auditing this row by searching for the word
would find that control and could reasonably conclude MD280 had been satisfied.
It has not been. **The criterion is a `textTrack`, and the presence of a button
that says Captions is not evidence for it.**

**MD285 Playback recovery stays `C`.** It was already `C` on `WatchVideoCell.tsx`,
which holds a `hasHardFailed` latch and distinguishes buffering from failure. The
new viewer adds a second surface with retry and buffering states, routed through
`useHydratedMedia` so a scheme-less `post-media/<uid>/x.mp4` reference shows the
poster and a retry rather than an empty frame. That strengthens the evidence for
a verdict that was already correct; it does not move it.

**MD87 stays `W`.** Its reasoning is that the contextual viewer exists but *"is
not the viewer a user reaches"*. The port did not change which viewer users
reach: the media lane deliberately did NOT take the incoming
`router.replace('/media-world')`, because main's flag-gated entry is an additive
pill whose own comment states the tab's default behaviour is unchanged, and a
`replace` is a hard takeover that would also make that pill unreachable. That is
a product/IA decision about whether the World shell replaces the Media tab or
sits beside it, and it is an owner's to make, not a merge's. Until it is made,
MD87's reasoning holds exactly as written.

## 16. MD106's missing consumer is no longer missing, and the table it reads is no longer absent from production

| | |
|---|---|
| **Measured at** | The Replit port integration branch. The document's `head_commit` row (§0) is **not** moved: this section re-reads ONE row, not 450. |

§11 enumerated `media_intent_signals` exhaustively and concluded: *"`media_intent_signals`
has **no reader anywhere in either tree**, so the asserted read does not exist… The
missing consumer is a real gap."* That was true when written. It is not true now, and
because this census is read last-statement-wins, saying so here is what keeps §11
readable rather than misleading.

**The consumer exists.** The port added
`artifacts/api-server/src/services/media/MediaProjectionService.ts:427#.from("media_intent_signals")`
— `loadViewerIntent`, one bulk read per candidate page, run after eligibility so the ids
it asks about are ids the viewer was already proved entitled to see. It feeds
`MediaRankingService`. So the trio §11 could not complete is complete: the upsert at
`MediaActionResolver.ts:798`, the delete at `mediaActions.ts:429`, and now a read.

**MD106 stays `C`, and for the same reason as before.** Its requirement is that a want is
an intent signal and not a Like. The separate table, the separate grant posture and the
separate write path carried that on their own, which is why §11 kept the `C` while
recording the gap. A consumer arriving does not change what MD106 asserts — it closes the
gap §11 filed *next to* the verdict. The distinction is the whole point of §11's ruling
and it survives intact.

**What DOES move is a fact about production, and it moved because this row's evidence was
checked rather than assumed.** `2256_media_intent_signals.sql` had been applied on the CI
project since 2026-09-03 and had **never reached production**: no table, and no
`schema_migration_ledger` row of any kind. `COMPASS_ENABLED` is ON in production, so the
live consequence was not theoretical — `POST` and `DELETE /api/media/:id/intent` were
answering `db_error` on **every** call, and every "I Want This" signal in production was
being refused. The new ranking read is fail-soft by design (a lost ranking input reorders
a page, it never widens one), so it would have scored every row intent 0 **in silence**
for as long as nobody looked.

`check:flag-schema-prerequisites` is what looked. It refused the port on exactly this
ground, and the remedy taken was the one that makes the refusal go away *truthfully*:
2256 was applied to production 2026-09-16 15:13:21 UTC, with a ledger row, and the
resulting table is the CI shape digest-for-digest (`963b2eec6268209a385f546d8be5db75`),
`authenticated=SELECT` only, anon nothing, RLS on, one owner-scoped SELECT policy, 0 rows.
The alternative remedy the check also offers — a `KNOWN` entry explaining why the absence
is tolerable — would have turned a live production defect into a documented one.

**Recorded because it generalises:** the reason this was found at all is that a new read
was added to a flag that is ON. The endpoints that had been failing for two weeks
surfaced their error to callers and still nobody noticed, because nothing compared the
flag's *code* against production's *schema*. MD106 is one row; `media_intent_signals` was
one of **68 tables that 41 migrations declare and production does not have**. That
inventory is reported, not repaired, and it is not this census's to close.

---

## 17. Pointer refresh 2026-09-22 — one counted file, five citations repaired, no verdict moved

`check:census-freshness` reported this census STALE against exactly one counted file:
`artifacts/api-server/src/services/wall/WallCandidateLoaders.ts` (+135 / −67 since this
census's declared `head_commit` `1fe72289b`). The change is the Wall lane's
failure-vs-empty work (PR #459), graded in `docs/architecture/census-wall.md` §15. It is
named here because this census counts that file, not because this census grades that work.

**The five rows and prose lines that cite it were re-read, and the measurement is the
point, not the topic.** The lane's edit wraps PostgREST result envelopes in a
`rowsOrThrow` helper so a `{ data: null, error }` — which supabase-js RESOLVES rather
than throws — reaches the `catch` block that was already written for it. Inside
`loadCapturedAtByEntity`, the one function this census actually reads, that catch logs
and returns the same empty map the swallowed error already produced, so **the resulting
state is identical and no gate, column, predicate or deny-list member changed.**

What was measured rather than assumed:

- **MD40 / MD42** — the `media_attachments` read: same table, same four projected
  columns (`entity_id, is_cover, position, media_assets(captured_at)`), same
  `entity_type` / `entity_id` predicate, and a byte-identical cover-then-position
  selection expression. Only its line number moved, 212 → 243.
- **MD339** — "read on ONE live path." Counted, not assumed:
  `from("media_attachments")` occurs **8 times in non-test `artifacts/api-server/src` at
  this head and 8 times at `origin/main`**, and the Wall read named by the row is the
  same one in both. The asymmetry the row grades is a WRITE-side gap, which no Wall edit
  can open or close. **W stands.**
- **MD192 / MD273** — the moderation deny-list moved 1119 → 1155 and its members are
  byte-identical. §9's caveat about which layer it runs on is untouched.

**No verdict moved, and this is NOT a re-measurement of this census** — 450 rows, 301 C /
81 W / 66 N / 2 X stand as §16 left them. Two of the five citations had gone DEAD (they
landed on a bare `}`), which is what `check:citation-targets` counts; all five were
repointed by reading the claim and anchored so `check:doc-citations` holds them from
here. The file is named in
`artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` with this argument.

---

## 18. Re-measured 2026-09-26 — two `N` rows hold, and one of them stopped being unread

**Re-measured, not acknowledged.** `check:census-freshness` named two counted
files changed since `1fe72289b` and not covered:
`lib/crowdFlowProducer.ts` (+62 / −26 net) and
`services/media/MediaContributorReputationService.ts` (+60).

**NO VERDICT MOVES.** Both rows that name those files were re-executed against
the tree rather than reasoned about.

### 18.1 MD162 — still `N`, and the producer moved away from Media, not toward it

The row's test is whether anything in `services/media/` or `lib/media/`
references the crowd flow. Re-run today:

```
grep -rniE "crowdflow|crowd_flow" src/services/media/ src/lib/media/   →  no match
```

Still `N`. The diff to `crowdFlowProducer.ts` adds `NextStopFamilyRefusal`
(`"read_failed" | "consent_unreadable"`) — a refusal vocabulary for the
next-stop signal family. That is the producer getting stricter about when it
may report, which if anything makes MD162's RED WHEN harder to reach, not
easier: §14.2 already records that Media perspectives cannot themselves become
a signal family, because a photograph declares no origin zone.

### 18.2 MD197 — still `N` on the RED WHEN, and its evidence clause had gone false

The RED WHEN is *a call site inside `services/ranking/`*. Re-run today:

```
grep -rn "MediaContributorReputation" src/services/ranking/   →  no match
```

Still `N`. But §14's follow-up clause said *"The scorer exists and nothing
reads it"*, and that is no longer true: `routes/mediaViewRequest.ts:26#import`
imports `readContributorReputation`. The scorer is **unranked, not unread**,
and the row is corrected in place to say so. The verdict is untouched — a view
request is not a ranking input — but a reader checking MD197 by asking "does
anything read this?" would have got the wrong answer from the census.

### 18.3 What the reputation diff actually is, and the silent wrong answer it prevents

It is not media work. It is 3002 fallout, and worth recording here because this
census owns the file.

Since 3002 a contributor's own rows are keyed by a **rotating token** written by
a `BEFORE INSERT` trigger, not by their account id. So
`.eq("actor_id", contributorId)` matches nothing once 3002 lands — and because
an empty filter is not an error, this service's `Promise.allSettled` fail-open
would have turned that into **"this contributor has never contributed", for
everyone**, silently. A wrong answer, not a failure.

The service now resolves the contributor's own token set first, through
`lib/intelConsent.readOwnContributorIdentities`, which runs account → tokens —
the safe direction — over 3310's `intel_contributor_tokens_for_actor`. An
identity that cannot be resolved yields the EMPTY reputation, logged at warn,
never an inflated one, and no account id is received or derived.

Two consequences worth stating: this is a **real production consumer of the
3310 bridge** (the other is `lib/intelEvidenceCapture`), so 3310 is wired rather
than declared; and this hazard is a member of the class the cutover runbook
exists for — old code against new schema failing *quietly* rather than loudly.

### 18.4 MOVES NOTHING

Totals unchanged. MD162 and MD197 both stay `N`, on tests re-executed today
rather than carried forward.

## 19. The Media client IA — five screens that did not exist, the §14 entry contexts, one Media Map, and a Search a user can actually ask — 2026-09-26

This is the record of the 2026-09-26 **Lane A** pass (Media client IA: lenses,
screens, viewer entry contexts, perspective groups, client structure, visual
design and anti-patterns), one of four lanes run in parallel. Branch
`claude/media-lane-a-client-ia-20260926`, cut from `bae9ea2d4`.

It moves **twenty-eight rows to `C`**, moves **one row DOWN** (MD293, `W → N`,
because the §38 `×7` row hid a query nothing answers), re-evidences **six `C`
rows** whose grade had been resting on a placeholder or on a request the server
never read, and attaches a RED WHEN and a WHO to every assigned row that stays
open. It does **not** restate the headline — that is deliberate and is why
`check:census-integrity` is red on this branch (§19.8) — and it does **not** move
the document's `head_commit`, because it re-reads fifty-odd rows, not 450.

### 19.1 The caps, stated before anything is claimed

- **BUILT ON BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG
  ENABLED. FLAG ENABLED IS NOT PRODUCTION REALIZED.** Every `C` below is a
  construction verdict on this branch. None of it is merged.
- **The World shell is dark.** `MEDIA_WORLD_SHELL_ENABLED` is seeded
  `artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql:116#false,`
  (the row at `artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql:115#'MEDIA_WORLD_SHELL_ENABLED',`).
  This census's §1 rule — *"Flag-dark is a deployment fact, not a verdict"* — is
  what makes these rows `C`; **production-realized for every one of them is
  zero.** This pass enabled no flag.
- **The Media Map positions nothing in production.** Positions come only from
  the canonical Map gateway, and `map_projection_enabled`
  `docs/ops/map-completion-checkpoint.md:157#has NO ROW in production` (also
  `docs/ops/input-intelligence-deployment-handoff.md:212#**NO ROW AT ALL**`).
  Deployed today, every Map mode would LIST its clusters and place none of them,
  and say so in words (`travel-buddy-standalone/src/features/media/state/mediaMapStore.ts:380#export function positionsUnavailableCopy(`).
  The screen is built; the geography is the Map lane's and is off.
- **Four new routes** (`/media-map`, `/media-search`, `/media-timeline`,
  `/media-contribute`) are reachable by deep link exactly as `/media-world`
  already is; nothing outside the dark shell links to them. Registered at the
  END of the route array so no cited line moved:
  `travel-buddy-standalone/src/navigation/portavaRoutes.ts:2080#key: 'media-map',`.
- **Every proof is a fixture or a stand-in.** The client suites stub `fetch` or
  the service module; the server suites use the in-memory Supabase double. A
  mutation turning a suite red proves the test can fail. It proves nothing about
  production data. No database was read or written; no migration was authored.

### 19.2 What was built

| Rows | What was built | Anchored |
| --- | --- | --- |
| MD15 · MD21 · MD33 · MD313 | §16 HIDDEN GEMS lens as a gem-STATE screen (not the pre-existing `GemsFeed`), with Overview sections in §3 order, a Visual mosaic of each gem's OWN image, and a gems-only Map; `HiddenGemCard` | `travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:50#export function HiddenGemsMediaScreen(` · mounted `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:24#import { HiddenGemsMediaScreen } from './HiddenGemsMediaScreen.tsx';` · modes `travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:77#if (mode === 'map') {` / `travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:101#if (mode === 'visual') {` · card `travel-buddy-standalone/src/features/media/components/HiddenGemCard.tsx:35#export function HiddenGemCard(` · transport `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1200#mapGemLensProjection, opts);` · server image `artifacts/api-server/src/services/media/MediaGemStateService.ts:409#imageUrl: typeof (gem as any).image_url === "string"` |
| MD415 | §46.1 edge glow / contour from the gem's derived state: calm glow, a DIMMER protective contour when fragile, no glow when unavailable | `travel-buddy-standalone/src/features/media/state/gemLens.ts:273#export function gemContourTreatment(` · applied `travel-buddy-standalone/src/features/media/components/HiddenGemCard.tsx:37#const contour = gemContourTreatment(gem.state);` |
| MD25 · MD329 · MD416 · MD405 | §4/§21 Media Map screen + `state/mediaMapStore`: counts from `GET /media/map`, positions ONLY from canonical place objects the Map gateway serves; an unpositioned cluster is listed, never placed; an APPROXIMATE gem is a filled, contoured AREA (never a pin) | `travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:70#export function MediaMapScreen(` · `travel-buddy-standalone/src/features/media/state/mediaMapStore.ts:135#export function joinClustersToPositions(` · `travel-buddy-standalone/src/features/media/state/mediaMapStore.ts:165#export function gemMapTreatment(` · `travel-buddy-standalone/src/features/media/state/mediaMapStore.ts:313#export function mediaMapReducer(` · zone layer `travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:80#<GeoJSONSource id="media-gem-zones" data={zoneData}>` · gateway `travel-buddy-standalone/src/features/media/hooks/useMediaMap.ts:70#: fetchMapProjection({` |
| MD35 · MD449 · MD30 · MD31 · MD32 | Every lens Map mode is that one Media Map — NOW, PLACES, EXPERIENCES, HIDDEN GEMS and MY WORLD (the owner's own places, published + tagged only) | `travel-buddy-standalone/src/features/media/screens/MediaWorldScreen.tsx:79#<MediaMapScreen` · `travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:91#<MediaMapScreen` · `travel-buddy-standalone/src/features/media/screens/MediaExperiencesScreen.tsx:64#return <ExperiencesMap placeKey={placeKey}` · `travel-buddy-standalone/src/features/media/screens/MyWorldMediaScreen.tsx:128#<MediaMapScreen` |
| MD26 | §4 Media Timeline / Time Rail screen: the place-scoped (or world) §17 rail plus the OBSERVED Earlier perspectives; NOW and PLACES Time modes mount it | `travel-buddy-standalone/src/features/media/screens/MediaTimelineScreen.tsx:43#export function MediaTimelineScreen(` · `travel-buddy-standalone/src/features/media/screens/MediaWorldScreen.tsx:53#return <MediaTimelineScreen onOpenMedia={onOpenMedia} />;` · `travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:227#<MediaTimelineScreen placeId={placeId}` |
| MD27 · MD331 · MD228 · MD294 · MD287 · MD290 · MD291 · MD292 | §4/§38 Media Search screen over `state/mediaFilterStore` (the ONLY builder of the query; criteria-free asks nothing); all seven result kinds; "Search my world" inside My World; the city as its own criterion; "Search within this trip" | `travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:70#export function MediaSearchScreen(` · `travel-buddy-standalone/src/features/media/state/mediaFilterStore.ts:127#export function toSearchQueryString(` · `travel-buddy-standalone/src/features/media/screens/MyWorldMediaScreen.tsx:90#<MediaSearchScreen initialScope="me" fixedScope` · `travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:110#if (cityDraft.trim()) dispatch({ type: 'set_city', city: cityDraft });` · `travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:290#dispatch({ type: 'set_scope', scope: 'trip', tripId: t.id });` · header `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:114#onSearch={() => router.push('/media-search' as never)}` |
| MD294 (server) | Events and Trips found BY TITLE in the canonical tables, each passed through the same `resolveExperience` gate `GET /media/experiences/:id` uses; an unreadable table is `undetermined`, never "none"; only for `scope=all` | `artifacts/api-server/src/services/media/MediaSearchService.ts:485#export async function searchCanonicalEventsAndTrips(` · gate `artifacts/api-server/src/services/media/MediaSearchService.ts:531#exp = await resolveExperience(sc, viewer, id, nowMs);` · served `artifacts/api-server/src/routes/mediaWorld.ts:347#withCanonicalKinds(results, await searchCanonicalEventsAndTrips(` |
| MD332 | `state/myMediaStore`: §30 bucket order, a selection that falls back rather than pointing at nothing, search as state not a route | `travel-buddy-standalone/src/features/media/state/myMediaStore.ts:62#export function myMediaReducer(` |
| MD28 · MD316 | §4 Media Contribution: a current perspective of ONE canonical place through the app's existing `uploadMedia` → `createPost` (no second ingest path); the post is bound to the VENUE's public name and coordinates, the device fix travels only as the private verification pair; precision maps onto `locationPrivacyMode` incl. §34 "after I leave"; a failed SAVE retries the save, never the upload; a held-back post says so | `travel-buddy-standalone/src/features/media/screens/MediaContributionScreen.tsx:53#export function MediaContributionScreen(` · `travel-buddy-standalone/src/features/media/components/MediaContributionSheet.tsx:40#export function MediaContributionSheet(` · `travel-buddy-standalone/src/features/media/state/mediaContribution.ts:143#locationLat: place.coordinates.lat,` · `travel-buddy-standalone/src/features/media/state/mediaContribution.ts:148#locationPrivacyMode: PRECISION_TO_PRIVACY_MODE[d.precision],` · entry `travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:198#{onContribute && UUID_RE.test(placeId) ? (` |
| MD314 | §7 context sheet on the viewer's `•••`: only the edges the server resolved (the §28 Shared Moment edge included), each linking home; "Where was this taken?" | `travel-buddy-standalone/src/features/media/components/MediaContextSheet.tsx:44#export function MediaContextSheet(` · `travel-buddy-standalone/src/features/media/state/mediaContextGraph.ts:99#export function buildContextGraph(` · `travel-buddy-standalone/src/features/media/state/mediaContextGraph.ts:165#export function whereTakenHref(` · `travel-buddy-standalone/src/features/media/screens/MediaPerspectiveViewerScreen.tsx:255#testID="perspective-viewer-context"` |
| MD89 · MD90 · MD91 · MD92 | The four missing §14 entry-context producers, as pure builders + openers: Event and Trip (kind from the projection, never guessed), People (that contributor only), Map (the cluster's canonical place, read through the gated place view, staged with kind `map`); the viewer's collection filter honours the new kinds | `travel-buddy-standalone/src/features/media/state/entryContextHandoffs.ts:97#export function experienceHandoff(` · `travel-buddy-standalone/src/features/media/state/entryContextHandoffs.ts:123#export function personHandoff(` · `travel-buddy-standalone/src/features/media/state/entryContextHandoffs.ts:58#export function mapClusterHandoff(` · `travel-buddy-standalone/src/features/media/services/perspectiveOpeners.ts:58#export async function openClusterPerspectives(` · `travel-buddy-standalone/src/features/media/state/perspectiveViewer.ts:100#if (kind === 'people') {` |
| MD14 (finding) · MD89 · MD91 | The EXPERIENCES lens is handed real ids: deep-linked first, then the viewer's own events and trips, then nearby events; UUIDs only, capped | `travel-buddy-standalone/src/features/media/state/experienceSources.ts:32#export function experienceIdsFrom(` · `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:171#experienceIds={experienceIds}` |
| MD87 (shell half only) | A NOW "Changing now" card opens that PLACE's perspectives (§14 Place) instead of the generic single-item viewer | `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:132#if (item.placeId) void openPlaceByIdPerspectives(item.placeId, hero ?? null);` · `travel-buddy-standalone/src/features/media/services/perspectiveOpeners.ts:70#export async function openPlaceByIdPerspectives(` |
| MD12 (finding) | The World request sends the coarse `city` LABEL the route parses | `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1094#if (params.city) qs.set('city', params.city);` |

**Tests, all in the tree.** Client node (`src/**/*.test.ts`, run by
`scripts/run-node-tests.mjs`): `gemLens.test.ts`, `mediaMapStore.test.ts`,
`entryContextHandoffs.test.ts`, `searchAndStores.test.ts`,
`mediaContribution.test.ts`. Client component (jest, `*.component.test.tsx`):
`HiddenGemsMediaScreen`, `MediaMapScreen`, `MediaSearchScreen`,
`MediaWorldShell` (10 cases), `MediaContextSheet` (7 cases),
`MediaContributionScreen` — all under
`travel-buddy-standalone/src/features/media/__tests__/`. Server (appended to
already-registered suites, so no `package.json` change):
`artifacts/api-server/src/test/mediaGemStateLens.test.ts` ("MD33 — carries a
disclosable gem's OWN image for Visual mode, and no image of a hidden one") and
`artifacts/api-server/src/test/mediaWorldProjection.test.ts` (the "MD294 — §38
finds EVENTS and TRIPS by what they are, through their own gates" block, eight
cases, and the "MD287 · MD292 — §38 'right now' and 'from my trip' are real
narrowings, and every gate still binds" block, three cases).

### 19.3 Row moves

| Row | Was | Now | What was built |
| --- | --- | --- | --- |
| MD15 | **W** | **C** | The row's stated defect — the lens imports `GemsFeed` and there is no `/media/gems` — is gone on both halves: the shell mounts the §16 gem-state screen at `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:24#import { HiddenGemsMediaScreen } from './HiddenGemsMediaScreen.tsx';` over `GET /media/gems` (MD360). TESTED: `MediaWorldShell.component.test.tsx` "HIDDEN GEMS is the §16 gem-STATE screen (not GemsFeed), scoped by the city label, honouring all three modes". RED under mutation: the lens mounting nothing (C1); `fetchGems` mapping through the OLD client mapper, which dropped every gem the server sent (C2); `fetchGems` sending `cityId`, which the route never reads (C3). Cap: shell dark (§19.1). |
| MD21 | **N** | **C** | `travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:50#export function HiddenGemsMediaScreen(`. TESTED: `HiddenGemsMediaScreen.component.test.tsx` (six cases) and `gemLens.test.ts` (ten). RED: an unreadable gem list rendered as an empty city (C6); "worth the detour" decided before the protective states, filing a CLOSED gem under an enticing heading (C10). |
| MD25 | **N** | **C** | `travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:70#export function MediaMapScreen(`, routed at `travel-buddy-standalone/app/media-map/index.tsx:35#<MediaMapScreen`. TESTED: `MediaMapScreen.component.test.tsx` "draws a bubble ONLY where the canonical Map positioned the place; the rest is listed, never placed" and six more. RED: an unpositioned cluster placed at an invented point — in the store (C11) and on the rendered canvas (C12). Cap: `map_projection_enabled` has no production row (§19.1) — deployed, it lists and places nothing. |
| MD26 | **N** | **C** | `travel-buddy-standalone/src/features/media/screens/MediaTimelineScreen.tsx:43#export function MediaTimelineScreen(`, routed at `travel-buddy-standalone/app/media-timeline/index.tsx:24#<MediaTimelineScreen`, mounted as NOW's Time mode at `travel-buddy-standalone/src/features/media/screens/MediaWorldScreen.tsx:53#return <MediaTimelineScreen onOpenMedia={onOpenMedia} />;`. TESTED: `MediaContextSheet.component.test.tsx` "asks for the PLACE-scoped timeline and shows the rail plus the observed Earlier perspectives". RED: Earlier perspectives dropped (C23); a forecast rendered as a captured perspective (C24); NOW's Time mode not mounting it (C25). |
| MD27 | **N** | **C** | `travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:70#export function MediaSearchScreen(`, routed at `travel-buddy-standalone/app/media-search/index.tsx:36#<MediaSearchScreen`, opened by the shell header. TESTED: `MediaSearchScreen.component.test.tsx` (nine cases; each asserts the EXACT request). RED: a request per keystroke (C26); a criteria-free request (C27); an undetermined list shown as "nothing" (C28); the header going back to the global `/search` (C40). |
| MD28 | **N** | **C** | `travel-buddy-standalone/src/features/media/screens/MediaContributionScreen.tsx:53#export function MediaContributionScreen(`, routed at `travel-buddy-standalone/app/media-contribute/index.tsx:50#<MediaContributionScreen placeId={placeId}`, entered from a canonical place's "Add your view". TESTED: `MediaContributionScreen.component.test.tsx` "uploads THEN saves a post bound to the venue with every choice the contributor made" and three more; `mediaContribution.test.ts` (six). RED: the post tagged with the contributor's position instead of the venue (C42); a failed save re-uploading the file (C43); a held-back post reported as live (C44); "Add your view" removed (C48). Cap: the write path is the existing gated post write — nothing here is a new server surface. |
| MD33 | **W** | **C** | All three §5 modes are honoured by the lens itself (`travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:101#if (mode === 'visual') {`, `travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:77#if (mode === 'map') {`); Visual uses each gem's OWN image, served additively at `artifacts/api-server/src/services/media/MediaGemStateService.ts:409#imageUrl: typeof (gem as any).image_url === "string"` for disclosable gems only. TESTED: `HiddenGemsMediaScreen.component.test.tsx` "VISUAL: a mosaic of the gems' OWN images…" and "MAP: gems only, through the Media Map…"; server "MD33 — carries a disclosable gem's OWN image…". RED: Visual ignored (C4); Map ignored (C5); the server image forced null (A1). |
| MD35 | **W** | **C** | The placeholder the row cites is gone: My World's Map is the Media Map over the owner's own places — published and tagged, never a draft, archive, upload or processing item (`travel-buddy-standalone/src/features/media/screens/MyWorldMediaScreen.tsx:128#<MediaMapScreen`). TESTED: `MediaWorldShell.component.test.tsx` "MY WORLD → Map is the Media Map over the owner's own places"; `searchAndStores.test.ts` "My World's map places published + tagged media once each…". RED: placeholder restored (C35); drafts placed on the map (C33). Cap: Map gateway off in production. |
| MD89 | **N** | **C** | Event entry context: `travel-buddy-standalone/src/features/media/state/entryContextHandoffs.ts:97#export function experienceHandoff(`, kind read from the projection, opened from the EXPERIENCES lens, whose ids now come from the viewer's own events and trips (`travel-buddy-standalone/src/features/media/state/experienceSources.ts:32#export function experienceIdsFrom(`). TESTED: `MediaWorldShell.component.test.tsx` "EXPERIENCES resolves the viewer's own events and trips; a Trip opens the TRIP entry context, an Event the EVENT one"; `entryContextHandoffs.test.ts`. RED: every experience opened as an Event (C19); the lens handed no ids again (C20). |
| MD90 | **N** | **C** | People entry context: `travel-buddy-standalone/src/features/media/state/entryContextHandoffs.ts:123#export function personHandoff(` — that contributor's media only. TESTED: `MediaWorldShell.component.test.tsx` "PEOPLE: tapping a person's perspective opens the PEOPLE entry context scoped to that person"; `entryContextHandoffs.test.ts` "MD90 People…". RED: another contributor's media paged in (C21); the tap going to the generic viewer (C22). |
| MD91 | **N** | **C** | Trip entry context — the same builder, `kind: 'trip'` from the projection; the Trip case of the MD89 test. RED: C19, C20. |
| MD92 | **N** | **C** | Map entry context: `travel-buddy-standalone/src/features/media/state/entryContextHandoffs.ts:58#export function mapClusterHandoff(` via `travel-buddy-standalone/src/features/media/services/perspectiveOpeners.ts:58#export async function openClusterPerspectives(` — the cluster's canonical place read through the SAME gated `GET /media/places/:id`, staged with kind `map`; an unreadable place opens nothing. TESTED: `MediaContextSheet.component.test.tsx` "reads the cluster's place through the gated place view and stages kind `map`" and "a cluster whose place view cannot be read opens NOTHING"; `MediaMapScreen.component.test.tsx` "selecting a cluster and opening it hands THAT cluster to the caller". RED: kind `map` lost (C17); another place's view staged (C18). Cap: the Map screen it is entered from positions nothing in production. |
| MD228 | **W** | **C** | The row's own RED WHEN — *"a search field on the My World surface that issues `GET /media/search?scope=me`"* — is met: `travel-buddy-standalone/src/features/media/screens/MyWorldMediaScreen.tsx:90#<MediaSearchScreen initialScope="me" fixedScope`, a fixed scope that cannot be widened from inside it. TESTED: `MediaSearchScreen.component.test.tsx` "opens a search that is scope=me, cannot be widened, and closes back to the library". RED: My World's search sent to everyone (C30). The second settlement the row offered (a `q` on `GET /media/me`) was NOT built, on purpose: one matcher, one endpoint. |
| MD287 | **W** | **C** | "What does An Thuong look like right now?" is askable (term + the "Right now" chip → `q=…&freshOnly=true`) and answered: the term inside the fresh window only. TESTED: server "'What does An Thuong look like right now?' is the term inside the FRESH window only"; client `searchAndStores.test.ts` "§38 'What does An Thuong look like right now?' is the term + freshOnly…". RED: `freshOnly` dropped server-side (S2); a new term clearing "Right now" (C57). |
| MD290 | **W** | **C** | "Show my Bangkok rooftop photos" is askable end-to-end: My World's search with the city as its OWN criterion (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:110#if (cityDraft.trim()) dispatch({ type: 'set_city', city: cityDraft });`) → `q=rooftop&city=Bangkok&scope=me`. TESTED: `MediaSearchScreen.component.test.tsx` "§38 'Show my Bangkok rooftop photos': the city is its own criterion…"; server "scope=me returns only the viewer's own media". RED: the city dropped (C51); the city smuggled into the free text (C52); clearing the city keeping the criterion (C56). |
| MD291 | **W** | **C** | "Where was this photo taken?" is askable from the viewer: `•••` → context sheet → `travel-buddy-standalone/src/features/media/state/mediaContextGraph.ts:165#export function whereTakenHref(` → the search screen's "Taken at …" answer, which is the coarse place the disclosure choke point allows. TESTED: `MediaContextSheet.component.test.tsx` "shows the server-resolved graph…"; `MediaSearchScreen.component.test.tsx` "'Where was this photo taken?' answers with the coarse place…"; server "MD291 — 'Where was this photo taken?' resolves a media id to its coarse place". RED: the media id dropped from the link (C41); the `•••` inert (C38). |
| MD292 | **W** | **C** | "Show festival media from my Vietnam Trip" is askable: a Trip found by name is searched WITHIN (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:290#dispatch({ type: 'set_scope', scope: 'trip', tripId: t.id });`) → `q=festival&scope=trip&tripId=…`, narrowed server-side at `artifacts/api-server/src/services/media/MediaProjectionService.ts:303#if (filter.tripId) query = query.eq("trip_id", filter.tripId);`. TESTED: `MediaSearchScreen.component.test.tsx` "§38 'Show festival media from my Vietnam Trip'…"; server "'Show festival media from my Vietnam Trip' returns ONLY that trip's matching media" and "a trip scope does not open a gate…". RED: trip id lost on the client (C53); no within-trip affordance (C54); no trip chip (C55); trip id never reaching the loader (S1); the private-account guard dropped from the shared loader (S3b). |
| MD293 | **W** | **N** | **Moved DOWN.** "Find places that look like this." was carried at `W` only as a member of the §38 `×7` row. On its own it is not built: there is no cross-place visual index, and the service says so rather than implying otherwise — `artifacts/api-server/src/services/media/MediaSearchService.ts:70#no cross-place visual index exists`, now rendered on screen under the results. Stating a limitation honestly is not building the capability. |
| MD294 | **W** | **C** | The row's falsifier, verbatim — *"a search that finds the Beach Festival because it is called Beach Festival, not because somebody photographed it"* — is met at `artifacts/api-server/src/services/media/MediaSearchService.ts:485#export async function searchCanonicalEventsAndTrips(`, each candidate through `artifacts/api-server/src/services/media/MediaSearchService.ts:531#exp = await resolveExperience(sc, viewer, id, nowMs);`, served at `artifacts/api-server/src/routes/mediaWorld.ts:347#withCanonicalKinds(results, await searchCanonicalEventsAndTrips(`, rendered as Events and Trips sections. TESTED: the eight-case server block and `MediaSearchScreen.component.test.tsx` "renders the §38 result types — events and trips found by NAME…". RED: the gate bypassed (B1); `scope=me` reaching world events (B2); an unreadable table read as "none" (B3); no title read (B4); the `ilike` sanitiser removed (B5); the route sending plain results (B6); the client mapper dropping events/trips (C29). |
| MD313 | **N** | **C** | `travel-buddy-standalone/src/features/media/components/HiddenGemCard.tsx:35#export function HiddenGemCard(`. TESTED: `HiddenGemsMediaScreen.component.test.tsx` "OVERVIEW: the card carries the §46.1 contour…"; `gemLens.test.ts` "the card authors no hype vocabulary and prints no number…". RED: contour dropped (C7); the card printing a count (C9). |
| MD314 | **N** | **C** | `travel-buddy-standalone/src/features/media/components/MediaContextSheet.tsx:44#export function MediaContextSheet(`, opened from the viewer's `•••` (`travel-buddy-standalone/src/features/media/screens/MediaPerspectiveViewerScreen.tsx:255#testID="perspective-viewer-context"`). TESTED: `MediaContextSheet.component.test.tsx` "shows the server-resolved graph — including the Shared Moment edge…", "draws no edge the server did not send…", "pressing ••• shows 'What this is part of'…". RED: C36b / C36c (the Shared Moment edge dropped — see §19.5 for the survivor); an edge invented without a ref (C37); `•••` inert (C38). |
| MD316 | **N** | **C** | `travel-buddy-standalone/src/features/media/components/MediaContributionSheet.tsx:40#export function MediaContributionSheet(` — what it shows, who sees it, how precisely the place is shown, an optional note; it offers ONLY the categories the server groups by and no §12 vantage (MD82–MD85). TESTED: as MD28. RED: precision going nowhere (C45); category going nowhere (C46); send enabled with nothing picked (C47). |
| MD329 | **N** | **C** | `travel-buddy-standalone/src/features/media/state/mediaMapStore.ts:313#export function mediaMapReducer(` — no location / disabled gateway / failed gateway are three worded states, none of them "empty"; an unreadable count is an error. TESTED: `mediaMapStore.test.ts` (thirteen cases); `MediaMapScreen.component.test.tsx` "a disabled Map gateway is said in words…", "an unreadable count is an ERROR, never 'no one is out'". RED: a disabled gateway read as positions-available (C15); an unreadable count read as an empty map (C16). |
| MD331 | **N** | **C** | `travel-buddy-standalone/src/features/media/state/mediaFilterStore.ts:127#export function toSearchQueryString(` — the one builder of the search query. TESTED: `searchAndStores.test.ts` "EMPTY MEANS EMPTY…", "a trip scope with no trip is a mistake, not a criterion". RED: a trip id surviving the scope change (C31); a trip scope with no trip sending a request (C32). |
| MD332 | **N** | **C** | `travel-buddy-standalone/src/features/media/state/myMediaStore.ts:62#export function myMediaReducer(`. TESTED: `searchAndStores.test.ts` "myMediaStore: §30 order, a selection falls back rather than pointing at nothing, search is state not a route". RED: a stale selection pointing at nothing (C34); drafts on the map (C33). |
| MD405 | **W** | **C** | The row's client half — *"there is no Media Map screen (MD25), no map store (MD329), and My World's map mode is a placeholder"* — is closed on all three counts (MD25, MD329, MD35 above), and every lens Map mode integrates the canonical Map rather than a second location engine (`travel-buddy-standalone/src/features/media/hooks/useMediaMap.ts:70#: fetchMapProjection({`). RED: C11, C12, C35, C49, C50. Cap: the canonical Map gateway is off in production. |
| MD415 | **N** | **C** | `travel-buddy-standalone/src/features/media/state/gemLens.ts:273#export function gemContourTreatment(` — every one of the ten states has a treatment; fragile is dimmer than calm; unavailable has no glow. TESTED: `gemLens.test.ts` "§46.1 contour…"; the card case above. RED: C7; a fragile gem given the brightest glow (C8). Cap: style values asserted in the render tree; no device pixels were measured (MD403's reasoning applies). |
| MD416 | **N** | **C** | `travel-buddy-standalone/src/features/media/state/mediaMapStore.ts:165#export function gemMapTreatment(` — the treatment is decided by the privacy rung alone: approximate → a filled, contoured area at neighbourhood scale (`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:80#<GeoJSONSource id="media-gem-zones" data={zoneData}>`), place-level → a contoured marker, hidden rungs not drawn. TESTED: `MediaMapScreen.component.test.tsx` "§46.1: an APPROXIMATE gem is a filled, contoured AREA and never a marker…"; `mediaMapStore.test.ts` (three cases). RED: an approximate gem drawn as a pin (C13); a `none`-rung gem drawn (C14). Cap: jest renders the layer tree through a MapLibre stand-in; and in production the gateway positions no gem. |
| MD449 | **W** | **C** | Phase 9's one missing piece was My World's Map (the row's own words); closed with MD35. RED: C35. |

### 19.4 Six `C` rows whose grade was resting on something false

Each of these was already `C` and stays `C`. What changed is that the evidence
under the letter is now true; before this pass, in each case, it was not.

| Row | Was | Now | What was wrong, and what backs it now |
| --- | --- | --- | --- |
| MD12 | **C** | **C** | The NOW lens was never city-scoped. The client sent `cityId`; `GET /media/world` parses `city` — so every request fell through to the unscoped path. Now `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1094#if (params.city) qs.set('city', params.city);`. TESTED: `searchAndStores.test.ts` "fetchGems / fetchMediaMap / fetchWorld send the coarse `city` LABEL the routes actually parse". RED: C3. |
| MD14 | **C** | **C** | The EXPERIENCES lens was handed a constant empty id list by the shell, so on every open it could only render its empty state; the `C` rested on a screen that could not show an experience. Now `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:171#experienceIds={experienceIds}` from the viewer's own events and trips. TESTED and RED as MD89 (C20). |
| MD30 | **C** | **C** | NOW's Map mode was a placeholder paragraph (*"The Media Map … arrives in a later phase"*) when this was graded `C`. Now `travel-buddy-standalone/src/features/media/screens/MediaWorldScreen.tsx:79#<MediaMapScreen`. TESTED: `MediaWorldShell.component.test.tsx` "NOW → Map is the one Media Map and NOW → Time is the Media Timeline screen". RED: C39. |
| MD31 | **C** | **C** | PLACES' Map mode was a placeholder (*"…arrive with the Media Map phase"*). Now `travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:91#<MediaMapScreen`. TESTED: "PLACES → Map and EXPERIENCES → Map are the one Media Map…". RED: C49. |
| MD32 | **C** | **C** | EXPERIENCES' Map mode was a placeholder (*"Geographic experience clusters arrive with the Media Map phase."*). Now `travel-buddy-standalone/src/features/media/screens/MediaExperiencesScreen.tsx:64#return <ExperiencesMap placeKey={placeKey}`. RED: C50. |
| MD417 | **C** | **C** | The row cites `gemStateDisplay.ts` for four labels; **"Worth the Detour" is not a label there** — it appears only as a contribution's description. It now exists as a lens section drawn from the §16.3 `still_worth_it` OBSERVATION, never from saves: `travel-buddy-standalone/src/features/media/state/gemLens.ts:160#worth_the_detour: 'Worth the detour',`. TESTED: `gemLens.test.ts` "'Worth the detour' is a visitor OBSERVATION — saves and visits cannot put a gem there". RED: C10. |

§9.9 predicted this: *"Six were [re-read], and four of them were wrong."* This
pass did not set out to audit the `C` column and found six `C` rows in its own
lane resting on a placeholder, a dead request, or a label that did not exist. That is a rate, not a
coincidence, and it says the §5 lens/mode block was graded from the mode bar,
not from what each mode rendered.

### 19.5 Mutations, in full, including the one that survived

Seventy-two mutation runs, with a harness that applies one textual change,
runs the named suite, and restores the file unconditionally. **Seventy-one
reddened. One survived (mC36) and is reported, not quietly fixed** — it was
killed after the test was corrected, by the re-runs mC36b and mC36c, which are
two of the seventy-one.

Server (`node --import tsx/esm --test`):

| # | Mutation | Suite | Result |
| --- | --- | --- | --- |
| mA1 | gem `imageUrl` forced null | `mediaGemStateLens.test.ts` | RED — the MD33 case |
| mB1 | canonical search bypasses `resolveExperience` | `mediaWorldProjection.test.ts` | RED — the private event and the stranger's trip leak |
| mB2 | `scope=all` restriction dropped | same | RED — My World reaches world events |
| mB3 | an unreadable candidate read returns `[]` | same | RED — `undetermined` case |
| mB4 | events/trips found only via media (no title read) | same | RED — "finds a public event BY NAME…" |
| mB5 | `ilike` sanitiser removed | same | RED |
| mB6 | route sends plain results (fold removed) | same | RED — the router-source case |
| mS1 | `tripId` never reaches the loader | same | RED — the Vietnam Trip case |
| mS2 | `freshOnly` filter dropped | same | RED — the An Thuong case |
| mS3b | private-account guard dropped from the shared loader | same | RED — "a trip scope does not open a gate…" |

A tenth server mutation (mS3, injecting a raw row after projection) also
reddened; it is not counted, because a mutation that ADDS a fake row tests the
assertion rather than the code path. mS3b replaced it.

Client (`node --import tsx --test` for `*.test.ts`; `npx jest` for
`*.component.test.tsx`), grouped by what they prove:

| # | Mutation | Result |
| --- | --- | --- |
| mC1–mC3 | shell mounts nothing for HIDDEN GEMS; `fetchGems` through the old mapper; `fetchGems` sends `cityId` | RED ×3 |
| mC4–mC10 | Visual ignored; Map ignored; unreadable = empty; contour dropped; fragile gets brightest glow; card prints a count; "worth the detour" before protective | RED ×7 |
| mC11–mC16 | invented position (store); invented position (canvas); approximate gem as pin; `none` rung drawn; disabled gateway = positions available; unreadable count = empty | RED ×6 |
| mC17–mC22 | map kind lost; another place's view; every experience an Event; Experiences handed no ids; another contributor paged in; People tap to generic viewer | RED ×6 |
| mC23–mC25 | Earlier dropped; forecast as perspective; NOW Time not mounted | RED ×3 |
| mC26–mC35 | request per keystroke; criteria-free request; undetermined as nothing; events/trips dropped; My World searches everyone; trip id survives; tripless trip request; drafts on map; stale selection; My World map placeholder | RED ×10 |
| mC36 | the context mapper drops the §28 Shared Moment edge | **SURVIVED**, then killed |
| mC36b · mC36c | the same mutation, after the fix — component suite and node suite | RED ×2 |
| mC37–mC41 | edge invented without a ref; `•••` inert; NOW Map not the Media Map; header to global `/search`; "Where was this taken?" drops the id | RED ×5 |
| mC42–mC50 | contributor position instead of venue; re-upload on failed save; held-back as live; precision ignored; category ignored; send with nothing; "Add your view" removed; Places map placeholder; Experiences map placeholder | RED ×9 |
| mC51–mC57 | city dropped; city in free text; within-trip loses id; no within-trip affordance; no trip chip; clearing city keeps it; new term clears "Right now" | RED ×7 |
| mC58 · mC59 | changing-now card back to the single-item viewer; place opener ignores the tapped hero | RED ×2 |

**mC36 is the one worth reading.** It made the context mapper drop the Shared
Moment edge, and the component suite stayed green, because the suite's stand-in
for `fetchMediaContextRefs` returned refs that were ALREADY mapped — the real
mapper was never on the path the test exercised. A test named "shows the
server-resolved graph — including the Shared Moment edge" was proving the
stand-in, not the code. The stand-in now feeds the raw `/actions` body through
the real mapper; the same mutation (mC36b) and its node twin (mC36c) now redden.

### 19.6 Rows that stay open

Every assigned row not moved above. Each blocker is one that only an owner
decision, a deployment, production data or another lane's file can remove —
and each says which.

| Row | V | Why it does not move | RED WHEN | WHO |
| --- | --- | --- | --- | --- |
| MD1 | **W** | The World hierarchy is built; the Media tab a user opens is Watch (`travel-buddy-standalone/src/stores/mediaStore.ts:104#selectedMode: 'watch',`) and the World entry is behind the dark flag (`travel-buddy-standalone/app/(tabs)/media.tsx:190#isEnabled('MEDIA_WORLD_SHELL_ENABLED')`). §1: a spec about Media is not satisfied by a subsystem of it. | `MEDIA_WORLD_SHELL_ENABLED` true in production AND the tab no longer defaults to `'watch'` AND a reachability-ledger entry shows the shell reachable. | Integration owner (flag — lanes may not enable one) + owner decision to demote Watch (`travel-buddy-standalone/app/media-world/index.tsx:8#demoting the old surface (demotion is a later, deliberate step).`). |
| MD2 | **W** | The live ranker's boost layer is per-creator (`artifacts/api-server/src/services/ranking/MediaFeedRankingService.ts:12#activeCreatorBoost  (MEDIA_ACTIVE_CREATOR_BOOST_ENABLED)`). Not a client file. | The shipped ordering carries no creator-identity boost, or the World shell is what ships (F1). | Lane C (ranker) + integration owner. |
| MD3 | **W** | The paging feed is the shipped default; the shell has none. | F1, as MD1. | As MD1. |
| MD29 | **W** | The dashboard is built; it is not the default page. | F1, as MD1. | As MD1. |
| MD87 | **W** | Inside the shell every open is now an entry context — this pass closed the last generic open, NOW's "Changing now" cards (mC58/mC59). The viewer a user reaches is still the shipped `/media-viewer/[id]` from the Watch feed. | F1, and Watch-feed opens routed through an entry context rather than the paging player. | Integration owner + owner decision (Watch is the shipped surface). |
| MD286 | **W** | Vertical autoplay is the seeded default (`artifacts/api-server/src/migrations/2037_media_tab_flags.sql:17#'MEDIA_VIEW_MODE_FULLSCREEN_ENABLED',`, seeded true). | That seed off or the default not `'watch'`, evidenced by the seed row and the store default. | Integration owner + owner decision. |
| MD408 | **W** | The shipped overlay renders Stamp/comment/save counts as its primary rail (`travel-buddy-standalone/src/components/media/WatchItemOverlay.tsx:416#formatCompactCount(item.stampItCount!)`). Removing them changes the LIVE surface, which is a product decision, not a lane's. | The count rail no longer primary on the shipped overlay, or F1. | Owner decision, then the client lane. |
| MD412 | **W** | Compass is a primary control in the dark rail and absent from the shipped overlay. | Compass primary on the surface that ships, or F1. | Owner decision + client lane. |
| MD419 | **W** | F2 — the forbidden feed is built and is the default. | The full-screen paging feed is not the seeded default mode. | Integration owner + owner decision. |
| MD424 | **W** | F2 — Stamp is the first and largest control on the default surface. | The Stamp/count rail is not the primary overlay. | Owner decision + client lane. |
| MD425 | **W** | F2 — advancing the feed is the play control (`travel-buddy-standalone/src/components/media/WatchVideoCell.tsx:158#shouldPlay={isActive}`). | Autoplay-on-viewability is not the primary navigation of the default surface. | Owner decision + client lane. |
| MD427 | **W** | F2 — opening the tab lands in the full-screen feed. | The tab opens on a context-first surface. | Integration owner + owner decision. |
| MD428 | **W** | The sheet is right and its content is not §47's. `GET /media/world` emits no `whyThis` at all, so the shell now offers "Why this?" ONLY where the server supplied a reason (`travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:139#if (item.whyThis) setWhy({ visible: true, explanation: item.whyThis });`) — the sheet's generic fallback sentence was an invented explanation. | A §47 explanation on World items built from the five named reasons, two of which (MD184, MD185) are not ranking inputs today. The client already renders it the moment it is served. | Lane C (ranking + explanation), then nothing further here. |
| MD82–MD85 | **N** ×4 | No column stores a vantage (`artifacts/api-server/src/services/media/MediaPerspectiveService.ts:6#There is no perspective COLUMN in the schema today`). The contribution sheet built here offers NO vantage on purpose (`travel-buddy-standalone/src/features/media/state/mediaContribution.ts:16#What it deliberately does NOT offer: the §12 physical VANTAGES`) — a choice with nowhere to be stored would be dropped on the floor. | A migration adds a vantage column with a CHECK over the §12 vocabularies, the post write accepts it, `MediaPerspectiveService` groups by it, and the sheet offers it. | Owner (schema), Lane B (grouping), the posts-route owner (write), then this lane (picker). |
| MD444 | **W** | Phase 4's perspective GROUPS are MD82–MD85. | As MD82–MD85. | As MD82–MD85. |
| MD288 | **W** | Askable (city + term + the gem kind), but "near" is city-coarse by design (`artifacts/api-server/src/services/media/MediaSearchService.ts:71#search is city-coarse; the canonical Map owns proximity`), and the Map that owns proximity is dark in production. | Search accepts a radius resolved through the canonical Map, OR the owner rules that city-coarse satisfies "near". | Owner decision; else the server search owner + Map lane. |
| MD289 | **W** | Askable as category + "Right now"; nothing models "looks social". | A perspective-level social/busy-looking signal exists and search filters on it. | Owner decision (what counts as "looks social" is a classifier choice) + Lane B. |

Not taken, although in sections this lane could take: **MD402** (§46 — the
minutes-watched objective is wired into the ranker, Lane C's file) and **MD403**
(`X`, measured contrast on a device — runtime QA no branch can supply).

### 19.7 Files changed, citations repointed, and this census left STALE

**Commits** (branch `claude/media-lane-a-client-ia-20260926`): `3c4b6890f`
(server: §38 events/trips by name; gem image), `f9ade196c` (client IA),
`028d6e38d` (§4 Contribution), `9c66cf39b` (search: city criterion, search
within a trip), `8fc360695` (route registry moved to the array end), `2ea4827ef`
(MD287/MD292 tests), `99ce7b11a` (changing-now place opener), and the commit
carrying this section.

**Outside the lane's file list, each minimal and additive:**
`travel-buddy-standalone/src/navigation/portavaRoutes.ts` (four route entries,
appended at the END — first inserted mid-array, which moved
line 2038 of `portavaRoutes.ts`, which `intel-spine-liveness.md` cites by anchor;
`check:doc-citations` went red, and the move is what fixed it);
`artifacts/api-server/src/services/media/MediaSearchService.ts` and
`MediaGemStateService.ts` (appended at EOF / declaration-merged, so no anchored
line moved); `artifacts/api-server/src/routes/mediaWorld.ts` (two lines edited in
place, one import appended).

**Four pointers in EARLIER rows were repointed in place** — the only edits to
earlier text, each because this pass's own line shifts broke it, each anchored
now: row MD89's pointer to line 69 of `MediaWorldShell.tsx` (it had become a `*/`, which
`check:citation-targets` counts as dead) → the same line it named,
`travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:74#kind: 'place',`;
the §39 summary row's and MD302's pointer to its line 97 →
`travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:102#cachedAsOfLabel(ageMinutesFrom(world.generatedAt))`;
MD13's pointer to lines 170 and 213 of `MediaPlacesScreen.tsx` → the time and map branches,
`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:223#{mode === 'time' ? (` and
`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:228#) : mode === 'map' ? (`. Rows this section SUPERSEDES (MD15, MD25, MD35,
MD405, MD449, MD14, MD31, MD32) keep their historical pointers: they describe
the tree they were graded against, and the live statement is here.

**This census is left STALE.** `check:census-freshness` names **44 counted
files** changed and not acknowledged — every one of them a file this section
built or edited under `travel-buddy-standalone/src/features/media/` (screens,
components, hooks, services, state, types and `__tests__`). This lane was
instructed not to write the acknowledgement, and the honest acknowledgement
would in any case not be *"cannot have moved a verdict"*: these files moved
twenty-nine of them.

### 19.8 Guard results, verbatim

```
check:census-integrity   — exit 1, by instruction (this section does not restate the headline):
  ::error::census-media.md: its stated headline is C 301 / W 81 / N 66 / X 2 but its own rows
  count C 329 / W 69 / N 50 / X 2. Both sum to 450, so this is not an arithmetic slip …
  (the only ::error:: line in the run; 450 rows parsed, 0 counted where the tool cannot read)
check:doc-citations      — RESULT clean (anchored 6568; UNANCHORED 6317, ceiling 6434)
check:citation-targets   — ✓ at the ceiling: 166 / 166.
check:citation-symbols   — 0 name a symbol the cited file does not contain (ceiling 0),
                           34 point more than 2 line(s) from it (ceiling 34) — PASSED
check:census-row-move-labels — PASSED
check:census-policy-citations — PASSED
check:census-scope-coverage  — PASSED; census-media 157 cited · 151 watched · 96% (floor 96%),
                           at its floor, so no scope was widened
check:test-registration  — 1462 registered + 33 allowlisted = 1495 — OK
check:census-freshness   — census-media.md STALE: 44 counted files not named (§19.7)
api-server tsc --noEmit  — clean; typecheck:tests 863 diagnostics / 115 files = baseline
client tsc --noEmit      — clean; test-typecheck 173 / 60 = baseline
client node tests        — 6827 / 6827 pass
client media component suites (jest) — 13 suites, 87 / 87 pass
api-server targeted      — mediaWorldProjection + mediaGemStateLens: all pass except
  "MD367 — is registered (401/403, not 404)", which answers 503 in an environment with
  no service client and fails identically at bae9ea2d4
check:write-path-columns / check:schema-references — NOT RUN: they need live credentials
```

The integrity failure is the expected one: the row counts moved and the
headline did not, because four lanes are moving rows in parallel and the
headline must be restated ONCE, from the merged rows, by whoever merges them.
Restating it here would publish a partition that is already stale the moment
the next lane lands.

### 19.9 Found outside this lane — reported, not fixed

1. **MD369 (`N`) is stale.** Its evidence says *"No attachment endpoint"*;
   `artifacts/api-server/src/routes/mediaActions.ts:8#POST /api/media/:id/attachments`
   now documents one in Lane C's file. Whether it is `C` or still pointless
   under the dark canonical flag (§15.4) is Lane C's re-read to make.
2. **The client action-rail mapper narrows away the §28 edge.**
   `src/features/media/services/mediaActions.ts` coerces an unknown entity kind
   (including `shared_moment`) to `media`. This lane's context sheet does not
   use it for that reason (`mapContextRefs` keeps the edge); the rail itself
   still loses it. Lane C's file.
3. **MD324 (`services/mediaSearch.ts`, Lane D).** A typed client of
   `GET /api/media/search` now exists — `fetchMediaSearch` in
   `services/mediaProjection.ts` — so MD324 is blocked only on its NAME and
   location, which is Lane D's call.
4. **The old client `fetchGems` dropped every gem the server sent** (its mapper
   expected a feed shape). Fixed in-lane (mC2); recorded because MD360's `C`
   was, for the client, a lens that could never show a gem.

### 19.10 The least flattering true thing about this pass

Twenty-eight rows moved to `C` and not one of them is reachable by a user
today. The shell is dark, the Map positions nothing in production, and the
four new routes are deep links nobody is sent to. This is exactly the shape §1
permits and §9.10 put to the owner as a question that has not been answered:
under this document's convention these are `C`; under the owner's honesty rule
they are `C` over a path nothing reaches. The number that describes what a
traveller can do with Media today did not change at all in this pass, and the
twelve rows that would change it — MD1, MD2, MD3, MD29, MD87, MD286, MD408,
MD412, MD419, MD424, MD425, MD427 — are all waiting on one decision that is not
a lane's to take.

---

## 20. The canonical asset read, served and enforced; §36 made the stored vocabulary; thirteen rows left with a named owner — 2026-09-26

| | |
|---|---|
| **Measured at** | `bae9ea2d4` (`claude/sensing-completion-20260925`), the base of this lane. The document's `head_commit` row (§0) is **not** moved: this section re-reads and builds 31 rows, not 450. |
| **What this section is** | Lane B of four parallel lanes finishing Media: §6–§11, §33, §36, §41, §43, §48 and §49 phase 5. The lane's 31 non-`C` rows are every non-`C` row in those sections except MD348, MD356 and MD435, which are the ranker's (§14.4 F9) and belong to the actions/ranking lane. |
| **Verdict semantics** | A verdict here is a CONSTRUCTION verdict, exactly as §1 defines it ("Flag-dark is a deployment fact, not a verdict") and as §3 applied it to storage absent from production. The owner's rule is to report implementation completion and production verification separately, so §20.5 states, for every row this section moves, what keeps it out of production and who removes that. **None of the 18 rows moved here is production-realized.** Built on branch is not merged; merged is not deployed; deployed is not flag enabled; flag enabled is not realized. |
| **Headline** | Not restated here, by instruction — the integrator restates it once after the four lanes merge. `check:census-integrity` therefore FAILS on this branch by construction (§20.7): the rows now count differently from §15.7's table. |

### 20.1 Re-read before building — five statements the tree had already falsified

Each was checked against the object, not the sentence.

- **MD43 "nothing reads it" is false at this head.** The byte path consults the override: `artifacts/api-server/src/lib/mediaAccess.ts:533#if (!(await authorizeMediaAttachment(` asks lib/mediaVisibility before any post-media object is signed, and `artifacts/api-server/src/test/mediaAccess.test.ts:798#it("a private attachment override denies a non-owner a public post's media"` proves it (mutation §20.MB1 below turns it red). It arrived with the Replit port (#508). What was still true: two of the seven values were resolved WRONG (§20.2, the MD43 row), and the projection a viewer is shown did not consult it at all.
- **MD369 "No attachment endpoint" is false.** `artifacts/api-server/src/routes/mediaActions.ts:224#"/media/:id/attachments",` has existed since #508. What was missing was any test that drives it: the suite only asserted the route is registered. §20.2 adds the HTTP-level proof.
- **MD41 "shared_moment … [has] none" is false.** `artifacts/api-server/src/routes/sharedMoments.ts:262#entityType: "shared_moment",` writes it.
- **MD255 "The real enum is three values" is stale.** Production's `post_visibility` carries a fourth, `followers_only` (`artifacts/api-server/baseline/20260819_baseline_structure.sql:365#'followers_only'`), and `artifacts/api-server/src/lib/postVisibility.ts:44#export const READABLE_VISIBILITIES` reads it. Four of §33's six audiences exist at post level; `following` and `shared_moment` do not. The row stays **W** on that narrower ground (§20.6).
- **MD370's §11.6 blocker is stale.** `hidden_gem_contributions` is in production (`artifacts/api-server/baseline/20260922_production_tables.txt:250#hidden_gem_contributions`). The row still does not move — gem contributions carry no media, so that table was never what a media contribution would write (§20.6).

### 20.2 What was built

| Rows | What was built, and where |
| --- | --- |
| MD36 · MD339 · MD429 | **The canonical asset is on the read path.** `artifacts/api-server/src/services/media/MediaProjectionService.ts:679#rows = await prepareCanonicalRows(sc, viewer, rows);` — the first step of the one funnel every World-shell builder uses — runs `artifacts/api-server/src/services/media/MediaProjectionService.ts:1683#export async function prepareCanonicalRows(`, which calls `attachCanonicalMedia` (gated by `media_canonical_read_enabled`, off in both databases; the header that said the reader was "called from nowhere, and that is a real gap" is rewritten). The canonical read now selects the whole §6 contract and the attachment's override (`artifacts/api-server/src/lib/media/mediaCanonicalRead.ts:219#is_cover, visibility_override, media_assets(`), and `artifacts/api-server/src/lib/media/mediaAssetContract.ts:102#export interface MediaAsset {` is §6 as one typed shape, produced by `artifacts/api-server/src/lib/media/mediaAssetContract.ts:164#export function toMediaAsset(row: unknown)`, which reads legacy moderation values in §36 terms and an unknown stored audience as `private`. |
| MD43 | **The override binds the SERVED item, not only the bytes, and means what it says.** `artifacts/api-server/src/lib/mediaVisibility.ts:81#export async function mayViewUnderOverride(` is now the ONE audience rule, used by the byte path and by `prepareCanonicalRows`. Two semantic defects fixed: `inherit` DENIED every non-owner (`artifacts/api-server/src/lib/mediaVisibility.ts:93#case "inherit":` — an explicit "same as the post" attachment was owner-only), and `shared_moment` resolved as TRIP CREW; it is now the Moment's accepted members through an APPROVED contribution (`artifacts/api-server/src/lib/mediaVisibility.ts:175#async function isSharedMomentAudience(`). A withheld attachment also clears the row's legacy branches (`artifacts/api-server/src/services/media/MediaProjectionService.ts:1724#out.push({ ...row, canonical_media: kept, post_media: [], media_urls: [] });`), because `post_media` can hold the very file the override just withheld. Migration 3320 CHECKs the override to NULL, `inherit` or a §33 audience (`artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql:111#ADD CONSTRAINT media_attachments_visibility_override_check`). |
| MD38 | **`version` is an aggregate version.** Migration 3320's trigger (`artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql:144#CREATE TRIGGER media_assets_version_bump`) sets `NEW.version = OLD.version + 1` on every UPDATE, whoever issues it, and overrides a rewind. `artifacts/api-server/src/lib/mediaAssets.ts:991#export async function casUpdateMediaAsset(` is the compare-and-set every read-modify-write uses — the provenance edit path (`artifacts/api-server/src/lib/mediaAssets.ts:671#const written = await casUpdateMediaAsset(sc, assetId, row.version, {`), retried with a re-read by `artifacts/api-server/src/lib/mediaAssets.ts:1021#export async function recordMediaEditWithRetry(` so a raced edit is recorded AFTER the other instead of erasing it, and the moderation service (MD351). |
| MD41 | Migration 3320 CHECKs `media_attachments.entity_type` to the §6.1 nine (`artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql:99#ADD CONSTRAINT media_attachments_entity_type_check`) — the table itself, for every writer, not only the ones that go through `artifacts/api-server/src/lib/mediaAssets.ts:718#export const ATTACHMENT_ENTITY_TYPES = [`. |
| MD44 | **The post joins its file's ONE asset.** `artifacts/api-server/src/lib/mediaAssets.ts:1071#export async function recordPostMediaAttachments(`, called from post creation (`artifacts/api-server/src/routes/posts.ts:679#void recordPostMediaAttachments(msc,`), links each storage-backed file to the post by `recordEntityMedia`, which REUSES the asset at that storage key and now refuses a key someone else owns (`artifacts/api-server/src/lib/mediaAssets.ts:846#if ((existing as any).owner_user_id !== input.ownerUserId) return NONE;`) and refuses rather than forks on an unreadable lookup. Gated on `media_canonical_enabled` AND the schema probe, so it cannot write where the canonical writer cannot. The postcard, memory, gem and Moment paths already attached; the post — the object most files are uploaded for — did not. |
| MD57 · MD60 · MD343 | **Every served media object carries the §8 provenance layer.** `artifacts/api-server/src/lib/media/mediaProvenanceLayer.ts:109#export function buildProvenanceLayer(` — source, capture clock, edit lineage by §35 class (never the parameters), §10 location basis and confidence, §36 moderation, and the Trust flags already projected — attached at `artifacts/api-server/src/lib/media/mediaProjection.ts:352#...projectionLayers(row, media, nowMs),`. A canonical item carries the asset's DECLARED provenance; a legacy item says `basis: "legacy"` / `sourceType: "undeclared"` rather than inventing one, and 0191's default `user` is served as `undeclared` because it records the absence of a declaration. The location half is withheld whenever the choke point hides the location (`artifacts/api-server/src/lib/media/mediaProjection.ts:396#withholdLocation(p.provenance)`). By responsibility (§41, merged modules as MD341 already allows) the MediaProvenanceService is: capture (`artifacts/api-server/src/lib/mediaAssets.ts:361#const provenance = initProvenance({`), lineage (the CAS edit path above), classification (lib/media/mediaEvidenceEligibility) and serving (the layer). |
| MD73 | **locationConfidence distinguishes how the place was established.** `artifacts/api-server/src/lib/media/mediaEvidenceEligibility.ts:255#export function locationBasisFromPost(` reads only the post's `location_source` enum and the two booleans the SERVER decides (`location_verified`, `geotag_verified`) — never a coordinate — and `artifacts/api-server/src/lib/media/mediaEvidenceEligibility.ts:238#export const LOCATION_CONFIDENCE_BY_BASIS` scores verified GPS 0.9, GPS 0.7, a typed place 0.3, none 0.2 (the old `hasLocation` values are the `gps` and `none` rungs, so older rows read identically). The projection selects those three post columns (`artifacts/api-server/src/lib/media/mediaProjection.ts:42#location_source, location_verified, geotag_verified`); the basis is folded into the §10 evaluation at READ, per (asset, post) pair, and never written onto the asset — the same file tagged by a GPS fix in one post and a typed venue in another is not equally well located. |
| MD75 · MD76 · MD78 | **The operational lifetime is stamped, enforced and served.** `artifacts/api-server/src/lib/media/mediaEvidenceEligibility.ts:419#export const INTELLIGENCE_OPERATIONAL_WINDOW_MS = RECENT_WINDOW_MS;` — capture + 24 h, the instant `freshnessClass` turns `historical`, stamped by `artifacts/api-server/src/lib/media/mediaEvidenceEligibility.ts:426#export function operationalExpiresAt(` on ELIGIBLE assets only. It is enforced where a current claim's evidence is decided (`artifacts/api-server/src/lib/media/mediaEvidenceLink.ts:265#if (isOperationalEvidenceAt(a, now)) return true;`), while `eligible` itself stays time-independent because PresenceVerifier asks it about receipts inside historical observation windows. `artifacts/api-server/src/lib/media/mediaTemporalState.ts:45#export interface MediaTemporalState {` is §11's contract, resolved by `artifacts/api-server/src/lib/media/mediaTemporalState.ts:71#export function resolveMediaTemporalState(` and served on every projection (`artifacts/api-server/src/lib/media/mediaProjection.ts:100#export interface MediaProjection extends MediaProjectionLayers {`). The earlier design note — "intel expiry belongs to the observation/claim" — conflated two expiries: a claim's TTL (Live Intelligence's, untouched) and the moment a photograph stops being a picture of "now" (Media's). |
| MD274 · MD351 | **§36 is the stored vocabulary, and a service owns it.** Migration 3321 makes `processing` the default (`artifacts/api-server/src/migrations/3321_media_moderation_canonical_state.sql:73#ALTER COLUMN moderation_status SET DEFAULT 'processing';`) and stores a legacy spelling as its §36 meaning on any INSERT or UPDATE (`artifacts/api-server/src/migrations/3321_media_moderation_canonical_state.sql:95#CREATE TRIGGER media_assets_canonical_moderation`) — additive: no row rewritten, no CHECK tightened, and it REFUSES a database with the legacy-only CHECK (`artifacts/api-server/src/migrations/3321_media_moderation_canonical_state.sql:63#media_assets_moderation_status_canonical_check is absent`), i.e. production until MEDIA_CANONICAL_FLAG. `artifacts/api-server/src/services/media/MediaModerationService.ts:122#export async function applyCanonicalModerationDecision(` carries an admin decision to the file's canonical row as a compare-and-set, under the transition table (`artifacts/api-server/src/services/media/MediaModerationService.ts:86#export function canTransition(`; `owner_deleted` is terminal: `artifacts/api-server/src/services/media/MediaModerationService.ts:83#owner_deleted: [],`). The admin route calls it for a status flip (`artifacts/api-server/src/routes/adminMedia.ts:880#canonicalOutcome = await applyCanonicalModerationDecision(sc, {`) and a delete (`artifacts/api-server/src/routes/adminMedia.ts:841#canonical: await applyCanonicalModerationDecision(sc,`), reports the outcome and logs at error when a RESTRICTIVE decision failed to land. Before this, a rejected upload was rejected in `post_media` and `processing` — served — in `media_assets`. |
| (readers) | Two one-line reader alignments in other lanes' files, without which §36 could not go live safely: the Wall's quick-media deny set now blocks `limited` (`artifacts/api-server/src/services/wall/WallCandidateLoaders.ts:1158#"flagged", "limited",` — a flag is STORED as `limited` once 3321 lands, and 2250 already admitted the value), and Telegraph's media loader accepts `active` beside `approved` for a non-owner (`artifacts/api-server/src/services/telegraph/shareables.ts:941#r.moderation_status !== "active"`). |
| MD369 | No code change to the route (it is the actions lane's file). The proof it lacked: `artifacts/api-server/src/test/mediaCanonicalLayers.test.ts:740#describe("MD369` drives it over HTTP — both halves owned, one probe-safe `not_found` for either failing, no success reported for a write that did not happen, the §6.1 fields carried, an audience outside §33 refused. |

Proof suites: `artifacts/api-server/src/test/mediaCanonicalLayers.test.ts:194#describe("MD75` and the groups that follow it (46 cases), `artifacts/api-server/src/test/mediaModerationCanonical.test.ts:86#describe("MD274` (16 cases), and the PostgreSQL suite `artifacts/api-server/src/test/db/mediaCanonicalContract.db.test.ts:56#describe("census-media §20` (7 cases) — all registered in the package `test` script. Both migrations were executed on a private throwaway PostgreSQL, applied twice (idempotent), rolled back and re-applied; the whole chain was then replayed into a FRESH database (312 applied in order, 12 known-unreplayable — unchanged) and all 131 cases of `scripts/local-db/run-tests.sh` passed on it.

### 20.3 Mutations, and what each turned red

Every mutation was applied, run, and reverted; after each batch `git status` showed no source file changed, i.e. every mutated file was restored byte-for-byte. Two mutations SURVIVED on the first run; both are reported, and the test that was weaker than its name was strengthened and the mutation re-run.

| Mutation | What it did | What went red |
| --- | --- | --- |
| §20.M1 | `operationalExpiresAt` returns nothing | "an ELIGIBLE asset expires exactly INTELLIGENCE_OPERATIONAL_WINDOW_MS after capture", "isOperationalEvidenceAt: true inside the lifetime…", "the evidence READ side refuses an expired asset…", "resolves intelligenceExpiresAt…", "MD78 — a canonical camera capture is SERVED with its intelligence lifetime", and mediaEvidenceEligibility's "exposes the full §10 object" |
| §20.M2 | evidence read side back to `isEvidenceEligible` (ignores expiry) | "the evidence READ side refuses an expired asset and accepts a fresh one" |
| §20.M3 | classifier ignores `locationBasis` | "the classifier gives the two a DIFFERENT scalar", "a stored basis survives the provenance round trip" |
| §20.M4 | `gps` never promoted to `verified_gps` | "derives the basis from the post's own server-decided columns", the canonical provenance case, the withholding case |
| §20.M5 | projection never uses the canonical provenance | 4 red, incl. "canonical: declared source, capture clock, lineage counts…" and "read flag ON: the projection serves the CANONICAL asset and its provenance" |
| §20.M6 | location basis not withheld under a hidden tier | "the location half is WITHHELD when the choke point hides the location" |
| §20.M7 | temporal state trusts an ineligible asset's stale `expiresAt` | "resolves intelligenceExpiresAt from an eligible asset only" |
| §20.M8 | `prepareCanonicalRows` never calls the canonical read | 4 red, incl. "read flag ON: the projection serves the CANONICAL asset" |
| §20.M9 | a denied override is kept | "a PRIVATE attachment withholds the item from a non-owner…", "a narrowed attachment next to an open one serves the open one" |
| §20.M10 | legacy branches not cleared on a withheld attachment | **SURVIVED** first (0 red). Added "when the only surviving canonical asset is not servable, the item is DROPPED — never served from post_media"; re-run: red |
| §20.M10b | a fully withheld item falls through to the legacy store | "a PRIVATE attachment withholds the item…" |
| §20.M11 | `inherit` denies again | "inherit narrows NOTHING", "the byte path (authorizeMediaAttachment) uses the same rule" |
| §20.M12 | `shared_moment` resolved as trip crew (the old behaviour) | "shared_moment is the MOMENT's accepted members, through an APPROVED contribution" |
| §20.M13 | a pending contribution admitted | the same case |
| §20.M14 | compare-and-set drops its version filter | "writes version+1 filtered on the version it read…", "a lost race is re-read and re-applied, so BOTH edits survive" |
| §20.M15 | a zero-row update read as written | the same two |
| §20.M16 | no retry on a lost race | "…BOTH edits survive in the §35 lineage" |
| §20.M17 | post attachments skip the schema probe | "writes NOTHING where the canonical writer cannot (production today: flag on, schema missing)" |
| §20.M18 | a storage key someone else owns is accepted | "refuses to attach a storage key someone else owns" |
| §20.M19 | the existing asset is ignored (a second asset row per object) | 3 red, incl. the pre-existing foundation case "flag ON, asset already exists: reuses it" and "…reusing the upload's asset — no second asset row" |
| §20.M20 | legacy moderation values not mapped to §36 | 4 red, incl. "maps every §6 member" |
| §20.M21 | an unknown stored audience read as `inherit` | "an unknown stored visibility is read as private (fail-closed)" |
| §20.MB1 | lib/mediaAccess 3a stops consulting the override | mediaAccess.test "a private attachment override denies a non-owner a public post's media" |
| §20.MA1 | the attachment route skips asset ownership | "someone else's asset, or someone else's entity, is one probe-safe not_found" |
| §20.MA2 | the attachment route skips entity ownership | the same case |
| §20.MA3 | the attachment route reports success for a write that did not happen | "with the canonical layer off it reports not_found, never a success it did not write" |
| §20.MA4 | the attachment route drops `visibility_override` | "links an owned asset to an owned entity, carrying the §6.1 fields" |
| §20.MM1 | `owner_deleted` may become `active` | 3 red, incl. the route case "approve on an owner-deleted file…" |
| §20.MM2 | a flag lands as `rejected` | 3 red, incl. "flag: the canonical asset is §36 'limited'" |
| §20.MM3 | moderation service skips the schema probe | "writes nothing where the §36 CHECK does not exist (production today)" |
| §20.MM4 | no re-read after a lost race | "re-reads and re-decides after losing the race" |
| §20.MM5 | `limited` counted distributable | "distribution: processing and active only" |
| §20.MM6 | the admin route never calls the service | 4 route cases |
| §20.MM7 | the Wall stops blocking `limited` | "a §36 'limited' asset never reaches the Quick Media row" |
| §20.MM8 | Telegraph stops accepting `active` | "a public §36 'active' asset is shareable to a non-owner" |
| §20.D1 | 3320 without `observation` in the entity CHECK | the migration's own postcondition REFUSED it; with the postcondition bypassed (§20.D1b), "MD41 — every §6.1 entity type is admitted" |
| §20.D2 | trigger freezes the version | "version moves on EVERY update…", "a compare-and-set on a STALE version matches zero rows" |
| §20.D2b | trigger never created | postcondition REFUSED; bypassed (§20.D2c): "version moves on EVERY update" |
| §20.D3 | override CHECK admits `friends_only` | "visibility_override holds NULL, inherit or a §33 audience" |
| §20.D4 | asset visibility CHECK admits `friends` | "media_assets.visibility holds inherit or a §33 audience" |
| §20.D5 | entity CHECK admits `story` | "MD41 — every §6.1 entity type is admitted, and nothing else is" |
| §20.D6 | 3321 does not normalise `flagged` | "MD274 (3321) — the default is §36 and a legacy spelling is STORED as its §36 meaning" |
| §20.D7 | 3321 leaves the default `pending` | postcondition REFUSED. Bypassed (§20.D7b): **SURVIVED** first — the normalising trigger masks the default on INSERT. The case now asserts the DECLARED default; re-run: red |
| §20.D8 | 3321's trigger fires on INSERT only | the MD274 case |

3321's precondition was also executed against a simulated production (the 0191 legacy-only CHECK): it RAISED, and the transaction left the database untouched.

### 20.4 Row moves

| Row | Was | Now | What was built |
| --- | --- | --- | --- |
| MD36 | **W** | **C** | The canonical asset is on the projection's read path (`prepareCanonicalRows` → `attachCanonicalMedia`), read as the §6 contract (`toMediaAsset`), with `visibility` CHECKed (3320) and `version` a real aggregate version. §20.M8, §20.M20, §20.M21, §20.D4 red. |
| MD38 | **W** | **C** | 3320's version trigger plus `casUpdateMediaAsset`, used by the provenance edit path (with re-read retry) and the moderation service. §20.D2, §20.D2c, §20.M14–M16, §20.MM4 red. |
| MD41 | **W** | **C** | The §6.1 nine are CHECKed by the table itself (3320). §20.D1b, §20.D5 red. The `observation` value's writer is the evidence seam, dark by owner decision — graded on MD53/MD65, not a third time here. |
| MD43 | **W** | **C** | The override is read and enforced on the bytes (pre-existing, now mutation-proved) AND on the served item, by one rule with `inherit` and `shared_moment` corrected, and CHECKed (3320). §20.MB1, §20.M9, §20.M10, §20.M10b, §20.M11–M13, §20.D3 red. |
| MD44 | **W** | **C** | A post now joins its file's one asset; reuse by storage key, cross-owner refusal, one `media_assets` row per file with attachments fanning out. §20.M17–M19 red; the DB case proves one file row, three objects. |
| MD57 | **W** | **C** | The §8 provenance layer is on every served media object, canonical or honestly legacy, with the location half withheld under a hidden tier. §20.M4–M6, §20.M20 red. |
| MD60 | **W** | **C** | PROVENANCE is computed at capture, appended under compare-and-set, stored, re-read and served. §20.M5, §20.M14–M16 red. |
| MD73 | **W** | **C** | `LocationBasis` from the post's own server-decided columns; four rungs; folded in at read per (asset, post). §20.M3, §20.M4 red. |
| MD75 | **N** | **C** | `expiresAt` = capture + 24 h on an eligible asset, enforced at the evidence read side. §20.M1, §20.M2 red. |
| MD76 | **N** | **C** | `MediaTemporalState` exists, is resolved, and is served on every projection; its three lifetimes are independent by construction (a generative edit ends the intelligence one and nothing else — tested). §20.M1, §20.M7 red. The two members with no producer are graded on MD77 / MD79, which stay open. |
| MD78 | **N** | **C** | `intelligenceExpiresAt` produced from the asset's own operational expiry and served. §20.M1, §20.M5, §20.M7 red. |
| MD274 | **W** | **C** | 3321: §36 default and a trigger that stores every legacy spelling as its §36 meaning; the moderation service writes §36 values; the two readers that could not read them were aligned. §20.D6–D8, §20.MM1, §20.MM2, §20.MM5, §20.MM7, §20.MM8 red. |
| MD338 | **W** | **C** | By responsibility: write (schema-guarded), versioned edit, attach, the post link, lifecycle (MediaLifecycleService), contract and read. Its W was "cannot act under the flag" — a deployment fact under §1, and §20.5 states it. |
| MD339 | **W** | **C** | Attachments are written by six callers and the endpoint, CHECKed by the table, read by the canonical read, the Wall and the byte path. Its W was "reads rows the write side cannot create" — the write side now exists for the post, and cannot create rows in production only because of MEDIA_CANONICAL_FLAG (§20.5). *(Reason corrected in §23.2: production's writer is off by `media_canonical_enabled = FALSE`; the columns are there.)* |
| MD343 | **W** | **C** | By responsibility (capture, lineage under CAS, classification, serving); its W was "no served object has provenance", which is no longer true. §20.M5, §20.M16 red. |
| MD351 | **W** | **C** | `MediaModerationService` owns the §36 transition table, the decision→state mapping, the distribution predicate and the decision's reach into the canonical store; the admin route goes through it. §20.MM1–MM6 red. **Contested against F12, deliberately:** F12 binds MD351 to "a classifier with a hold state". The classifier is §36's Safety-moderation STAGE, MD269, which stays **W**; keeping the §41 SERVICE open on the same missing classifier would grade one absence twice. §9.2's reason for this row — "there is no such module" — is what was built against. |
| MD369 | **N** | **C** | The endpoint existed (re-read, §20.1); it is now proved over HTTP. §20.MA1–MA4 red. |
| MD429 | **W** | **C** | Media owns the asset (MD36), the provenance (MD57/MD343) and the presentation. |

This section's moves: 14 `W → C` and 4 `N → C`. No row moved backward.

### 20.5 Production verification — stated separately, per the owner's rule

**P1** — `media_canonical_enabled` is TRUE in production while migration 2250/2470's columns are absent (`artifacts/api-server/src/lib/mediaAssets.ts:15#media_canonical_enabled = TRUE`), so the schema-capability guard refuses every canonical write there. Removing it is the owner decision `docs/architecture/migration-disposition-ledger.md:154#MEDIA_CANONICAL_FLAG` (take the flag down and apply 2250, or apply 2470 under the live flag). **P2** — `media_canonical_read_enabled` is FALSE in portava-ci and absent in production (`artifacts/api-server/src/lib/media/mediaCanonicalRead.ts:162#export const MEDIA_CANONICAL_READ_FLAG`); turning it on is an operator act gated on that file's B1–B5 (2250 applied, the writer seen landing a row, a dimension sweep, coverage measured, rollback by flag). **P3** — `MEDIA_WORLD_SHELL_ENABLED` is seeded false (§14.4 F1), so no user reaches a World projection. **P4** — migrations 3320 and 3321 are applied NOWHERE; the integrator applies them to portava-ci after review, and 3321 refuses production until P1. *(Corrected in §23.2 against production's catalog: 2470's columns are present there and `media_canonical_enabled` reads FALSE, so P1 is the flag, not the schema. 3321's precondition would pass on production. 3320 and 3321 are now applied to portava-ci.)*

| Row | Implementation | What keeps it out of production — RED WHEN it is realized | WHO |
| --- | --- | --- | --- |
| MD36 | complete on branch | a production World projection serves a `media_assets` row as the §6 contract: needs P1, P2, a backfill, P3 | owner (P1), operator (P2, backfill), integration owner (P3) |
| MD38 | complete on branch | the production `media_assets` trigger exists and a lost race is refused there: needs P4 | integrator (CI), owner (production) |
| MD41 | complete on branch | production refuses a tenth entity type: needs P4 | integrator, owner |
| MD43 | complete on branch; bytes path already live in code | an override narrows a production item: needs an attachment row to exist, i.e. P1 (no asset can be written), then P2/P3 for the projection half | owner, operator |
| MD44 | complete on branch | a production post is linked to its asset: needs P1 (writes are schema-gated); legacy stores stay authoritative until a backfill and P2 | owner, operator |
| MD57 | complete on branch | a production World item carries the layer: P3; canonical fidelity needs P1, P2 | integration owner, owner, operator |
| MD60 | complete on branch | provenance is stored for a production upload: P1 | owner |
| MD73 | complete on branch | served in production: P3 (no other dependency — it reads columns production has) | integration owner |
| MD75 | complete on branch | an expired asset is refused as evidence in production: needs the evidence seam live (`media_evidence_enabled` + a writer of `intel_evidence.media_asset_id`, i.e. MD65) and P1 | owner |
| MD76 | complete on branch | served: P3; a non-empty state needs an eligible canonical asset, P1 + P2 | integration owner, owner, operator |
| MD78 | complete on branch | as MD76 | as MD76 |
| MD274 | complete on branch | production stores only §36 values: P4 after P1 | owner, integrator |
| MD338 | complete on branch | the service acts in production: P1 | owner |
| MD339 | complete on branch | production gains attachment rows: P1 | owner |
| MD343 | complete on branch | as MD57 / MD60 | as those |
| MD351 | complete on branch | a production admin decision reaches `media_assets`: P1 (the service refuses the schema otherwise) | owner |
| MD369 | complete on branch | the endpoint writes in production: an asset must exist, P1; in portava-ci the flag row is absent, so it answers `not_found` there too | owner, operator (CI flag) |
| MD429 | complete on branch | as MD36 / MD57 | as those |

### 20.6 Rows that stay open — RED WHEN and WHO

| Row | Verdict | RED WHEN — what must become true | WHO, and why this lane cannot supply it |
| --- | --- | --- | --- |
| MD37 | **W** | every `media_assets` write carries one of the eight §6 sources; today the upload writer passes none and 0191's default fills `user` (`artifacts/api-server/src/migrations/0191_media_assets.sql:28#DEFAULT 'user'`) | OWNER / spec: the eight values have no member for "user upload, source undeclared", and mapping undeclared onto `library` would RAISE evidence eligibility (`artifacts/api-server/src/lib/media/mediaEvidenceEligibility.ts:85#EVIDENCE_ELIGIBLE_SOURCE_TYPES`) — a protection change. Then the upload/capture client lane: the upload route receives bytes and a Content-Type only, so camera-vs-library must be declared at capture. |
| MD53 | **W** | a served media object (or the §7 graph) carries an observation ref for media that backs one | OWNER first: nothing writes `intel_evidence.media_asset_id` or an `observation` attachment — `artifacts/api-server/src/lib/media/mediaEvidenceLink.ts:119#export async function linkMediaEvidence(` has no production caller for the three reasons in `docs/map/media-evidence-seam-state-20260903.md:43#Why there is nowhere honest to call it from` (a claim type a photo can back; a map-side upload producing an asset; the wiring). Then the Map lane (capture surface). A reader over rows nothing writes would be §9.4's vacuous C. |
| MD58 | **W** | the served item carries evidence role, corroboration and observation refs (expiration now IS served — MD78) | OWNER: the observation half cannot exist before media becomes observations (MD65); building the other halves would not move the row. |
| MD63 | **N** | any module derives an evidence candidate from pixel or frame content | OWNER: a vision / scene-analysis provider (sending user photographs to a model is a provider, cost and data-protection decision) and, for video, the decode tier (§14.4 F11). A pixel heuristic written to fill the stage would manufacture exactly what §9 forbids: VISUAL INFERENCE ≠ VERIFIED FACT. |
| MD65 | **W** | a media path writes `intel_observations` | OWNER, as a recorded SAFETY decision: media as an intelligence contribution needs consent, contributor identity under 3002's rotating tokens, and a claim vocabulary. The seam's boundary — it never writes observations — is a deliberate protection, not a gap a lane may close. |
| MD66 | **W** | a claim has a media input | follows MD65 |
| MD71 | **W** | `freshnessClass` can be `live` | OWNER / spec: §5 and F6 judge the cap SAFER than the spec, and "live" belongs to Live Intelligence. The only honest `live` would be derived from a currently-live claim the asset backs — which needs MD65. |
| MD77 | **N** | a §6.1 media item can carry a social expiry that takes it off social surfaces and keeps it for its owner | OWNER / product: no §6.1 object has a social lifetime (posts, postcards, memories and gems are permanent; stories expire but are not §6.1 entities). The §11 member is declared and honestly absent (`artifacts/api-server/src/lib/media/mediaTemporalState.ts:45#export interface MediaTemporalState {`). Then the composer lane. |
| MD79 | **W** | a published item's location disclosure can END — a non-owner stops seeing the place after `locationDisclosureExpiresAt` | OWNER / product: the policy (owner-set per post, or a default window, and the tier it falls to). Then this lane (a posts column read through a schema guard — the projection SELECT may not name a column production lacks) and the feed lane (the Watch feed selects its own columns). |
| MD255 | **W** | a user can publish media to `following` or `shared_moment` through the reachable composer. Post level has four of the six (§20.1); the attachment level has all six, CHECKed and enforced on bytes and projection — canonical-only | OWNER: where the audience lives — extend `post_visibility` (every post reader in Wall, Pulse, Discovery and Media must fail closed on the new values; note `lib/mediaEligibility`'s following-feed branch admits an unrecognised value today, `artifacts/api-server/src/lib/mediaEligibility.ts:404#if (visibility === "private") return false;`, so it must be closed first) or make the attachment override the composer's audience control (composer lane + feed lane). |
| MD269 | **W** | a safety decision — an automated classifier, or a staffed review — stands between upload and distribution; today `processing` is distributable (`artifacts/api-server/src/services/media/MediaModerationService.ts:96#export function isDistributableModerationState(`) | OWNER (moderation provider) or OPERATOR (a staffed hold). The state machine (MD274) and the service (MD351) are now in place to receive the decision. |
| MD370 | **W** | `POST /media/:id/contribution` writes a contribution distinct from an intent | OWNER: what a media contribution creates (a §19 mission answer, a §16.3 gem observation, a place perspective) is media → intelligence, MD65's decision; then the client screen MD28. |
| MD445 | **W** | Phase 5's second half: qualification → observations/claims | follows MD65 |

### 20.7 Guards, and the one that fails on purpose

`npx tsc --noEmit -p tsconfig.json` clean. `typecheck:tests` 863 / 115 — at baseline, not above. `check:doc-citations`, `check:citation-targets` (166 / 166, not above the ceiling), `check:citation-symbols`, `check:census-row-move-labels`, `check:census-policy-citations`, `check:census-scope-coverage`, `check:test-registration`, `check:flag-polarity`, `check:migration-prefixes`, `check:data-rights`, `check:not-null-writes`, `check:silent-supabase-writes`, `check:enum-literals`, `check:writerless-reads`: pass. **`check:census-integrity` FAILS** on this branch: this census has no prose gap (450 parsed = 450 stated), so its last headline must equal its rows, and §15.7's table no longer does. The integrator restates it once, from the parser, after the four lanes merge. **`check:census-freshness` reports this census STALE** — correctly: ten counted files changed here and the acknowledgement ledger is not this lane's to write. `check:write-path-columns` and `check:schema-references` need live credentials and were NOT run.

**Every edit to a file this census does not assign to this lane**, each one line and zero-shift: `services/wall/WallCandidateLoaders.ts` (`limited` blocked) and `services/telegraph/shareables.ts` (`active` accepted) — both needed so §36 could go live without opening the Wall or closing Telegraph; and `routes/mediaActions.ts` was MUTATED (§20.MA1–MA4) but not edited. No anchored citation in any census moved; `check:doc-citations` held throughout.

### 20.8 Found outside this lane — reported, not fixed

1. **MD273's cited list was incomplete.** Its evidence names the Wall's `QUICK_MEDIA_BLOCKED_MODERATION` as "the moderation states that must never reach a social surface" — and that set omitted `limited`, which 2250 made admissible. Latent (nothing wrote `limited`) until a §36 decision could; fixed here in one line because 3321 would have made it live.
2. **`filterPostMedia` in routes/posts.ts** still denies only `rejected` and `flagged`. Inert today — `post_media`'s CHECK admits the legacy four only, in both databases — but it is the lax twin of §9.3's deny-list and should follow it if that CHECK is ever widened.
3. **The freshness acknowledgement mechanism silences later edits to a file an older entry already names.** `MediaProjectionService.ts`, `routes/posts.ts` and `WallCandidateLoaders.ts` changed here and do not appear in the STALE list, because an earlier acknowledgement — arguing a different change — covers them. The integrator should not read their absence as harmlessness.
4. **A pinned assertion of the declined design** — `mediaEvidenceEligibility.test.ts` asserted `expiresAt === undefined`. It was updated with the reason in the file, and it is named here because changing a test's expectation is the edit a reviewer should look at first.

### 20.9 The least flattering true thing about this section

**Eighteen letters moved and not one of them is true in production.** Every moved row sits behind at least one of four things this lane may not do: an unmade owner decision about migration 2250, a read flag an operator has not turned, a shell flag seeded false, or two migrations nobody has applied. That is the §1 convention working as written — and it is also exactly the shape the owner warned about, which is why §20.5 lists the missing step for each row instead of letting a C stand for itself. A reader who adopts §12.8's "a flag-dark row is not a realized row" should read §20.4 as fourteen rows that remain W and four that remain N, with their code finished.

Second, and narrower: **two of the moves are judgement calls against this document's own register** — MD351 against F12, and MD41 against F5's "plus writers for … observation" — each argued in its row. If the integrator rejects either argument, the row goes back with its code intact and nothing else changes.

### 20.10 Integration — the two contested moves ruled on, and the headline restated from the rows

Merged into `claude/sensing-completion-20260925` on 2026-09-26 by the
integration owner, after reading the lane's diff, not its summary.

**MD351 against F12: accepted.** The row's requirement is the §41 module
`MediaModerationService`, and §9.2's reason for W was that "there is no such
module". It now exists and the admin route goes through it. F12's missing
classifier is §36's moderation STAGE, which MD269 grades and which stays
**W**. What turns MD351 red again: the admin route writing moderation state
around the service, or the service losing the compare-and-set on the
canonical row (§20.MM1–MM6 are the tripwires).

**MD41 against F5: accepted.** The row's requirement is that `entityType`
covers the nine §6.1 values, and 3320's CHECK now enforces exactly those
nine. The `observation` writer is the dark evidence seam, graded on MD53 and
MD65, both still **W**. What turns MD41 red again: a tenth value admitted, or
one of the nine refused (§20.D1b, §20.D5).

**Reviewed before merging, because they widen or reach outside the lane:**
the override rule's `inherit` now allows the parent's audience, and both of
its callers apply the parent post's own visibility before asking, so it
narrows and never widens; the new post-route attachment write catches every
error and stops at the schema probe wherever the canonical columns are
absent, which includes production today; the Wall's deny-set gains
`limited` and Telegraph accepts §36's `active`, each one line.

**3320 and 3321 are applied nowhere**, not to `portava-ci` and not to
production. 3321 refuses a database that lacks 2250/2470's widened CHECK,
which is production's state.

> | Measure | Was, §15.7 | Now |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 301 | **319** |
> | BUILT-BUT-WRONG | 81 | **67** |
> | NOT-BUILT | 66 | **62** |
> | CANNOT-VERIFY | 2 | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | 84.9 % | **386 / 450 = 85.8 %** |
> | **CORRECT%** (raw) = C/450 | 66.9 % | **319 / 450 = 70.9 %** |
>
> Restated from `check:census-integrity`, not by hand, after lane B only.
> The spec-attributable figure is not re-derived here. **None of the eighteen
> moved rows is realised in production** (§20.5).

---

## 21. Media actions, the §24 ranker, the outcome signals and the gem outcome — 2026-09-26

Lane C of the four-lane Media pass (branch `claude/media-lane-c-20260926`, from
`bae9ea2d4`). Forty-six rows were assigned: §15 actions, §16.1 duplicate check
and outcome, §22 crowd flow, §23 chains, §24 inputs and objectives, §25 Trip
Expertise, §26 impact metrics, §44 telemetry, §45 north-star transitions, §48
ownership and §49 phase 6. **36 move to `C`, 2 move `N → W`, 8 stay open**, each
open row with a falsifier and a named owner below. No other non-`C` row in §15–§17,
§20, §22–§26, §31–§32, §44–§45 or §49 phase 6 was found unowned; the census body
was re-parsed with last-statement-wins to establish that, rather than read.

Two statuses are kept apart throughout, because the owner's rule requires it:
**IMPLEMENTATION** (built on this branch, tested, and the test seen red under a
mutation) and **PRODUCTION** (what a user of the deployed app would see today).
Every row moved here is an implementation claim. §21.5 states the production
state of each, and for most of them it is *dark*: built on branch is not merged,
merged is not deployed, deployed is not flag-enabled, flag-enabled is not realised.

No migration was written. No flag was enabled or seeded. No database was touched.

### 21.1 What was built

**A. The §42 Media Ranking stage, over every §24 input and objective.** The World
shell had no ranking stage (MD356) and the only ranker multiplied by watch time
(MD348). The stage is `artifacts/api-server/src/services/media/MediaRankingService.ts:281#export async function rankCandidatesForViewer(`, called from the projection pipeline at
`artifacts/api-server/src/services/media/MediaProjectionService.ts:656#await rankCandidatesForViewer(sc, viewer, candidates, {` and from both branches of the experience resolver. Every §24 input and
objective is mapped at `artifacts/api-server/src/services/media/MediaRankingService.ts:149#export const SPEC_24_COVERAGE`, and the test parses the seventeen inputs and
eight objectives **out of the spec text itself**, so a mapping cannot quietly
drop one. Weights are at `artifacts/api-server/src/services/media/MediaRankingService.ts:111#export const MEDIA_RANKING_WEIGHTS = {`: positive terms sum to 1, none exceeds
0.12, and "− Low-confidence Live Claims" is subtracted at `artifacts/api-server/src/services/media/MediaRankingService.ts:210#score += key === "lowConfidenceLive" ? -w * t[key] : w * t[key];`. The terms
are pure functions in `lib/mediaRankingSignals.ts`: provenance class
`artifacts/api-server/src/lib/mediaRankingSignals.ts:190#export function provenanceClassOf(` and its score `artifacts/api-server/src/lib/mediaRankingSignals.ts:225#export function provenanceTerm(`; media quality from the FILE's own
resolution, aspect and duration, never from watch fields, `artifacts/api-server/src/lib/mediaRankingSignals.ts:264#export function mediaQualityOf(`; viewer
intent generalised from the wanted item to its place and category `artifacts/api-server/src/lib/mediaRankingSignals.ts:299#export function intentTerm(`;
trip context `artifacts/api-server/src/lib/mediaRankingSignals.ts:324#export function tripContextTerm(`; live state `artifacts/api-server/src/lib/mediaRankingSignals.ts:415#export function liveTerm(` and its low-confidence penalty
`artifacts/api-server/src/lib/mediaRankingSignals.ts:425#export function lowConfidenceLiveTerm(`; expected real-world utility as the media's own smoothed §45
outcome rate `artifacts/api-server/src/lib/mediaRankingSignals.ts:480#export function utilityTerm(`; experience fit `artifacts/api-server/src/lib/mediaRankingSignals.ts:500#export function experienceFitTerm(`; useful social connection
(trip crew / Shared Moment, not follow proximity) `artifacts/api-server/src/lib/mediaRankingSignals.ts:522#export function usefulSocialTerm(`; contribution value
as marginal coverage `artifacts/api-server/src/lib/mediaRankingSignals.ts:543#export function contributionTerm(`; narrative value `artifacts/api-server/src/lib/mediaRankingSignals.ts:564#export function narrativeTerm(`. The signals are
loaded once per page by `artifacts/api-server/src/services/ranking/MediaRankingSignalLoader.ts:115#export async function loadMediaRankingSignals(` — the viewer's own wants
`artifacts/api-server/src/services/ranking/MediaRankingSignalLoader.ts:137#.from("media_intent_signals")`, the §45 outcome vocabulary `artifacts/api-server/src/services/ranking/MediaRankingSignalLoader.ts:70#export const UTILITY_OUTCOME_EVENTS` — and every read that
fails settles to `null`, which the ranker treats as *undetermined* and never as
*zero*. §2's "authentic outranks generated" is a PARTITION after scoring, not a
weight a large enough score could beat: `artifacts/api-server/src/services/media/MediaRankingService.ts:262#const demoted = output.filter((e) => e.score.provenanceClass === "synthetic");`. The ranked order now
reaches the client: the place view's per-group sample was the twelve NEWEST and is
now the ranker's twelve, re-sorted for display only after selection,
`artifacts/api-server/src/services/media/MediaPerspectiveService.ts:176#media: items.slice(0, samplePerGroup)`. Tests: `src/test/mediaRankingObjectives.test.ts` (37 cases),
`src/test/mediaWorldProjection.test.ts`.

**B. §25 Trip Expertise, a fourth reputation dimension.** `artifacts/api-server/src/lib/mediaContributorReputation.ts:139#export function tripExpertise(`, fed by
`artifacts/api-server/src/services/media/MediaContributorReputationService.ts:164#export async function readJourneySignals(`, which counts only ENDED, non-cancelled trips the contributor owns or
is an accepted member of AND whose owner made them public with the destination
shown, `artifacts/api-server/src/services/media/MediaContributorReputationService.ts:196#if (t.visibility !== "public" || t.show_destination_city !== true) continue;`. A private or hidden-destination journey cannot raise a
reputation, and a failed read lowers the dimension to zero rather than inflating
it. Test: `src/test/mediaContributorTripExpertise.test.ts` (7 cases).

**C. The §15 actions the rail was missing, each to an EXISTING endpoint and offered
only when the viewer passes that endpoint's own question (§47).**
Go There `artifacts/api-server/src/services/media/MediaActionResolver.ts:1036#id: "directions",` → the Places page's `directionsUrl`; View Event `artifacts/api-server/src/services/media/MediaActionResolver.ts:1093#id: "view_event",`,
gated by the experience resolver returning an EVENT the viewer may see; View in
Passport `artifacts/api-server/src/services/media/MediaActionResolver.ts:1158#id: "view_passport",` → the Postcard viewer, only for an active Postcard the
Passport wall would show this viewer; Share through Telegraph now targets
Telegraph's own §5 share contract `artifacts/api-server/src/services/media/MediaActionResolver.ts:461#endpoint: "/api/threads/:threadId/share"` instead of the media share recorder;
Do This Experience is marked compilable `artifacts/api-server/src/services/media/MediaActionResolver.ts:621#compile: true, source: "experience"` (and from a published Trail
`artifacts/api-server/src/services/media/MediaActionResolver.ts:1200#compile: true, source: "trail"`) and the plan route serves the timed, executable plan
`artifacts/api-server/src/routes/mediaActions.ts:478#compileExperiencePlan(sc, viewer`; Find somewhere quieter / cheaper `artifacts/api-server/src/services/media/MediaActionResolver.ts:1049#id: "find_quieter",` → Compass with the
comparator axis Compass grounds; Update this gem `artifacts/api-server/src/services/media/MediaActionResolver.ts:1069#id: "contribute_gem",` → the gem's own
contribution endpoint with the media id. Server test:
`src/test/mediaActionsSection21.test.ts` (20 cases, including an HTTP route test of
the compiled plan).

The CLIENT executes them — which the server half alone did not, because the rail
renders only ids it knows and silently hid every other one (see §21.6):
`travel-buddy-standalone/src/features/media/services/mediaActions.ts:613#export async function openDirectionsForPlace(` opens directions and calls back ONLY after the maps app opened, where the
rail records Directions started and Media → Route `travel-buddy-standalone/src/features/media/components/MediaActionRail.tsx:205#void openRailDirections(exec.placeId, () => {`; the tap-time
emission skips it `travel-buddy-standalone/src/features/media/components/MediaActionRail.tsx:134#if (emitsNorthStarOnTap(action.id)) emitMediaNorthStar(record, action.id, northStarCtx);`; `travel-buddy-standalone/src/features/media/telemetry/mediaTelemetry.ts:251#export const NORTH_STAR_ON_COMPLETION`. The Telegraph share goes through
the existing share sheet as an object REFERENCE `travel-buddy-standalone/src/features/media/components/MediaActionRail.tsx:383#<TelegraphObjectShareSheet mediaId={mediaId} object={shareObject}`, `travel-buddy-standalone/src/components/ShareSheet.tsx:289#? await shareObjectIntoThread(selectedId`. Do This
Experience shows the compiled plan and writes TENTATIVE items into one trip the
user picks, only a trip the server named `travel-buddy-standalone/src/features/media/components/MediaActionPanels.tsx:114#export function TripChoicePanel({`, `travel-buddy-standalone/src/features/media/services/mediaActions.ts:714#export function planItemsFromCompiledPlan(`, `travel-buddy-standalone/src/features/media/services/mediaActions.ts:737#export async function applyCompiledPlan(`.
Save Route completes each coordinate-free stop through the canonical place record,
refuses a one-stop route, and sends `originMediaId` `travel-buddy-standalone/src/features/media/components/MediaActionRail.tsx:248#void saveRailRoute({ title: exec.title, stops: exec.stops, mediaId: exec.mediaId })`, `travel-buddy-standalone/src/features/media/services/mediaActions.ts:776#export async function saveMediaRoute(`.
Invite people `travel-buddy-standalone/src/features/media/components/MediaActionPanels.tsx:241#const ok = await inviteToSharedMoment(momentId, userId, mediaId)` and Update this gem `travel-buddy-standalone/src/features/media/components/MediaActionPanels.tsx:332#<GemContributeSection gemId={gemId} isAuthed originMediaId={mediaId} />` carry the media
id. Client test: `travel-buddy-standalone/src/features/media/__tests__/mediaActionsSection21.test.ts`
(29 cases), plus the extended `mediaActions.test.ts`.

**D. Producers for the §44/§45 names that had none.** Server-only outcome signals,
deliberately NOT forwardable by the client batch `artifacts/api-server/src/lib/mediaAnalytics.ts:226#export const MEDIA_SERVER_OUTCOME_SIGNAL_TYPES`: Contribution
submitted at the gem submission and observation routes `artifacts/api-server/src/routes/hiddenGems.ts:401#recordGemContributionSignal(sc` (and at
`routes/hiddenGems.ts` line 1144), attributed Media → Contribution only when the
media is AT the gem's place `artifacts/api-server/src/lib/mediaAnalytics.ts:316#export function recordGemContributionSignal(`; Contribution accepted, credited to the
SUBMITTER `artifacts/api-server/src/lib/mediaAnalytics.ts:344#export function recordGemAcceptedSignal(`, at `artifacts/api-server/src/routes/hiddenGems.ts:1548#recordGemAcceptedSignal(sc`; Invite sent, only for a media item that is
an approved contribution to that very Moment `artifacts/api-server/src/lib/mediaAnalytics.ts:370#export function recordMediaInviteIfAttributable(`, at `artifacts/api-server/src/routes/sharedMoments.ts:135#recordMediaInviteIfAttributable(`;
Postcard created `artifacts/api-server/src/lib/mediaAnalytics.ts:396#export function recordPostcardCreatedSignal(`, at the Postcard write `artifacts/api-server/src/routes/postcards.ts:1131#recordPostcardCreatedSignal(sc, { userId: user.id, postId });`; Experience
completed for a route saved from media `artifacts/api-server/src/lib/mediaAnalytics.ts:404#export function recordExperienceCompletionIfAttributable(`, at `artifacts/api-server/src/routes/routePlan.ts:567#recordExperienceCompletionIfAttributable(`. Arrival
"where safely measurable" is a check-in the traveller made themselves — a route
stop marked arrived `artifacts/api-server/src/routes/routePlan.ts:645#recordMediaArrivalIfAttributable(` or a GPS-verified, non-suspicious gem visit
`artifacts/api-server/src/routes/hiddenGems.ts:960#recordGemArrivalIfAttributable(sc` — recorded only when the traveller's OWN media-originated action
explains it `artifacts/api-server/src/lib/mediaAnalytics.ts:290#export function recordMediaArrivalIfAttributable(`, `artifacts/api-server/src/lib/mediaAnalytics.ts:258#export async function findMediaOrigin(`. Media → Route is recorded when a route is
saved from media `artifacts/api-server/src/routes/routePlan.ts:300#recordMediaEvent("media_route"`. The two client signals are allow-listed by spreading
`artifacts/api-server/src/lib/mediaAnalytics.ts:214#export const MEDIA_CLIENT_OUTCOME_SIGNAL_TYPES` into the batch at `artifacts/api-server/src/routes/mediaAnalyticsBatch.ts:47#...MEDIA_CLIENT_OUTCOME_SIGNAL_TYPES,`. On the client, each §44 signal is
emitted where the viewer did the thing, through `travel-buddy-standalone/src/features/media/telemetry/mediaTelemetry.ts:318#export function emitMediaSignal(` (forbidden-key
guard included) and a non-hook sender `travel-buddy-standalone/src/services/mediaInteractions.ts:156#export async function recordMediaSignal(`: Comment only on a comment the
server ACCEPTED, and only from the media comment sheet `travel-buddy-standalone/src/components/media/MediaCommentSheet.tsx:38#onCommentPosted={() => emitMediaSignal(mediaSignalRecorder, 'comment'`; Profile open
`travel-buddy-standalone/src/components/media/WatchItemOverlay.tsx:220#'profile_open'` and Place open `travel-buddy-standalone/src/components/media/WatchItemOverlay.tsx:227#'place_open'` from the Watch overlay;
Hidden Gem opened `travel-buddy-standalone/src/components/media/GemsFeed.tsx:203#'gem_open'`; Visual opportunity opened from the NOW lens's
three card kinds `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:127#'visual_opportunity_open', { surface: 'now_zone' }`. Tests: `src/test/mediaOutcomeSignals.test.ts`
(15 cases, route-level where the route could be mounted) and the client suite.

**E. §16.1 DUPLICATE CHECK and OUTCOME.** The duplicate scan was real — `artifacts/api-server/src/lib/inputAssistance/creation.ts:316#await scanDuplicateGems(`
— and ran as a gem was named on `/gems/submit` `travel-buddy-standalone/app/gems/submit.tsx:243#context: 'hidden_gem_name',`; the Media add-gem
form submitted without it. It now runs the same scan with the same pick-existing
step `travel-buddy-standalone/src/components/media/AddGemForm.tsx:135#context: 'hidden_gem_name',`, and a guard ENUMERATES every caller of `submitGem` and requires
both, so a third surface cannot skip it. The OUTCOME stage is a derived read model
over the two tables that already record VISIT and report: a verified visit is
linked to what the same visitor reported within 72 hours `artifacts/api-server/src/services/hiddenGems/HiddenGemOutcomeService.ts:83#export function linkVisitOutcomes(`, classed by the
gem state's own polarity sets, and summarised `artifacts/api-server/src/services/hiddenGems/HiddenGemOutcomeService.ts:133#export function summarizeGemOutcomes(` behind a privacy floor —
below `artifacts/api-server/src/services/hiddenGems/HiddenGemOutcomeService.ts:43#export const OUTCOME_MIN_REPORTERS = 3;` reporting visitors NO number is shown, not even the visitor
count. The gem detail carries it `artifacts/api-server/src/routes/hiddenGems.ts:786#(safe as any).visitOutcomes = await import(`; the gem page states it in one
sentence only when there is a number `travel-buddy-standalone/app/gems/[id].tsx:559#gemVisitOutcomeSentence(gem.visitOutcomes) ?`, `travel-buddy-standalone/src/services/hiddenGemsMappers.ts:95#export function gemVisitOutcomeSentence(`. Tests:
`src/test/hiddenGemOutcome.test.ts` (11 cases, route-level included) and the
client suite.

**F. `post_event_links` gets its writer.** The table is the canonical Media → Event
link and had four readers — View Event, the §24 availability term
`artifacts/api-server/src/lib/mediaRankingSignals.ts:378#export function availabilityTerm(`, the event experience's hero media, Discovery's "Live from events" —
and NO writer anywhere (`check:writerless-reads` carried it as a dead lane). The
author of an active post can now link it to a PUBLIC, open event they host,
co-host or are going to, near the post's own time — one predicate
`artifacts/api-server/src/lib/mediaEventLinks.ts:72#export async function listLinkableEvents(` both OFFERS the action `artifacts/api-server/src/services/media/MediaActionResolver.ts:1122#id: "link_event",` and ACCEPTS the write
`artifacts/api-server/src/routes/mediaActions.ts:548#"/media/:id/event-link",`, `artifacts/api-server/src/lib/mediaEventLinks.ts:140#.upsert({ post_id: postId, event_id: eventId }`. Dark behind `MEDIA_WORLD_SHELL_ENABLED`, like the rail
that offers it. The ratchet entry is struck (the entry that followed it is now at
`artifacts/api-server/src/scripts/checkWriterlessReads.ts:141#compass_user_profiles: {`). Client: `travel-buddy-standalone/src/features/media/services/mediaActions.ts:817#export async function linkMediaToEvent(`, `travel-buddy-standalone/src/features/media/components/MediaActionPanels.tsx:393#const r = await linkMediaToEvent(mediaId, eventId);`. Test:
`src/test/mediaEventLink.test.ts` (12 cases, route-level included).

### 21.2 Mutations, every one run on the final tree, and what each turned red

Every mutation below was applied to the committed tree, the named suite run, and
the file restored. The proving runs made while building (the R-, T-, A- and
S-series, 66 mutations) are not repeated here; this is the re-run the citations
above point at. **Three did not redden on their first form, and each is reported**:

1. **V24 survived** — removing `if (!origin) return;` from the completion producer
   left the suite green. The mutation, not the test, was defective: with no origin
   the next line dereferences `null`, the fire-and-forget `.catch` swallows it,
   and nothing is recorded, which is exactly what the test asserts. V24b records
   the completion with a null origin instead, and reddens.
2. **G7 survived, by design** — dropping `.eq("is_suspicious", false)` from the
   outcome read left the suite green, because the pure linker refuses suspicious
   visits itself (G1 proves that half). The query filter is a bound on rows read,
   not the privacy guarantee.
3. **Q2 survived at first** — dropping `mediaId` from the Quieter ask left the
   server suite green; the client would have fallen back to the entity ref. The
   test now asserts the ask carries the media item Compass grounds the comparator
   on, and Q2 reddens (commit `0a3abc2be`).

| Mutation | Row | What was changed | What turned red |
| --- | --- | --- | --- |
| V01 | MD8 | synthetic partition removed from the ranker | mediaRankingObjectives: "a generated asset that wins on every other term still ranks after an authentic one", "a camera capture with a generative edit is §35-altered" |
| V02 | MD188 | provenance term made constant | "orders the provenance classes authentic > third_party > unknown > non_observation > synthetic", "an OFFICIAL author does not make an asset's provenance authentic" |
| V03 | MD177 | wanted-place generalisation removed | "wanted item 1.0 > wanted place 0.8 > wanted category 0.5", "another perspective of a WANTED PLACE outranks an otherwise-identical one" |
| V04 | MD179 | trip destination city ignored | "media ON a viewer trip 1.0; in an upcoming trip's city 0.8 …" |
| V05 | MD184 | live term zeroed | "live place > no claim > low-confidence place" |
| V06 | MD201 | low-confidence live ADDED instead of subtracted | "live place > no claim > low-confidence place" |
| V07 | MD187 | resolution ignored | "resolution orders 4K > 720p > 360p", "quality reaches the SCORE" |
| V08 | MD194 | utility made constant | "a media that led to real-world action outranks one that was only watched", and the MD356 loader-only case |
| V09 | MD195 | an ended experience still fits | "the same event ENDED does not (0)" |
| V10 | MD196 | trip crew not a useful connection | "trip crew 1.0; followed AND in the viewer's trip city 0.6; followed elsewhere 0" |
| V11 | MD198 | a Postcard carries no narrative | "postcard 1.0 > event/trip experience 0.7 > substantial caption 0.4 > nothing 0" |
| V12 | MD348 | one objective unmapped | "maps every one of them, and nothing else" |
| V13 | MD356 | place sample reverts to the twelve newest | "the twelve perspectives sampled for a group are the ranker's, not the twelve newest", "a signal only the stage's LOADER reads decides the sample" |
| V14 | MD197 | coverage gap flattened | "a fresh perspective at an UNCOVERED place is worth more than the fourth at a covered one" |
| V15 | MD207 | trip expertise zeroed | mediaContributorTripExpertise: four cases |
| V16 | MD207 | private / hidden-destination journeys counted | "private, buddies, hidden-destination, cancelled and future trips do not count" |
| V17 | MD94 | directions offered with no disclosed place | mediaActionsSection21: "is NOT offered when the owner kept the exact place private", "is NOT offered for media bound to no place" |
| V18 | MD103 | View Event without the experience gate | "View Event is NOT offered for a private event the viewer does not attend — not its id either" |
| V19 | MD103 | View in Passport without the passport gate | "View Passport is NOT offered when the author's passport is private" |
| V20 | MD104 | share target reverted to the media share recorder | "targets POST /api/threads/:threadId/share with a POST reference" |
| V21 | MD107 | plan route never compiles | "returns timed stops for a trail, and 404 for a draft one" |
| V22 | MD107 | trip experience not marked compilable | "a trip experience targets the compiled-plan endpoint" |
| V23 | MD214 · MD399 | another viewer's media action explains an arrival | mediaOutcomeSignals: "another viewer's action, an old action, and a non-origin event attribute nothing" |
| V24 | MD382 | origin check removed (null dereference) | **survived** — see above |
| V24b | MD382 | completion recorded with a null origin | "records experience_complete for a route saved from media, not for any other route" |
| V25 | MD383 | acceptance recorded as a submission | "an accepted gem is credited to its SUBMITTER, not the approving admin" |
| V26 | MD400 | media elsewhere credited with the gem contribution | "media_contribution only for media AT the gem's place" |
| V27 | MD381 | unapproved media credited with the invite | "records invite_sent only when the media is an APPROVED contribution to the Moment" |
| V28 | MD385 | the Postcard writer records nothing | "the Postcard writer calls it where the passport_postcards row is written" |
| V29 | MD374 · MD376 | batch drops the client outcome signals | "accepts visual_opportunity_open and gem_open; drops every server-only outcome name" |
| V30 | MD396 | a media-saved route records the wrong transition | "the other committed-outcome producers sit on the success path of their routes" |
| C1 | MD94 | client resolves directions to nothing | client §21: "MD94 directions → the place …" |
| C2 | MD213 | onOpened fires before the maps app opened | "openDirectionsForPlace: onOpened fires ONLY after the maps app opened" |
| C3 | MD213 | directions north-star on the tap | "directions is the one rail action whose north-star waits for the outcome" |
| C4 | MD213 | rail drops the tap-time guard | "Go There records media_route + directions_tap inside the opened callback only" |
| C5 | MD396 | rail never records media_route on open | same case |
| C6 | MD103 | Passport routes to the post, not the Postcard | "view_passport → the Postcard viewer" |
| C7 | MD253 | Quieter offered with no prompt | "find_quieter / find_cheaper → Compass with the server-written prompt" |
| C8 | MD104 | client ignores the object reference | "share_telegraph with an object reference → telegraph_share" |
| C9 | MD107 | client ignores the compile flag | "do_this_experience with compile:true → compiled_plan" |
| C10 | MD173 | one-stop route offered | "save_route: place stops only, two or more" |
| C11 | MD173 | route created from one resolved stop | "saveMediaRoute refuses a one-stop route" |
| C12 | MD396 | route loses its origin media | "saveMediaRoute … sends originMediaId" |
| C13 | MD107 | plan written into any trip | "applyCompiledPlan writes only into a trip the server named" |
| C14 | MD107 | items CONFIRMED, not tentative | "planItemsFromCompiledPlan: ordered, TENTATIVE" |
| C15 | MD104 | one share-sheet path sends a snapshot | "Telegraph share sends an object reference …" |
| C16 | MD381 | invite sent without origin | "services forward originMediaId" |
| C17 · C18 | MD400 | contribution sent without origin (service; gem section) | same case |
| C19 | MD387 | comment signal on a REFUSED comment | "MD387 comment: … only on a comment the server accepted" |
| C20 | MD387 | media comment sheet emits nothing | same case |
| C21 | MD393 | profile open emits nothing | "profile_open / place_open … gem_open … visual_opportunity_open are emitted where the viewer opens them" |
| C22 | MD376 | gem open emits nothing | same case |
| C23 | MD374 | for-you card emits nothing | same case |
| C24 | MD376 | the SERVER stops accepting gem_open | "every name is one the batch endpoint accepts" |
| C25 | MD209 · MD393 | a signal payload key the server drops | "payload keys are all on the server payload allow-list" |
| C26 · C27 | MD107 | compile not requested; untimed stops accepted | "fetchCompiledExperiencePlan asks for compile=1"; mapper cases |
| C28 | MD94 | iOS handed Google Maps | "pickDirectionsUrl", "openDirectionsForPlace" |
| C29 | MD381 | invite loses the media ref | "invite_people / contribute_gem carry the media id" |
| C30 | MD209 | a place opened from the overlay records nothing | the emitters case |
| D1 · D2 | MD112 | Media add-gem renders no pick-existing step; scans another context | "every gem submission surface runs the §16.1 duplicate check" |
| D3 | MD112 | `/gems/submit` loses its scan | same case — the guard enumerates, it does not name |
| D4 | MD112 | server stops scanning `hidden_gems` for a gem name | inputAssistanceCreation: 7 cases |
| G1–G6, G8–G11 | MD120 | suspicious visit counted; report before visit / after window / by someone else linked; floor removed; floor leaks the visitor count; unreadable read as zero; detail omits it; negative observations downgraded; reports counted per report | hiddenGemOutcome: the named case each time |
| G7 | MD120 | query-level suspicious filter dropped | **survived by design** — see above |
| H1–H4 | MD120 | sentence below the floor; page renders nothing; mapping drops it; garbage counts accepted | client §21: "the gem page states what verified visitors found" |
| E1–E12 | MD103 | private / cancelled / far-off event linkable; any post linkable; write skips the predicate; refused write reads as linked; offer ignores authorship / the flag / an existing link; endpoint ignores the flag; any RSVP counts; unreadable participation reads as none | mediaEventLink or mediaActionsSection21: the named case each time |
| E13 · E14 | MD103 | client link row with no candidates; rail does not re-read after linking | client §21 link cases |
| Q1 | MD253 | Compass grounds "quieter" on the price claim | compassCensusClosure: B2, B4 and one more |
| Q2 | MD253 | the Quieter ask loses its media id | **survived at first**; red after the test was strengthened |
| Q3 | MD253 | Quieter / Cheaper offered with Compass off | "absent when Compass is off, and absent with no anchor place" |

Q1 was run against the Compass lane's own suite and the file restored; no file
that lane owns was edited.

### 21.3 Row moves

| Row | Was | Now | Why — built, cited above, tested, and the mutation that turned it red |
| --- | --- | --- | --- |
| MD8 | **N** | **C** | Generated and generatively-altered media are partitioned after every authentic item, whatever they score — §21.1 A. V01. |
| MD94 | **W** | **C** | Go There is a `directions` action to the Places page's own `directionsUrl`, executed by the client — §21.1 C. V17, C1, C28. |
| MD103 | **W** | **C** | View Event (gated on an event the viewer may see, now reachable because `post_event_links` has a writer) and View in Passport (the Postcard) — §21.1 C, F. V18, V19, C6, E1–E14. |
| MD104 | **W** | **C** | Share through Telegraph targets Telegraph's §5 share contract and the client sends a revocable object reference into a picked thread — §21.1 C. V20, C8, C15. |
| MD107 | **W** | **C** | Do This Experience compiles a trip, event or published Trail into a timed plan and writes tentative items into one eligible trip — §21.1 C. V21, V22, C9, C13, C14, C26, C27. |
| MD112 | **W** | **C** | The §16.1 duplicate check runs on every gem submission surface, before the submit, with a merge-or-create step — §21.1 E. D1–D4. |
| MD120 | **N** | **C** | A verified visit is linked to the visitor's report and served, floored, on the gem — §21.1 E. G1–G6, G8–G11, H1–H4. |
| MD173 | **W** | **C** | The client call site the row named: each chain stop is completed through the canonical place record before `POST /route-plans` — §21.1 C. C10–C12. |
| MD177 | **N** | **C** | `media_intent_signals` is a ranking input, generalised to the wanted place and category — §21.1 A. V03. |
| MD179 | **N** | **C** | Trip context scores the viewer's own trip and the destination of a trip not yet over — §21.1 A. V04. |
| MD184 | **N** | **C** | A live-qualified claim, read through the gated fail-closed read, is a ranking input — §21.1 A. V05. |
| MD187 | **W** | **C** | Quality is the file's resolution, aspect and duration fit; watch fields cannot move it — §21.1 A. V07. |
| MD188 | **W** | **C** | Asset provenance is scored separately from author trust — §21.1 A. V02. |
| MD194 | **W** | **C** | Expected utility is the media's own smoothed §45 outcome rate, not a per-kind constant — §21.1 A. V08. |
| MD195 | **N** | **C** | Experience fit: an over experience scores 0; one where the viewer is going or wants to go, 1 — §21.1 A. V09. |
| MD196 | **N** | **C** | Useful connection is trip crew / Shared Moment, then followed-and-where-you-are-going; not follow proximity — §21.1 A. V10. |
| MD198 | **N** | **C** | Narrative value: Postcard > experience > substantial caption — §21.1 A. V11. |
| MD201 | **N** | **C** | A low-confidence or materially conflicted live claim is SUBTRACTED — §21.1 A. V06. |
| MD207 | **N** | **C** | Trip Expertise is a fourth dimension, from public completed journeys only — §21.1 B. V15, V16. |
| MD209 | **W** | **C** | Both producers the falsifier named now exist: `save` (server, §11.4) and `place_open` (the Watch overlay, where a place is opened from media). The save event carries the media id; the place is its canonical place. C30. |
| MD213 | **W** | **C** | Directions started is recorded when the maps app OPENED, never on the tap — §21.1 C, D. C2–C5. |
| MD214 | **N** | **C** | Arrival where safely measurable: a check-in the traveller made, explained by their own media action — §21.1 D. V23. |
| MD253 | **N** | **C** | THE RE-READ §9 AND §14 NAMED AND DID NOT PERFORM. "Find a quieter or cheaper version": Compass grounds both axes `artifacts/api-server/src/compass/CompassMediaContext.ts:81#export const COMPARATOR_AXIS_CLAIM` (census-compass CM-03), and the rail now ASKS it from the media item, carrying the media id and the axis — §21.1 C. Q1–Q3, C7. |
| MD348 | **W** | **C** | The World-shell ranker is §24's: every input and objective mapped, read from the spec text, every named weight live — §21.1 A. V12. |
| MD356 | **N** | **C** | A ranking stage sits between projection and client, and its order survives to the client — §21.1 A. V13. |
| MD374 | **N** | **C** | Visual opportunity opened is a name the batch accepts and the NOW lens emits — §21.1 D. V29, C23. |
| MD376 | **N** | **C** | Hidden Gem opened, the same — §21.1 D. V29, C22, C24. |
| MD378 | **W** | **C** | Directions started — as MD213. C2–C5. |
| MD381 | **N** | **C** | Invite sent, recorded by the invite route for an invite sent from the Moment's own media, and the client can now send one — §21.1 C, D. V27, C16, C29. |
| MD382 | **N** | **C** | Experience completed: a route saved from media, completed — §21.1 D. V24b. |
| MD383 | **W** | **C** | Contribution submitted (gem submission and observation) and accepted (credited to the submitter) — §21.1 D. V25. |
| MD387 | **W** | **C** | Comment, emitted from the media comment sheet only, only for an accepted comment; the generic post surfaces do not emit it (§11.6's objection) — §21.1 D. C19, C20. |
| MD393 | **W** | **C** | Profile open, from the Watch overlay, carrying the contributor's pseudonymous id on a key the server keeps — §21.1 D. C21, C25. |
| MD396 | **N** | **C** | Media → Route: directions opened from the rail, and a route saved from media — §21.1 C, D. V30, C5, C12. |
| MD399 | **N** | **C** | Media → Real-World Arrival — as MD214. V23. |
| MD400 | **N** | **C** | Media → Contribution, only for media AT the gem's place, from an action the rail offers — §21.1 C, D. V26, C17 · C18. |
| MD197 | **N** | **W** | Contribution Value is built as MARGINAL COVERAGE `artifacts/api-server/src/lib/mediaRankingSignals.ts:543#export function contributionTerm(` (V14), which is what the objective scores. §14.4's falsifier named a reputation call site in the ranker, and that is NOT built, deliberately: see §21.4. The row is half-met, not met. |
| MD385 | **N** | **W** | Postcard created has a producer (V28). Memory created has none, and cannot have one honestly: see §21.4. |

**Totals, re-derived by `check:census-integrity` rather than asserted:** 36 rows to
`C` (20 from `N`, 16 from `W`), 2 rows `N → W`.

### 21.4 Rows that stay open — what would turn each red, and who

| Row | Verdict | RED WHEN | WHO |
| --- | --- | --- | --- |
| MD11 | **W** | The reachable Media surface is the one that measures outcomes: `MEDIA_WORLD_SHELL_ENABLED` seeded true AND the Media tab's default no longer `'watch'` (F1). The outcome producers and the outcome-ranked stage now exist (§21.1 A, D); the surface users reach still ranks by watch time. | Integration owner (flag) + client lane (default) — F1. |
| MD101 | **W** | A `busier` comparator axis in `artifacts/api-server/src/compass/CompassMediaContext.ts:81#export const COMPARATOR_AXIS_CLAIM` and a Find Busier rail action. Three of the four now exist (Similar, Quieter, Cheaper). §15 names Busier; §32, the Compass contract, names only "a quieter or cheaper version". | **Owner**: resolve §15 against §32. The axis file and the test that pins it at two axes belong to the Compass lane; this lane did not edit them. |
| MD162 | **N** | The NOW lens renders the gateway's `crowd_flow` objects, each endpoint NAMED and paired with that zone's recent perspectives. Two things stand in the way and neither is Media's to build: (a) a flow names its zones by `geo_zones` id only, and Media perspectives carry canonical place ids with no coordinates, so pairing them needs a place→zone association the §19 gateway does not publish (and `gatewayBypassGuard` forbids Media from deriving one server-side, rightly); (b) no flow is publishable in production: `map_crowd_flow_enabled` and `map_projection_enabled` are off, and the producer refuses below `MIN_SIGNAL_FAMILIES`. | **Owner** (whether Map publishes zone names and a place→zone association to consumers) + **production data** (a publishable flow). |
| MD175 | **N** | A defined Remix of an experience chain. The spec gives the word only (§23.1 "Actions: Follow This Night, Save Route, Add to Trip, Remix, Ask Compass"); an editable copy of the chain and a Compass-generated variation are two different products. | **Owner**: define Remix. |
| MD197 | **W** | A contributor-reputation term in the ranker, which is what §14.4 named. Not built because, since migration 3002, a contributor's intel rows are keyed by rotating tokens, and ranking a feed would resolve OTHER accounts' tokens for every author on every page — a use of the 3310 bridge it was not built for. | **Owner**: may the ranker resolve contributor tokens for authors it ranks? |
| MD215 | **W** | The counts stop dominating: the Watch ranker's watch multipliers retired or replaced by the §24 stage, and the Stamp/comment/save count rail no longer the primary overlay (F2). The §24 stage reads no social count. | Integration owner + client lane — F1/F2; the ranker half is MD435's decision. |
| MD385 | **W** | A Memory created FROM a media item records the signal. Today a Memory item stores a `media_url` and no media reference, and no §15 action makes a Memory from media, so a "memory created" event could not name the media it came from. | **Owner** (Memory lane schema): should a Memory item carry a media reference? |
| MD402 | **W** | As MD11: the surface users reach no longer optimises minutes watched, scroll depth or autoplay completion (F1/F2). | Integration owner + client lane. |
| MD435 | **W** | Media ceasing to own a second ranker, or §48 conceding it. This pass made the World-shell stage §24-complete; it did not retire the legacy Watch ranker. §42 draws a "Media Ranking" stage and §48 gives opportunity ranking to Discovery — that is a design conflict, not a bug. | **Owner**: §42 against §48. |
| MD446 | **W** | "Show Me Now" exists under some name. Go There is now built (MD94), so five of six. The spec gives the phrase only; the NOW lens's for-you strip is the nearest candidate and this pass does not decide that it is the thing. | **Owner**: define Show Me Now. |

### 21.5 Implementation against production, per family

| Family | Implementation | Production today |
| --- | --- | --- |
| §24 ranking stage (MD8, 177, 179, 184, 187, 188, 194–196, 198, 201, 348, 356) | built, tested, mutated | **Dark**: the World shell is behind `MEDIA_WORLD_SHELL_ENABLED` (seeded false). Where it were on: provenance reads `canonical_media`, absent on every projected row (F5), so every item is `unknown` and MD8's partition is inert; live claims are gated and the intel spine is empty, so MD184/MD201 are inert; `media_events` is empty while `MEDIA_ANALYTICS_ENABLED` is false, so utility sits at its prior; `media_intent_signals` is absent from the 2026-08-31 production column snapshot, so intent reads `null`. Each degrades to neutral, never to a fabricated order. |
| §15 actions (MD94, 103, 104, 107, 173, 253, 381, 400) | built, tested, mutated | **Dark**: the rail is mounted only with the World shell. Compass actions also need `COMPASS_ENABLED`; the gem action `hidden_gems_enabled`; the event link `MEDIA_WORLD_SHELL_ENABLED`. `trails` and `content_trails` are absent from the 08-31 snapshot, so the Trail branch reads nothing. |
| §44/§45 producers (MD209, 213, 214, 374, 376, 378, 381–383, 385, 387, 393, 396, 399, 400) | built, tested, mutated | **Recorded nowhere**: every producer goes through `recordMediaEvent`, which writes nothing while `MEDIA_ANALYTICS_ENABLED` is false. The client emitters on the Watch overlay, comment sheet and gems feed ARE on reachable surfaces; their events are dropped server-side by that gate. |
| MD112 duplicate check | built, tested, mutated | **Reachable once deployed**: the input-assistance endpoint has no flag, and both submission screens are routed. |
| MD120 gem outcome | built, tested, mutated | Behind `hidden_gems_enabled`; needs visits, which need `hidden_gem_verification_enabled`; and shows nothing below three reporting visitors. `hidden_gem_contributions` was absent from the 08-31 snapshot (§16 records it in the 09-22 production list). |
| MD207 Trip Expertise | built, tested, mutated | Served wherever reputation is served (`routes/mediaViewRequest.ts`); no journey counts until an owner publishes a trip with its destination shown. |

### 21.6 Findings outside this lane — reported, not fixed

1. **MD100 and MD172 were `C` on the server alone.** The client rail renders only
   ids in its own `MEDIA_ACTION_IDS` and hides the rest — the "no dead actions"
   rule. `invite_people`, `follow_this_night` and `save_route` were not in it, so
   Invite People, Follow This Night and Save Route were served and never shown,
   and `inviteToSharedMoment` had no caller anywhere in the client. This pass
   added all three to the rail (the invite panel is new); the rows are Lane A's /
   §14's to re-grade, and until the shell flag is on they remain unreachable.
2. **MD104's evidence sentence was false in the other direction.** "No Telegraph
   thread, message or intent is created on any branch" — the Watch overlay's share
   sheet has always sent a `post_card` SNAPSHOT into a chosen thread and recorded
   `target: 'telegraph'`. What was missing was Telegraph's §5 reference contract,
   which is what this pass built.
3. **`post_event_links` was a dead lane feeding Discovery.** Discovery's "Live from
   events" Path A and the event hero-media rail read it and could never return a
   row. They now can, once an author links a post (dark behind the shell flag).
   census-discovery rows resting on Path A being empty should be re-read by that
   lane.
4. **Three tables this lane reads are absent from the 2026-08-31 production
   snapshot** (`src/test/generated/liveColumns.json`): `media_intent_signals`,
   `trails`, `content_trails` (and `hidden_gem_contributions`, since shown present
   on 09-22). Every read is fail-soft to `null`; none is a write.

### 21.7 Files changed

Server — new: `lib/mediaRankingSignals.ts`, `lib/mediaEventLinks.ts`,
`services/ranking/MediaRankingSignalLoader.ts`,
`services/hiddenGems/HiddenGemOutcomeService.ts`, and the tests
`mediaRankingObjectives`, `mediaContributorTripExpertise`, `mediaActionsSection21`,
`mediaOutcomeSignals`, `hiddenGemOutcome`, `mediaEventLink` (all registered in the
curated `test` script). Modified: `services/media/MediaRankingService.ts`,
`MediaProjectionService.ts`, `MediaExperienceResolver.ts`,
`MediaPerspectiveService.ts`, `MediaActionResolver.ts`,
`MediaContributorReputationService.ts`, `lib/mediaContributorReputation.ts`,
`lib/mediaAnalytics.ts`, `routes/mediaActions.ts`, `routes/mediaAnalyticsBatch.ts`,
`routes/routePlan.ts`, `routes/hiddenGems.ts`, `routes/sharedMoments.ts`,
`routes/postcards.ts`, `scripts/checkWriterlessReads.ts` (one ratchet entry
struck), `package.json`, `src/test/mediaWorldProjection.test.ts`. Guard
machinery, each edit the one its guard asked for: `scripts/check-flag-polarity.mjs`
classifies `MEDIA_WORLD_SHELL_ENABLED` as a CAPABILITY now that the API reads it,
and drops its app-tree-only entry, whose history moved into the reason;
`src/scripts/checkCensusFreshness.ts` widens this census's scope by the twenty
paths §21 cites and grades, which `check:census-scope-coverage` required (87% →
98% against a 96% floor).

**Watched by census-sensing, and kept to same-line, additive edits:**
`routes/hiddenGems.ts` (six same-line edits and one five-line insertion in the
admin verify handler; no anchored citation into the file moved, per
`check:doc-citations`) and
`services/media/MediaProjectionService.ts` (the ranker call, line-neutral).

Client — new: `features/media/components/MediaActionPanels.tsx`,
`features/media/__tests__/mediaActionsSection21.test.ts`. Modified:
`features/media/components/MediaActionRail.tsx` (line-neutral above the §11.3.3
anchor), `features/media/services/mediaActions.ts`,
`features/media/types/mediaActions.ts`, `features/media/telemetry/mediaTelemetry.ts`,
`features/media/screens/MediaWorldShell.tsx`, `features/media/__tests__/mediaActions.test.ts`,
`hooks/useMediaAnalytics.ts` (line-neutral), `services/mediaInteractions.ts`,
`services/hiddenGems.ts` (line-neutral above its anchored line),
`services/hiddenGemsMappers.ts`, `services/sharedMoments.ts`,
`services/routePlan.ts`, `components/ShareSheet.tsx`,
`components/CommentsSheet.tsx`, `components/gems/GemContributeSection.tsx`,
`components/media/AddGemForm.tsx`, `components/media/GemsFeed.tsx`,
`components/media/MediaCommentSheet.tsx`, `components/media/WatchItemOverlay.tsx`,
`app/gems/[id].tsx`.

`check:census-freshness` names the counted files this changes for eight censuses
(media, discovery, highlights-memories, input-intelligence, layover, passport,
sensing, trust). `CENSUS_STALENESS_ACKNOWLEDGED.json` was deliberately NOT
edited; this section is the re-measurement for census-media, and the others are
their lanes' to acknowledge or re-measure. The widest single cause is
`routes/hiddenGems.ts`, counted by eight censuses: its changes are the import, the optional `originMediaId` on the
contribution schema, the four signal calls of §21.1 D and the one outcome line of
§21.1 E, none of which alters a status code, a gate or a query, and whose only
response change is the added `visitOutcomes` field.

### 21.8 The headline is not restated here, and the integrity check says so

This lane was instructed not to restate the headline: four lanes move rows in
parallel, and one restatement from the merged result is the only one that can be
right. So `check:census-integrity` reports, correctly, that the stated headline
(C 301 / W 81 / N 66 / X 2) no longer describes the rows, which after §21 count
**C 337 / W 67 / N 44 / X 2** of 450 — exactly the 36 moves to `C` and 2 moves
`N → W` above. Until the integrator restates it, that check and
`src/test/censusIntegrityQualifiedVerdicts.test.ts`, which asserts the tool
exits 0, are red on this branch for that one reason and no other.

## 22. §37 video transport, §39 offline mode and the §40 client services — 2026-09-26

Lane D of the 2026-09-26 media pass, on branch `claude/media-lane-d-20260926`
from `bae9ea2d4`. It owns the twenty-one rows of §37 (video), §39 (offline /
degraded mode) and the §40 client service modules. It moves fourteen of them
and leaves seven open, each with the thing that would move it and who can
supply that thing.

**Implementation is graded here. Production verification is not, and is stated
separately for every moved row in §22.4.** Nothing in this section is merged,
deployed or flag-enabled. Where the requirement is device behaviour — resume
after an app kill, a background transfer, a cache read with the radio off — the
proof is a test over injected fakes plus real HTTP against a fake Storage, never
a device run, and the row says so.

### 22.1 What was built

**§37 server — the container states its own duration and size.**
`artifacts/api-server/src/lib/videoProbe.ts:83#export function probeVideoContainer`
reads ISO-BMFF (`mvhd`, `mehd`, per-track `mdhd`, `moof`/`trun` fragments, the
`tkhd` display matrix) and Matroska `Info`/`Tracks`, and returns the display
size after rotation. It is total — every truncation of a real file returns a
probe or null — and refuses implausible values rather than reporting them.
The fixtures are six real ffmpeg 6.0 files (MP4 with moov-after-mdat, a
portrait clip coded 64×48 with a 90° matrix, a faststart QuickTime file, VP8
WebM, a fragmented MP4 whose `mvhd` says 0, audio-only M4A).
`POST /media/upload` probes the raw bytes
(`artifacts/api-server/src/routes/posts.ts:146#probeVideoContainer(rawBody)`),
returns the measured duration
(`artifacts/api-server/src/routes/posts.ts:284#durationSeconds: probedDurationSeconds(videoProbe)`)
and writes it onto the canonical row as `media_assets.duration_ms`, a column
with no writer on this path until now
(`artifacts/api-server/src/routes/posts.ts:273#recordMeasuredDuration(sc, assetId, videoProbe)`,
`artifacts/api-server/src/lib/mediaVideoPoster.ts:175#export async function recordMeasuredDuration(`).
The postcard `/complete` stores the measured duration and size over what the
client declared
(`artifacts/api-server/src/routes/postcards.ts:952#resolveStoredDuration(probedVideo, p.durationSeconds)`,
policy at `artifacts/api-server/src/lib/videoProbe.ts:113#export function resolveStoredDuration`).
It falls back to the declared figure only when the container states no
duration at all, and logs that case at warn.

**§37 server — a poster for every video, shown to exactly the video's audience.**
The device cuts the frame, because this server has no video decoder. The server
re-encodes it with no metadata
(`artifacts/api-server/src/lib/mediaProcessing.ts:421#export async function makeVideoPoster`)
and stores it at a path it DERIVES from the video: `<storage_path>.poster.jpg`.
There are two routes, one per upload transport:

- For a reserved postcard slot, the route is
  `artifacts/api-server/src/routes/postcardMediaTransport.ts:176#"/postcards/:id/media/:mediaId/poster"`.
  `/complete` admits no thumbnail path except that slot's own poster
  (`artifacts/api-server/src/routes/postcards.ts:949#admissiblePosterPath(storagePath, p.thumbnailPath)`)
  and writes it into the column the Watch feed reads
  (`artifacts/api-server/src/routes/postcards.ts:987#thumbnail_storage_path: poster.path`).
  Before this, `/complete` stored whatever `thumbnailPath` a client sent.
- For a general upload, the route is
  `artifacts/api-server/src/routes/mediaVideoPoster.ts:46#"/media/upload/poster"`.
  It serves only the caller's own video, only in the `/media/upload` layout,
  only within an hour of the upload
  (`artifacts/api-server/src/lib/mediaVideoPoster.ts:57#export function parseOwnVideoPath`),
  and it writes the poster once, with no swap. It records the poster on the
  owner's canonical row
  (`artifacts/api-server/src/lib/mediaVideoPoster.ts:138#export async function recordPosterOnAsset(`).
  That is the writer for `media_assets.thumbnail_path` on video which the §14.4
  register asked for. If the row has not landed yet, the miss is reported as
  `assetRecorded: false` and never claimed.

Authorization is by derivation rather than by row:
`artifacts/api-server/src/lib/mediaAccess.ts:369#return decide(sc, viewerId, bucket, posterOf)`
decides a poster exactly as the video it was cut from, and
`artifacts/api-server/src/lib/mediaAccess.ts:907#return mediaAccessDeadline(sc, viewerId, bucket, posterOf)`
gives it the video's story deadline, so a signed poster URL cannot outlive the
story. `artifacts/api-server/src/lib/mediaPosterPath.ts:41#export function derivedPosterBase`
refuses anything whose base is not a video. It also refuses anything under
the client-writable `memories/` and `stories/` prefixes (the out-of-band storage
grant `scripts/auditStagingBoundaryGrant.ts` documents), because the server
never EXIF-stripped those objects. The client sends its frame to the derived
route
(`travel-buddy-standalone/src/services/media.ts:249#extractAndUploadVideoThumbnail(media.uri, token, (body as any)?.path ?? null)`,
`travel-buddy-standalone/src/services/media/generalVideoPoster.ts:53#export async function attachVideoPoster(`).
It falls back to the previous behaviour, a plain image upload, only against an
API that lacks the route. Two helpers post to `/api/media/upload` without going
through `uploadMedia`, so their videos had no frame at all. They now attach the
poster in the background, with no image fallback, because they never had one:
stories at `travel-buddy-standalone/src/services/stories.ts:116#attachPosterInBackground(json?.path, localUri, token)`
and memories at `travel-buddy-standalone/src/services/memories.ts:313#attachPosterInBackground(json?.path, localUri, token)`. The postcard composer uploads a poster before
`/complete`
(`travel-buddy-standalone/src/components/PostcardComposer.tsx:356#await uploadVideoPoster(postId, mediaId, upload.uri)`).

**§37 — resumable, retried, queued transport (ships OFF).** On the server, the
slot is the resume token. `artifacts/api-server/src/routes/postcardMediaTransport.ts:212#"/postcards/:id/media/:mediaId/upload-session"`
lists which 4 MiB parts already landed and signs only the missing ones.
`artifacts/api-server/src/routes/postcardMediaTransport.ts:253#"/postcards/:id/media/:mediaId/upload-session/assemble"`
concatenates the parts into the slot's own object
(`artifacts/api-server/src/lib/postcardMediaTransport.ts:231#export async function assembleParts(`).
Before it does, it re-checks every part's downloaded size against the listing,
the total against the size declared at reservation, and the assembled bytes'
kind. A part of the wrong size counts as MISSING, not received
(`artifacts/api-server/src/lib/postcardMediaTransport.ts:114#export function summarizeParts(`).
On the client, `travel-buddy-standalone/src/services/media/uploadRetry.ts:85#export async function withRetry`
applies full-jitter backoff, honours `Retry-After`, retries no-answer, 408, 425,
429 and 5xx, and never retries another 4xx.
`travel-buddy-standalone/src/services/media/resumableUpload.ts:109#export async function uploadSlotResumable(`
resumes from what landed. `travel-buddy-standalone/src/services/media/postcardUploadPipeline.ts:141#export async function runPostcardUpload`
persists every stage, so a new process resumes a job without re-creating the
post.
`travel-buddy-standalone/src/services/media/postcardUploadQueue.ts:64#export class PostcardUploadQueue`
is account-scoped and stops if the account changes mid-drain. Each part is an
OS background transfer of exactly its byte range
(`travel-buddy-standalone/src/services/media/backgroundTransfer.ts:142#sessionType: mod.FileSystemSessionType.BACKGROUND,`),
and the queue is resumed on every foreground
(`travel-buddy-standalone/src/services/media/postcardUploadDevice.ts:135#export function installPostcardUploadResume`,
mounted at `travel-buddy-standalone/app/_layout.tsx:402#<MediaUploadResumeSetup />`).
The whole path is gated by a client constant that is FALSE
(`travel-buddy-standalone/src/services/media/uploadTransportFlag.ts:19#DEFAULT_ENABLED = false`).
With it off, the composer takes the pre-existing signed-PUT path. The only
changes on that path are the poster and the MD320 envelope check.

**§39 — an offline media cache that is scoped, aged, account-isolated and revocable.**
`travel-buddy-standalone/src/services/media/mediaCache.ts:228#export class MediaCache`
keeps one scope per §39 line that has a projection to cache, each with its own
TTL and cap (`travel-buddy-standalone/src/services/media/mediaCache.ts:63#export const SCOPE_POLICY`).
It evicts least-recently-read first and holds a global image byte budget.
It keys every entry by account and writes nothing without one, and it stores no
coordinate at any depth
(`travel-buddy-standalone/src/services/media/mediaCache.ts:113#export function scrubCoordinates`).
Every read re-ages the payload
(`travel-buddy-standalone/src/services/media/mediaCache.ts:137#export function decayFreshness`),
so freshness only decays and nothing reads live. A live crowd label is never
served from the cache, and neither is a §18 consensus
(`travel-buddy-standalone/src/services/media/mediaCache.ts:158#if ('consensus' in src) out.consensus = null;`).
The cache answers only on an OUTAGE. A server answer of "nothing here" deletes
the copy, and an auth failure is never covered.
The lenses read through it:

- Places: `travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:175#placeViewOffline(placeId, { signal: opts.signal })`
  over `travel-buddy-standalone/src/services/media/mediaOffline.ts:147#export function placeViewOffline(`.
- People: `travel-buddy-standalone/src/features/media/screens/MediaPeopleScreen.tsx:33#peopleOffline({ signal: opts.signal })`,
  which stores only the Trip Crew groups
  (`travel-buddy-standalone/src/services/media/mediaOffline.ts:216#export function crewSlice`).
- Experiences: `travel-buddy-standalone/src/features/media/screens/MediaExperiencesScreen.tsx:52#experiencesOffline(ids, { signal: opts.signal })`.
  A trip is filed as trip media and an event as event checkpoint visuals, and a
  mixed list is labelled by its OLDEST member.

Each lens renders the §39 "Cached · updated …" label whenever what is on screen
came from the cache, for example
`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:348#{cachedLabel ? <Text`.
Private images resolve to the cached local file only when the sign endpoint is
UNREACHABLE. A DENIAL purges the copy
(`travel-buddy-standalone/src/services/mediaUrl.ts:102#await applyOfflineCopies(unsigned, result)`).
Saved places and current or upcoming trips are cached BEFORE they are needed
(`travel-buddy-standalone/src/services/media/mediaOffline.ts:269#export async function prepareOfflineMedia`,
`travel-buddy-standalone/src/services/media/mediaOfflineDevice.ts:72#export function installMediaOfflineWarmup(`).
That warm-up is mounted only while `MEDIA_WORLD_SHELL_ENABLED` is on
(`travel-buddy-standalone/app/_layout.tsx:403#<MediaOfflineWarmupSetup />`).

**§40 services, under `travel-buddy-standalone/src/services/media/`.** They sit
beside `features/media/services/`, not inside it, because the file ownership
for this pass split those trees. §40 is judged by responsibility; the path
divergence is recorded, not hidden.

- **mediaProcessing.** `travel-buddy-standalone/src/services/media/mediaProcessing.ts:160#export async function prepareImageForUpload`
  brings a photo inside the server's envelope on the device and FAILS CLOSED
  when a required resize fails. It resizes only OUTSIDE the envelope
  (`travel-buddy-standalone/src/services/media/mediaProcessing.ts:95#export function imageUploadPlan`)
  on purpose: a re-encode on the device destroys the EXIF capture time the
  server reads for `captured_at` before it strips the metadata. So a 12 MB photo
  inside the envelope still travels whole, and that is the correct trade. The
  postcard composer consumes it
  (`travel-buddy-standalone/src/components/PostcardComposer.tsx:285#const upload = await withinServerEnvelope(asset);`).
  A drift guard pins the client envelope to the server constants it mirrors.
- **mediaPrivacy.** `travel-buddy-standalone/src/services/media/mediaPrivacy.ts:83#export const DISCLOSURE`
  is one table of what each location choice discloses to a non-author. The
  words the post composer shows
  (`travel-buddy-standalone/src/services/media/mediaPrivacy.ts:133#export function locationPrivacyHint(`),
  its choices and its request fields are all derived from that table
  (`travel-buddy-standalone/src/components/PulseCreate.tsx:700#{LOCATION_CHOICES.map(`,
  `travel-buddy-standalone/src/components/PulseCreate.tsx:713#locationPrivacyHint(locationPrivacyMode`,
  `travel-buddy-standalone/src/components/PulseCreate.tsx:432#...locationRequestFields(locationPrivacyMode, scheduledTime),`).
  `artifacts/api-server/src/test/mediaPrivacyClientParity.test.ts` runs the
  table against the server's own `mapPublicPost`,
  `locationPrivacyModeToCeiling` and the create route's default, for every
  mode. See §22.6 for what the old copy promised.
- **mediaIntelligence.** `travel-buddy-standalone/src/services/media/mediaIntelligence.ts:65#export function mapVisualConsensus`
  reads the §18 Visual Consensus the server has served on every place
  projection since 2026-09-14 (§14). The client had dropped it. The current-picture badge now
  takes its strength and count from FRESH independent witnesses
  (`travel-buddy-standalone/src/services/media/mediaIntelligence.ts:104#export function currentPictureFromConsensus(`,
  wired at `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:559#currentPictureFromConsensus(consensus`).
  Before, it counted every perspective of any age
  (`artifacts/api-server/src/services/media/MediaPerspectiveService.ts:193#independentSourceCount: countIndependentSources(media, opts.groupKeyById),`),
  so three sources from last month rendered as a strong CURRENT picture. A
  material dispute caps the badge at low. It can only lower confidence, never
  raise it. The Places lens shows "Mixed reports — conditions may be changing"
  exactly when the server says the reports disagree
  (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:249#<PictureCaveats cachedLabel={cachedLabel} consensus={view.consensus ?? null} />`,
  rendering `travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:349#{banner ? <Text`).
- **mediaCache.** The §39 module above.

### 22.2 Mutations, and what each turned red

Every implementation below was mutated and the named test seen to fail. The
harness applies one textual mutation, runs the suite, and restores the file
byte-exact. **Five mutations did NOT redden their suite on the first run. Each
is reported as a survivor, with the test that was strengthened until it did.**

| Id | Mutation | Turned red |
| --- | --- | --- |
| S1 · S5 | probe: ignore the display matrix / invert the rotation direction | "a PORTRAIT phone clip is stored at its DISPLAY size" |
| S2 · S3 | drop the fragment-sum / Matroska duration path | the fragmented-MP4 and WebM probe cases |
| S4 | treat an all-ones `mvhd` duration as a value | **SURVIVED first.** The fixture's timescale made the bogus value fall inside the plausibility bound. The test now uses 90 kHz, and "an all-ones 'unknown' mvhd duration is null — not 13 hours" is red. |
| S6 · S7 · S22 · S18 | `/complete` or `/media/upload` store/return the declared duration or size | "postcard /complete stores the MEASURED duration and size…", "POST /media/upload returns the PROBED duration…" |
| S8 · S9 | `/complete` accepts any `thumbnailPath` | "/complete REFUSES a thumbnailPath that is not this slot's poster" |
| S10 · S11 | poster authorized by row instead of by its video | "mediaAccess authorizes a poster EXACTLY as its video…" |
| S12 · S13 · S14 | wrong-sized part counted as received; assembled junk kept; every part re-signed | the three MD281 on-the-wire session tests |
| S21 | skip the post-listing size re-check at assemble | **SURVIVED first.** No test replaced a part mid-assembly. The added test "a part whose BYTES disagree with the listing … is refused" is now red. |
| S15 · S16 · S19 · S20 · S17 | poster keeps EXIF; image slot takes a poster; emergency stop ignored; non-owner accepted; delete leaves poster/parts | their named route tests |
| G1 | drop the `duration_ms` write from `/media/upload` | "the canonical row carries the probed size, and duration_ms = 1500…" |
| G2 · G3 · G8 | general poster for another user's / an old / a missing video | the three `parseOwnVideoPath` and route refusal tests |
| G4 | poster written with upsert (swappable) | "a second poster for the same video is refused and the first frame is kept" |
| G5 · G6 · G13 | canonical write not owner-scoped; miss claimed as success; late row not retried | the three `recordPosterOnAsset` tests |
| G7 | store the raw frame instead of the re-encoded one | "…with no EXIF…" |
| G9 | general poster ignores the emergency stop | "honours the upload emergency stop" |
| G10 | drop the deadline recursion | "a signed poster URL must not outlive the story its video belongs to" |
| G11 · G12 | a `memories/`/`stories/` path or a photo treated as a poster | "client-writable prefixes and non-video bases are not posters" |
| G14 | write `duration_ms` when the container states none | "writes nothing without an asset id or a measured duration" |
| G15 | skip the image sniff on the general poster | **SURVIVED first.** An MP4 body failed later, in the decoder, so the refusal came from the wrong layer. The added GIF case (it decodes, but it is not an admitted image) is now red. |
| C1–C21 | resume offset, size check, unsupported-vs-refused, expired URL, retry classes, exhaustion→pause, stage persistence, pause-keeps-shell, poster-at-complete, account gate, relaunch resume, MAX_RUNS, BACKGROUND session, exact byte range, part-file cleanup, envelope, fail-closed resize, ms→s, ships-off, transient complete | each named test in `travel-buddy-standalone/src/services/media/__tests__/mediaUploadTransport.test.ts` |
| C22 | queue ignores an account switch mid-drain | **SURVIVED first.** No test switched accounts during a run. "an account switch DURING a run stops the run before the next job starts" is now red. |
| P1–P6 | composer: no poster, poster path not sent, photo asks for poster, no resize, failed resize still posts, video through image envelope | `PostcardComposer.videoPoster.component.test.tsx` |
| P7–P12 | general poster client: skip derived route, 409 not honoured, no fallback, `travel-buddy-standalone/src/services/media.ts` drops the path or the query | `generalVideoPoster.test.ts`, `uploadMediaPoster.component.test.tsx` |
| P13–P17 | story or memory video gets no poster; the no-fallback rule is dropped; a photo asks for a poster; a missing path is still attempted | `storyMemoryPoster.component.test.tsx`, `generalVideoPoster.test.ts` |
| O1–O20 · O22 | cache: live not decayed, live label kept, coordinates kept, no TTL, LRU by write, shared key, write without account, revocation kept, no byte budget, unsigned image stored, auth covered, "gone" kept, non-crew stored, hidden gem stored, mixed list labelled by newest, denial served, denial not purged, video file collected, warm-up unthrottled, finished trips cached, saved places not read | each named test in `mediaOffline.test.ts` |
| O21 | a cache that cannot load takes the lens down | **SURVIVED first.** No seam could fail the load. A `_failMediaCacheLoad` seam was added, and "a cache that cannot even load never takes the lens down" is now red. |
| L1–L5 | lens hook or People / Places / Experiences screen drops the cached label; a live answer labelled cached | `offlineLenses.component.test.tsx` |
| V1 · V2 · V3 | client table says `hidden` shows the place; "Now" read as now; SERVER stops withholding the name for `hidden` | `mediaPrivacyClientParity.test.ts`. V3 mutates the SERVER and the parity test catches it. |
| V4–V9 | composer shows the "Now" copy without the place rule; sends `none` explicitly; circle promise restored; time sent for every mode; unknown read as `none`; a choice dropped | `PulseCreate.locationPrivacy.component.test.tsx`, `travel-buddy-standalone/src/services/media/__tests__/mediaPrivacy.test.ts` |
| I1–I11 | no dispute cap; legacy strength kept; confidence raised; banner lost without label; consensus dropped by the mapper; mapper ignores it; screen drops the banner; unknown conflict read minor; consensus replayed from cache; unreadable consensus guessed; caveats unmounted | `mediaIntelligence.test.ts`, `placeConsensus.component.test.tsx`, `mediaOffline.test.ts` |

### 22.3 Row moves

| Row | Was | Now | Why — and what caps it |
| --- | --- | --- | --- |
| MD275 | **W** | **C** | Every video upload path now ends with a poster that the server re-encoded, that lives at a path the server derived, and that is shown to exactly its video's audience. There are two server transports, the postcard slot and `/media/upload`, and four client entry points reach them: the postcard composer, `uploadMedia`, stories and memories. The postcard slot writes the poster into `post_media.thumbnail_storage_path`, and `/complete` accepts no other path. A general upload writes it into `media_assets.thumbnail_path`, which is the §14.4 falsifier. Tests: `mediaVideoTransport.test.ts` "MD275 on the wire", `mediaVideoPosterGeneral.test.ts` "MD275 on the wire — POST /media/upload/poster". S8–S11, S15, S16, G2–G13, P1–P3 and P7–P17 red. CAP: the frame is cut on the device by `expo-video-thumbnails`, the native call `uploadMedia` already shipped. No device run was made in this pass. |
| MD276 | **W** | **C** | Duration and display size are read from the container, and the declared figure never beats a measured one. The measured values reach `post_media.duration_seconds`, `width` and `height` (postcards) and `media_assets.duration_ms`, `width` and `height` (general uploads). Tests: "MD276 — duration and display size are READ FROM THE CONTAINER" and the two "on the wire" suites. S1–S7, S18, S22, G1 and G14 red. RESIDUAL: `posts.media_duration_seconds` still accepts a client figure. No composer in this tree sends one, and the column is not in the public post read. |
| MD281 | **N** | **C** | The postcard slot is a resume token. Parts resume from what landed, a wrong-sized part is re-sent, an expired URL gets a fresh session, and retries follow the classes and backoff above. A paused job survives the process. Tests: `mediaUploadTransport.test.ts` "MD281 — …" and `mediaVideoTransport.test.ts` "MD281 on the wire". S12–S14, S21 and C1–C13 red. CAP: ships OFF behind a client constant. The Storage it has run against is a fake, and it has never run on a device. |
| MD284 | **N** | **W** | The upload no longer dies with the screen. The queue owns it, persists it and resumes it on every foreground, and each part is an OS `BACKGROUND` transfer. Background upload of the whole file is still not delivered: the parts run serially from JS, so only the in-flight part continues while the app is suspended (iOS), and Android has no background session at all. See §22.5. C14–C16 red. |
| MD295 | **N** | **C** | Trip media is cached (`trip_media`, 14 days), pre-warmed for current and upcoming trips, and served offline with its age. Test: "MD295 + MD298: a trip is filed as trip media…". O15, O19, O20 and L4 red. CAP: reached through the World shell, which is dark (`MEDIA_WORLD_SHELL_ENABLED` false). Device storage not exercised on a device. |
| MD296 | **N** | **C** | Saved places are pre-warmed and read offline even if never opened. Test: "MD296 saved places: a pre-warmed saved place is there offline though it was never opened". O22 red. Same cap as MD295. |
| MD297 | **N** | **W** | `gemsOffline` caches only gems whose location is not hidden (test "MD297 hidden gems where permitted…", O14 red). NOTHING on this branch reaches it: the Hidden Gems lens here still renders the pre-existing `GemsFeed` (MD15). This is §11.2 group (b). See §22.5. |
| MD298 | **N** | **C** | An event experience's visuals are filed under `event_checkpoints` (3 days) and served offline, labelled with the age of the list's oldest member. Test as MD295. O15 red. CAP: cache-through only. An event is cached when opened online and is not pre-warmed. |
| MD299 | **N** | **C** | Every place view read online is stored with its images (`place_perspectives`, 1 day) and served offline, aged, without its live label or consensus. Test: "MD299 place perspectives…". O1–O12, O16–O18 and L3 red. Same cap as MD295. |
| MD301 | **N** | **C** | Only Trip Crew groups are stored, and offline the People lens shows exactly those, saying so. Test: "MD301 crew media…". O13, L1 and L2 red. Same cap as MD295. |
| MD320 | **W** | **C** | The client processing module exists and the postcard composer uses it. The W's "a 15 MB photo travels whole" is now a decision rather than an absence: a device re-encode would destroy the capture time the server reads for `captured_at`, so only a photo OUTSIDE the envelope is resized. Tests: "MD320 — the device enforces the server envelope…" and the composer suite. C17–C19 and P4–P6 red. DIVERGENCE: the path is `src/services/media/`, not `features/media/services/`, and the Pulse composer still refuses, rather than resizes, a photo above the envelope. |
| MD321 | **W** | **C** | A client privacy module exists and the post composer consults it for its choices, its copy and its request fields. The module's table is proved against the server by a parity test over every mode. V1–V9 red, V3 on the server side. |
| MD323 | **N** | **C** | The client reads the server's §18 consensus, draws the current picture from fresh witnesses, and surfaces "Mixed reports" on the Places lens. I1–I11 red. CAP: the World-zone cards do not render the zone consensus yet, and the Places lens is inside the dark World shell. |
| MD325 | **N** | **C** | `src/services/media/mediaCache.ts`, the §39 store above. Divergent path, same job. |

These moves change the parsed counts by **+12 C, −2 W, −10 N**. The headline
is NOT restated here. `check:census-integrity` will report the last headline
(§15.7) as no longer describing the rows until the integrating lane restates
it from the rows.

### 22.4 Production verification, stated separately

| Rows | Implementation | Production verification |
| --- | --- | --- |
| MD275 · MD276 (server) | built, tested over real HTTP with a fake Storage and six real ffmpeg files | not merged, not deployed. The routes are default-on once deployed. `recordMeasuredDuration` and `recordPosterOnAsset` write only where a canonical row exists (`media_canonical_enabled`). |
| MD281 · MD284 | built, tested over injected fakes | not merged. Ships OFF (client constant). Never run against real Supabase Storage signed part URLs or on a device. |
| MD295–MD301 | built, tested over injected fakes plus jest renders of the three lenses | not merged. Reached only through the dark World shell. Never run on a device with the radio off. |
| MD320 · MD321 · MD323 · MD325 | built, tested (node:test, jest, one server-side parity suite) | not merged. MD321's composer is the live Pulse composer. MD320's is the live postcard composer. |

**A behaviour change the integrator must see.** Before this pass, a general
video upload's canonical row carried null dimensions, which parks it in
`processing` (`artifacts/api-server/src/lib/mediaAssets.ts:397#input.width != null && input.height != null ? "ready" : "processing"`).
Nothing ever moves such a row on, because there is no transcoder. With probed
dimensions it is written `ready`, which makes a new video's canonical row
servable exactly as a new image's has always been. That is the 2089 contract
applied, not a flag turned on. But it is a change in what the canonical branch
can serve, and it was not previously true for video.

### 22.5 Rows that stay open

| Row | Verdict | RED WHEN | WHO |
| --- | --- | --- | --- |
| MD277 | **N** | A rendition ladder (HLS or DASH) exists for an uploaded video and the player selects between renditions. Needs a transcoding tier. This tier has no video decoder, and none can be added by a lane. | Owner: choose and fund a transcoder (a hosted service or an ffmpeg worker tier), then a lane. |
| MD280 | **N** | A timed text track travels with the asset and the player renders its cues. The renderer half is buildable. The SOURCE is not: either an ASR service or an authoring flow must produce the cues. §15.9 stands: a "Captions" toggle over the creator's note is not this. | Owner: decide the caption source (ASR vendor and its credentials, or an authored-WebVTT flow). |
| MD282 | **N** | Video bytes are re-encoded to a bounded bitrate before storage, on the server or the device. The server has no decoder. The device needs a native compression module that is not in `package.json`, so it needs a native build. | Owner (infra or native-module decision) plus a native build. |
| MD283 | **W** | A classifier decides video moderation. §9's F12 stands: the pipeline decides nothing for images either. One thing changed: every video now has a server-stored frame, so an image classifier has something to look at. | Owner (classifier vendor), then the moderation lane. |
| MD284 | **W** | An iOS device build shows a multi-part upload completing while the app is suspended from the moment it is backgrounded. That needs every missing part enqueued as a background task at once rather than serially. Android also needs a foreground service, which is native. | A native build plus a device run (operator), and the owner to flip `DEFAULT_ENABLED`. |
| MD297 | **W** | The Hidden Gems lens fetches through `gemsOffline`, and `gemsOffline` is typed to the lens it serves. Lane A's `HiddenGemsMediaScreen` (branch `claude/media-lane-a-client-ia-20260926`) is the consumer, and that branch CHANGES `fetchGems`: the parameter becomes `city`, and the result becomes a `HiddenGemLensProjection` whose items name the gem by `gemId`/`name`. So at merge `gemsOffline` and its `permittedGems` filter must be re-typed to the new shape, with the "never a `hidden`-precision gem" rule re-derived on it, before the screen's fetcher can point at it. The merge will not typecheck until then. | The integrator at merge, or this lane after it. |
| MD300 | **W** | The map projection carries an image per cluster. `/media/map` carries counts and no image, so there is nothing to cache. The cache then needs one more scope. | The server media lane (projection), then this module. |
| MD322 | **N** | A client context service reads the server-resolved §7 context of a media item. Lane A's branch builds exactly that (its `mediaContextGraph` state module plus a `fetchMediaContextRefs` call). This lane deliberately did not write a second mapper over the same server contract, because two mappers over one contract is how they drift. | The integrator, at merge: grade it against Lane A's module. |
| MD324 | **N** | A client search service calls `GET /api/media/search`, typed against `MediaSearchResults`. Lane A's branch builds it (`fetchMediaSearch` beside its `MediaSearchScreen`). Not duplicated here, for the same reason. | The integrator, at merge. |

### 22.6 Found while doing it — reported, not fixed

1. **The Pulse composer's location copy promised more than the server
   delivers.** "Location stays completely hidden" was shown while city and
   country stay on the post
   (`artifacts/api-server/src/lib/postSchemas.ts:180#export function mapPublicPost`
   nulls only the venue name). "Only people in your Trusted Circle can see
   where you are" was shown while no audience sees the place. "Now" published
   nothing now: the composer omits the field for `none`, and the create route's
   default for a tagged post is after-exit
   (`artifacts/api-server/src/routes/posts.ts:580#const privacyMode: LocationPrivacyMode = reqPrivacyMode ?? defaultPrivacyMode(locationSource, sens);`).
   The words are now true (MD321). **The labels "Now", "Hidden" and "Trusted
   circle" are an owner decision and were not changed.** So is whether "Now"
   should send `none` explicitly: that would publish a tagged place at once,
   which is a privacy change, not a refactor.
2. **MD262 "Show neighborhood only" is C on the gem ceiling**
   (`artifacts/api-server/src/lib/mediaLocationVisibility.ts:110#case "approximate":`).
   That is a Hidden-Gem sensitivity, not a choice a person posting media can
   make. No post location mode maps to `neighborhood`. Likely mis-graded.
   Not re-graded here: it is outside this lane's rows.
3. **MD153's cited component is mounted nowhere.**
   `travel-buddy-standalone/src/features/media/components/RequestAViewPrompt.tsx:63#export function RequestAViewPrompt(`
   is exported, and outside its own file only its flag constant is imported. No
   screen renders it. The §18 `requestAnotherObservation` flag this pass now
   reads has no surface to route to either.
4. **Postcard feed variants.** `<storage_path>.feed.jpg`, the postcard image
   variant `/complete` writes to `feed_storage_path`, is not authorized for
   non-owner viewers. `mediaAccess` 3a matches `post_media.storage_path`
   exactly, and no later branch names the variant, so a non-owner's request for
   it ends in the §4 deny. The poster rule above is the shape of the fix:
   authorize a derived object as its base. It is not applied here because the
   variant belongs to the image pipeline, not to this lane's rows. **Fixed in §23.7.**
5. **`RecordAssetInput` has no duration field.** This pass writes `duration_ms`
   through a follow-up update rather than widening a Lane B type. The postcard
   canonical row (`recordEntityMedia`) still has no duration or size.

### 22.7 Counted files this section changed

Changed files that `check:census-freshness` counts:

- **census-media, not named in its acknowledgement:**
  `artifacts/api-server/src/lib/videoMetadata.ts`,
  `artifacts/api-server/src/routes/postcards.ts`,
  `travel-buddy-standalone/src/features/media/screens/MediaExperiencesScreen.tsx`,
  `MediaPeopleScreen.tsx`, `MediaPlacesScreen.tsx`,
  `travel-buddy-standalone/src/features/media/services/mediaProjection.ts`,
  and `travel-buddy-standalone/src/features/media/types/perspective.ts`.
- **Newly counted by census-media, because §22 widens its scope** in
  `artifacts/api-server/src/scripts/checkCensusFreshness.ts`: the new
  `travel-buddy-standalone/src/services/media/` directory,
  `travel-buddy-standalone/src/services/media.ts`,
  `travel-buddy-standalone/src/services/mediaUrl.ts`,
  `travel-buddy-standalone/src/services/stories.ts`,
  `travel-buddy-standalone/src/services/memories.ts`,
  `PostcardComposer.tsx`, `travel-buddy-standalone/src/components/PulseCreate.tsx`
  and their two component tests. On the server:
  `artifacts/api-server/src/lib/videoProbe.ts`,
  `artifacts/api-server/src/lib/mediaPosterPath.ts`,
  `artifacts/api-server/src/lib/mediaVideoPoster.ts`,
  `artifacts/api-server/src/routes/mediaVideoPoster.ts`,
  `artifacts/api-server/src/lib/postcardMediaTransport.ts`,
  `artifacts/api-server/src/routes/postcardMediaTransport.ts`,
  `artifacts/api-server/src/lib/postSchemas.ts` and the three new server test
  files.
  `check:census-scope-coverage` required the widening: §22's citations had taken
  the watched share to 87% against a 96% floor.
- **Already named in an acknowledgement:**
  `artifacts/api-server/src/lib/mediaAccess.ts` (media, highlights-memories,
  telegraph), `artifacts/api-server/src/lib/mediaProcessing.ts` (media,
  telegraph), `artifacts/api-server/src/routes/posts.ts` (media, wall),
  `artifacts/api-server/src/routes/index.ts` (highlights-memories, telegraph)
  and `travel-buddy-standalone/app/_layout.tsx` (input-intelligence, sensing).

The census-media acknowledgement was NOT edited. This section is the
re-measure of the rows those seven files serve, and the integrator re-declares
`head_commit`. The edit to `travel-buddy-standalone/app/_layout.tsx` mounts two media setups after
`<SensingCaptureSetup />` and changes nothing it renders. Every line number the
other censuses cite in the other shared files was preserved: the edits there
were net-zero or appended at the file's tail. The three Media screens are held to
the same rule, because this census cites them by line (rows MD13, MD14, MD31 and
MD32, and the People-lens evidence in §12). Their new imports and the Places lens's caveat
component live at each file's tail.

## 23. Integration — the media lanes merged into `claude/sensing-completion-20260925`, and the headline restated from the rows

The integration owner merges each lane after reading its diff, not its
summary, and restates the headline here from `check:census-integrity` after
each merge. This section stays last; a later lane's section is placed above
it. §20.10 recorded lane B alone.

### 23.1 Lane A (§19), merged 2026-09-26

**Reviewed before merging, because it adds a server read path:** search now
finds events and trips by title (`searchCanonicalEventsAndTrips`). Candidates
are read by title on the server and every one is passed through
`resolveExperience`, the same visibility gate `GET /media/experiences/:id`
uses. A candidate the viewer may not see is dropped whole, so no id, title or
count of a hidden trip or event reaches the response, and a "my world" or
"this trip" search never reaches it at all. The rest of the lane is client
code behind the dark World shell, plus four routes appended to the route
registry. It writes no migration.

**No overlap with lane B.** The two lanes moved disjoint rows, so the order
of §19 and §20 cannot change a verdict.

**Accepted as argued:** MD293 moved DOWN from W to N (no cross-place visual
index exists), and six C rows were re-evidenced against the code with
findings (MD12, MD14, MD30–MD32, MD417). **None of lane A's 28 moved rows is
realised in production:** the World shell is seeded off, and the Media Map
places nothing in production while `map_projection_enabled` has no row there.

### 23.2 3320 and 3321 applied to portava-ci; three sentences about production that its catalog contradicts

**Why now.** The live-DB job's `audit:schema` failed on `4b57e8746` with four
objects missing: the two functions and two triggers of 3320 and 3321. Both
files came with lane B and were applied nowhere. Their headers assign the
portava-ci apply to the integrator after review; decision A's condition (CI's
`node:test` green on a tree containing them) held.

**Reviewed before applying: who reads what 3321 changes.** 3321 stores
`flagged` as `limited`, `approved` as `active` and `pending` as `processing`,
so every reader of `media_assets.moderation_status` was read.
- **Already speak §36:** the projection's unservable set, eligibility's
  non-distributable set, the Quick Media block, the moderation service and the
  presence receipt all treat `limited` as blocked. Shareables accept `active`.
- **Not affected:** the `!== "flagged"` checks in posts, pulse, passport, the
  feed item and the post-media resolver read `post_media`, which 3321 does not
  touch.
- **The one that does not speak §36:** the 20260811 RLS policies admit an
  `authenticated` direct read only for `moderation_status = 'approved'`. No
  path reads these tables as `authenticated`, because the API uses the service
  role, so the effect is that such a read of a public `active` row returns
  nothing. That fails closed. Widening it is a protection change and is left
  to the owner; recorded, not done.

**Applied runner-identically, then controlled** (`docs/migrations.md`, the
2026-09-26 entry for 3320 and 3321). Catalog read back: three CHECKs, two
enabled triggers, default `processing`, ledger 604 to 606, the 2481 row
untouched. In one rolled-back block, the database did each of these:
- stored `flagged`, `approved` and `pending` as `limited`, `active` and `processing`;
- refused a forged or rewound `version` (99 and 1 became 4 and 5);
- matched zero rows on a stale compare-and-set;
- refused `everyone`, `bogus` and `friends` with 23514.

**Three sentences corrected**, read from production's catalog on 2026-09-26
(read-only):

| Sentence | Where | What production's catalog says |
|---|---|---|
| P1: `media_canonical_enabled` is TRUE while 2250/2470's columns are absent | §20.5 | **2470 is applied** (2026-09-16, `manual`, *"under ORDER B, on explicit owner decision"*); all four columns are present. **`media_canonical_enabled` reads FALSE**, last updated 2026-09-25 15:39 UTC; the tree records no reason. The canonical writer is off in production **by the flag**, not refused by the schema. The source of P1 was the comment at `artifacts/api-server/src/lib/mediaAssets.ts:13#THE FLAG IS NOT OFF. MEASURED 2026-09-07`, true when measured and not re-read. |
| P4: 3321 refuses production until P1 | §20.5, and 3321's own header | Production carries the §36 superset CHECK (`media_assets_moderation_status_canonical_check`), so **3321's precondition would pass there**. 3320's would too: 11 assets, all `pending`/`inherit`; 0 attachments. Neither file is applied there, and applying them is the owner's decision. The header is not edited, because portava-ci's ledger checksum is the file's bytes and the runner reports a changed file as drift. |
| MD339's reason: production cannot create attachment rows "only because of MEDIA_CANONICAL_FLAG" | §20.4 | The binding step is turning `media_canonical_enabled` on. That is an owner act, and it was turned off yesterday. |

**What moves: no verdict.** Every row §20 moved was graded on branch code.
§20.5's per-row table still names the right owner, because P1 and P4 still
name production steps. What changes is what those steps are:
- **P1** is now one owner act, turning the flag on; the schema is ready.
- **P4** is done on portava-ci. On production it is applying 3320 then 3321,
  and both preconditions pass today.

MD38 (a lost race refused) and MD41 (a tenth entity type refused) are now
**observed on portava-ci's real schema**, not only on local PostgreSQL. They
remain unrealised in production.

### 23.3 Lane C (§21), merged 2026-09-26

**Reviewed before merging, because it adds a write path and three privacy
surfaces.**

- **The `post_event_links` writer** (`POST`/`DELETE /media/:id/event-link`)
  has no inference: the author links by hand. It links only the caller's own
  active post, only to a PUBLIC event that is not cancelled or archived and
  that the caller hosts, co-hosts or RSVP'd going to, and only within the
  event's time window. One predicate both offers the action and accepts the
  write, and an unreadable read refuses rather than guessing. The routes
  require a signed-in user, are rate-limited, and are dark behind
  `MEDIA_WORLD_SHELL_ENABLED`, like the rail that shows them.
- **The gem visit outcome** on `GET /hidden-gems/:id` gives counts of distinct
  verified visitors only, with the last report at day precision and no ids or
  coordinates. It is withheld entirely below 3 reporting visitors, and is added
  after the route has already decided the viewer may see the gem. **Residual,
  recorded and not built:** a bare k-floor does not stop differencing. Someone
  who knows a person just visited can compare consecutive readings and learn
  that person's class. Nothing here gates that the way
  `publishThroughDifferencingGate` gates sensing.
- **The §44/§45 producers** keep client and server apart. Only the
  client-safe outcome types are open to the batch endpoint. The outcomes a
  server commits (invite written, contribution recorded or accepted, Postcard
  created, experience completed) stay server-only, so a client cannot claim
  one. Attribution reads only the viewer's own events, and every producer is
  dark while `MEDIA_ANALYTICS_ENABLED` is off.
- **The ranking loader** reads the viewer's own intent, trips, follows, saved
  places and interests. For the page's candidates it reads only public events
  and public, active postcards. **Trip Expertise** counts only trips that are
  public and set to show their destination city.
- **Two guard edits**, each justified by the code. `MEDIA_WORLD_SHELL_ENABLED`
  moved from the app-tree-only list to `CLASSIFIED`, because the API now reads
  it. The `post_event_links` dead-lane entry was struck, because it now has a
  writer.

**Conflicts, and how they were resolved.**

- **The projection service:** lane C's `rankCandidatesForViewer` is the only
  ranker its merged body calls. It sits beside lane B's canonical-read and
  override imports.
- **The World shell:** lane A's behaviour is kept, and lane C's signals are
  added only when something actually opens.
  - A changing-now card opens its place's perspectives.
  - "Why this?" opens only when the server gave a reason.
  - The three `visual_opportunity_open` emits are kept, which lane C's source
    test counts.
  - Lane C's `gem_open` emit lived in `GemsFeed`, which lane A had already
    replaced in the shell with `HiddenGemsMediaScreen`, so the World lens
    would have lost it. It is carried onto that screen's `onOpenGem`, with
    surface `world_gems`.
- **No moved row is shared** between §19, §20 and §21, so their order cannot
  change a verdict.

**Found by lane C and not fixed here** (§21.6):
- MD100 and MD172 were C on the server only, because the rail hid their
  actions. It now renders them, behind the shell flag.
- MD104's old evidence sentence was false.
- `post_event_links` now has a writer, so census-discovery's rows that rest on
  "Live from events" returning nothing need re-reading.

**None of lane C's 38 moves is realised in production.** The shell and the
analytics flag are off, `canonical_media` is absent from every row, and the
gem outcome also needs the hidden-gem flags and at least three reporters.
MD112, the duplicate check on every gem submission surface, is the one move
that is live on deploy.

### 23.4 Lane D (§22), merged 2026-09-26

**Reviewed before merging, because it adds server write routes that are ON by
default** (no flag): the postcard poster, the resumable upload session with its
assemble and abandon steps, and `POST /media/upload/poster`.

- **Every slot route requires a signed-in user, is rate-limited, and loads
  only a pending slot the caller owns.** The check is `slot.user_id !== userId`
  refused as `forbidden`, in `routes/postcardMediaTransport.ts`. The assemble
  step re-checks size and sniffs the bytes before anything is stored (lane D's
  S21).
- **The general poster route guards the same way:**
  - the video path must match an anchored `<caller uid>/<ms>.<mp4|mov|webm>`
    and fall inside the attach window;
  - it shares `/media/upload`'s emergency stop and upload budget;
  - the image is sniffed, then re-encoded without metadata;
  - the write is once only (a second poster is 409);
  - the canonical-row update is filtered on `owner_user_id`.
- **A poster is shown to exactly its video's audience.** Its path is derived by
  the server (`<video>.poster.jpg`), `/complete` admits no other thumbnail
  path, and the byte gate authorizes a poster by deciding its video once.
  Nothing under the client-writable `memories/` and `stories/` prefixes is ever
  treated as a poster.
- **The client halves are dark.** The resumable upload queue ships off
  (`DEFAULT_ENABLED = false`; its app-start hook returns immediately). The
  offline warm-up installs only while `MEDIA_WORLD_SHELL_ENABLED` is on.
- **Behaviour that changes on deploy**, stated by lane D (§22.9) and kept here:
  - canonical video rows get probed dimensions and become `ready`, as images
    already were;
  - `/complete` stores measured duration and size, and refuses a foreign
    thumbnail path;
  - `uploadMedia`'s message-video thumbnail becomes the derived poster path,
    which **no messaging test covers**.
- **One client dependency is declared:** `expo-file-system ~19.0.23`, already
  linked at that version through `expo`, adding 3 lockfile lines.
- **The Pulse composer's privacy copy was made truthful.** The labels, and
  whether "Now" should send `none`, are the owner's decision, recorded and not
  taken.

**Conflicts, and how they were resolved.**
- **Route registry:** both registrations kept, sensing's session issuer first,
  then the two media routers.
- **The four Media screen files:** lane A's structure is kept (the Experiences
  id list and map mode, People's `onOpenPerson`, Places' map), with lane D's
  offline fetchers and cached-age labels. Places' `useLensProjection` import
  became unused, so it was replaced in place by the `placeViewOffline` import;
  the top of the file keeps its line numbers.
- **`mediaProjection.ts`, `package.json` (3 tests) and the freshness scope:**
  unions.
- **The census:** §22 is placed above §23. No moved row is shared by §19–§22.
- **The type break lane D predicted:** `gemsOffline` still read a gem type no
  endpoint sends. It is re-typed to lane A's lens in §23.5.

**Found by lane D and not fixed here** (§22.7–§22.8):
- MD262 "neighbourhood only" is C on a Hidden-Gem ceiling that no post location
  mode maps to.
- MD153's `RequestAViewPrompt` is mounted nowhere.
- MD152 renders on the Places lens only.
- Postcard feed variants (`<storage_path>.feed.jpg`) are denied to non-owner
  viewers, because the byte gate matches `storage_path` exactly. **Fixed in §23.7.**

### 23.5 Three rows the integration closes

Lane D left MD297, MD322 and MD324 to the integrator. MD297 needed wiring that
spans both lanes. MD322 and MD324 needed a ruling on lane A's modules, which
lane D deliberately did not duplicate.

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD297 | **W** | **C** | The Hidden Gems lens now reads through the offline cache (`travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:52#gemsOffline({ city, signal: opts.signal })`) and labels cached gems with their age (`travel-buddy-standalone/src/features/media/screens/HiddenGemsMediaScreen.tsx:128#testID="gem-lens-cached"`). `gemsOffline` is re-typed to lane A's `HiddenGemLensProjection` (`travel-buddy-standalone/src/services/media/mediaOffline.ts:243#export function gemsOffline(`). "Where permitted" is kept against the real payload: lane D's filter keyed on a `locationPrecision` field no endpoint sends, so now no gem the server declined to NAME is copied onto a device (`travel-buddy-standalone/src/services/media/mediaOffline.ts:239#export function permittedGems(`). An unreadable list (`gemLensReadState`'s `list_unreadable`) is treated as an outage and answered from cache. It never clears the cache as "no gems here". Tests: `travel-buddy-standalone/src/services/media/__tests__/mediaOffline.test.ts:352#it('MD297 hidden gems where permitted`, `travel-buddy-standalone/src/services/media/__tests__/mediaOffline.test.ts:372#it('MD297 an UNREADABLE gem list is an outage`, `travel-buddy-standalone/src/services/media/__tests__/offlineLenses.component.test.tsx:91#it('Hidden Gems lens (MD297)`. **Mutations, each seen red:** i1, store unnamed gems; i2, an unreadable list read as a list; i3, the lens fetching past the cache (both component cases). Dark: the lens is in the World shell. |
| MD322 | **N** | **C** | A client context service over the server-resolved §7 context exists, at a different path from the one the row names, in two parts. `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1395#export function fetchMediaContextRefs(` reads the refs `GET /media/:id/actions` emits for the viewer. `travel-buddy-standalone/src/features/media/state/mediaContextGraph.ts:62#export function mapContextRefs(` and `travel-buddy-standalone/src/features/media/state/mediaContextGraph.ts:99#export function buildContextGraph(` turn them into edges. The one consumer is `travel-buddy-standalone/src/features/media/components/MediaContextSheet.tsx:52#fetchMediaContextRefs(media.id`. Proven in §19: mC36, mC36b, mC36c and mC37–mC41 were seen red. **Same job, different path**, graded as MD325 was: the row's named file (`services/mediaContext.ts`) does not exist, and this census does not require one duplicated under that name. |
| MD324 | **N** | **C** | A typed client of `GET /api/media/search` exists: `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1381#export function fetchMediaSearch(`. It maps through `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1301#export function mapMediaSearchResults(` into the seven §38 result lists, and a criteria-free query is answered locally with NO request. Its consumer is `travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:102#fetchMediaSearch(queryString, opts)`, and its test is registered (`travel-buddy-standalone/src/features/media/__tests__/searchAndStores.test.ts:105#fetchMediaSearch(null) answers locally`). Proven in §19: mC26–mC35 were seen red. This row's own falsifier named `services/mediaSearch.ts`; §19.8 and §22 both put the name and location to the integrator. **Ruled: same job, different path**, as MD325. |

**None of the three is realised in production.** All three live in the World
shell, which is seeded off.

### 23.6 Restated headline

> | Measure | After lanes B, A and C (§23.3) | Now, after lane D and §23.5 |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 383 | **398** |
> | BUILT-BUT-WRONG | 41 | **38** |
> | NOT-BUILT | 24 | **12** |
> | CANNOT-VERIFY | 2 | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | 94.2 % | **436 / 450 = 96.9 %** |
> | **CORRECT%** (raw) = C/450 | 85.1 % | **398 / 450 = 88.4 %** |
>
> Restated from `check:census-integrity` after all four lanes and the three
> integration moves. These are construction verdicts. **Not one move in
> §19–§23 is realised in production** (§20.5, §21.5, §22, §23.2–§23.5). What
> remains is owner decisions, vendor or native work, and production steps,
> each named with a falsifier in §20.6, §21.4 and §22.

### 23.7 Postcard feed variants were refused to every non-owner; now a recorded variant is decided as its original

**The defect.** It was found by lane D (§22.7, item 4) and left open in §23.4.
- `post_media` records server-derived variants of its object:
  - the feed-size derivative, in `feed_storage_path` / `feed_url` (0208);
  - the thumbnail, in `thumbnail_storage_path` / `thumbnail_url`.
- The server writes them only under the uploader's own folder:
  - `artifacts/api-server/src/routes/postcards.ts:776#const candidatePath =` (`<storage_path>.feed.jpg`)
  - `artifacts/api-server/src/routes/posts.ts:225#thumbnailPath =` (`<uid>/<ms>.thumb.jpg`)
  - `artifacts/api-server/src/routes/posts.ts:242#feedPath =` (`<uid>/<ms>.feed.jpg`)
- Branch 3a of the byte gate matched `post_media.storage_path` exactly, and no later branch names a variant. A non-owner's request for one therefore ended in §4's deny.
- The client asks for the variant first: `travel-buddy-standalone/src/components/PostcardTile.tsx:39#source={{ uri: post.media[0].feedUrl ?? post.media[0].url }}`. A refused sign is final for `CachedImage`: it renders its fallback and does not retry with `url`.
- So every non-owner saw a placeholder where a postcard with a feed variant should have been.

**Production, read-only, 2026-09-26.** This is not a branch-only defect; it is live.
- `media_private_buckets_enabled` is `true`, last set 2026-07-24.
- The `post-media` bucket has `public = false`.
- `post_media` holds 6 rows. **1 has a feed variant** and 0 have a thumbnail.
- In 0 rows is the recorded variant anything other than a derived name of its own `storage_path`. The rule below therefore accepts every variant production holds.

**The fix, which is lane D's poster rule (§37) generalised: a variant IS its original.**
- **Where the variant is resolved.** `artifacts/api-server/src/lib/mediaAccess.ts:483#const pmRows = ((pms as any[]) ?? []); if (pmRows.length === 0) { const original = await originalOfRecordedVariant(` runs only when no row claims the path as an original. It is the same line as before, so no cited line above it moved.
- **The recursion.** If the path is a recorded variant, the gate decides the ORIGINAL. Its moderation, its post's rules, its own attachment override and its trip context all apply, and nothing wider can.
- **The original comes from a row, and a row is believed only when the variant is a server-derived NAME of it.** That is `<original>.feed.jpg` / `.thumb.jpg` (postcards) or `<stem>.feed.jpg` / `.thumb.jpg` (general posts): `artifacts/api-server/src/lib/mediaAccess.ts:991#export function isDerivedVariantOf(`.
  - A row that names someone else's object as its "variant" is ignored.
  - This matters because a row's variant URL is data a post carries. Without the name test, any user could lend a victim's object their own post's audience.
- **Fail-closed cases** (`artifacts/api-server/src/lib/mediaAccess.ts:1006#async function originalOfRecordedVariant(`), each of which denies:
  - a lookup error, as 3a already denies on its own read error: `artifacts/api-server/src/lib/mediaAccess.ts:1026#if (error) return "deny";`;
  - a full page of rows naming the variant, where a conflicting row could lie past the cap;
  - two different originals, where picking one would decide by read order: `artifacts/api-server/src/lib/mediaAccess.ts:1035#if (originals.size > 1) return "deny";`.
- **Client-writable prefixes.** Nothing under `memories/` or `stories/` is ever a variant, because the server derives none there: `artifacts/api-server/src/lib/mediaAccess.ts:1012#if (VARIANT_CLIENT_WRITABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;`.
- **How the lookups are built.** Each is its own `.eq` / `.in`, never a string-built `.or()`, because the caller chooses `path`.
- **What does not change.** A path that is not a recorded variant falls through exactly as before, including message thumbnails, which 3c decides. The added cost is four indexed-or-empty reads on a miss, and only for paths ending `.feed.jpg` / `.thumb.jpg`.

**Tests.** They are in `artifacts/api-server/src/test/mediaAccess.test.ts:858#describe("derived variants (.feed.jpg / .thumb.jpg) are their original"`, ten cases:
- a public postcard's variant is served;
- a private post's variant and a rejected image's variant are denied;
- an override on the original narrows the variant;
- a general post's `<stem>.thumb.jpg` resolves through `thumbnail_url`;
- a row naming another's object authorizes nothing;
- a failed lookup denies;
- a truncated page denies;
- two originals deny;
- a `stories/` variant is refused;
- the pure name rule.

Every test that asserts a denial carries an allowing control, so a deny could not pass for the wrong reason. In the failed-lookup test, falling through would reach a 3b row that serves the URL, which makes the deny arm the only way to red.

**Mutations, each seen red and then restored** (the file was checked byte-identical against a saved copy after every run):

| Mutation | Red |
| --- | --- |
| M1 the 3a line removed | 1, 4, 6, 7, 8 |
| M2 the name rule accepts any row | 5, 7 |
| M3 the recursion replaced by `return true` | 2, 3 |
| M4 a lookup error falls through | 6 |
| M5 the cap ignored | 7 |
| M6 two originals allowed | 8 |
| M7 the client-writable prefixes not excluded | 9 |
| M8 the deny arm returns `true` | 6, 7, 8 |

M4 survived the first version of test 6. That test had no later branch that would allow, so "deny on error" and "fall through" both ended in §4's deny. Test 6 was rewritten with a 3b row that serves the URL, and M4 then went red. M5, M6 and M7 survived the first seven tests; tests 7, 8 and 9 were written for them.

**Checks run.**
- The byte-gate suites: 14 files, 379 tests, 0 failures.
- `tsc`, `typecheck:tests` (at baseline), and eslint (0 errors).
- `check:doc-citations`: clean after one test citation, shifted by the fake's new `columnErrors` field, was repointed from 794 to 798.
- `check:citation-targets` at 165 / 165.
- `check:census-freshness`, `check:census-scope-coverage` and `check:census-integrity` all passed.

**Rows.** No row in this census moves. The defect sat under no graded row, and the headline in §23.6 stands.

**Recorded, not re-graded.** census-wall W151 ("responsive variants") is C on `routes/posts.ts` building a `feedUrl`. Two facts from this pass bear on it:
- Until this fix, a non-owner could not fetch that variant.
- The Wall's own renderers do not read `feed_url`; only the postcard surfaces do.

W151 belongs to census-wall and is left for its owner to re-read.

**Branch versus production.** This fix is built on the branch. It is not merged and not deployed. Production still refuses the one variant it holds to every non-owner until this code ships. No flag gates the fix, so deploying it is the whole production step.

### 23.8 Three stale records of the canonical flag, superseded in place

§23.2 corrected this census's own sentences about `media_canonical_enabled`. Three
records outside it still said the 2026-09-07 thing. On 2026-09-26 the flag and
the schema were re-read, read-only, from production:
- `media_canonical_enabled` is FALSE, `updated_at` 2026-09-25 15:39:58 UTC.
- `media_assets` has all four of 2250's columns (`captured_at`,
  `intelligence_eligibility`, `location_visibility`, `provenance`).
- The ledger has `2470_media_asset_canonical_columns_flag_agnostic.sql`,
  `manual`, 2026-09-16.

Each record is marked superseded in place, so none of the citations into it moves:
- `artifacts/api-server/src/lib/mediaAssets.ts:13#THE FLAG IS NOT OFF. MEASURED 2026-09-07`.
  The note is appended to the same line. The 09-07 text is kept as the record
  it was, so §20.5's and §23.2's citations still resolve.
- `docs/architecture/blocker-ledger.md`, the `MEDIA_CANONICAL_FLAG` row.
- `docs/architecture/migration-disposition-ledger.md:154#MEDIA_CANONICAL_FLAG`.

Both ledger rows now say the original condition no longer holds. What remains
the owner's is whether to turn the canonical writer back on, which 3321
requires before it will run on production. No executable line changed, and no
verdict moves.

## 24. Lane E — a representative image per map cluster, and search by radius — 2026-09-26

Two W rows were assigned: MD300 (§39 "Map thumbnails") and MD288 (§38
"Show hidden beaches near Da Nang"). Both are now built on the server and in
the client services, tested and mutated. **Neither moves to C.** In each case
the step that lets a user reach the work is a screen outside this lane's
files, and this census has already ruled what that means. MD297 stayed **W**
while nothing reached its offline scope (§22.5) and became **C** only when its
lens read through it (§23.5). The §38 examples became **C** only when the
Search screen could ask them (§19: MD287, MD290–MD292). §24.2 and §24.3 each
end with the one step left and who owns it.

Worked from `claude/sensing-completion-20260925` at `b1903565b`, on branch
`worktree-agent-a355e4e2894b581d6`. The code and tests are in `de83385e3`;
this section is in the commit after it. No migration was written and no flag
was touched.

### 24.1 Row table

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD300 | **W** | **W** | The half §22.5 named is built. `/media/map` clusters now carry one cover each (`artifacts/api-server/src/services/media/MediaProjectionService.ts:1654#return attachClusterCovers(sc, viewer, { generatedAt, clusters, totalPerspectives: media.length }, zoneMap);`), chosen after the directional override (`artifacts/api-server/src/services/media/MediaProjectionService.ts:1857#const kept = await filterMediaProjectionVisibility(sc, viewer.viewerId, pool);`). The client maps the cover (`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1449#export function mapMediaMapWithCovers(`), and the cache has the scope (`travel-buddy-standalone/src/services/media/mediaCache.ts:51#'map_thumbnails';`, `travel-buddy-standalone/src/services/media/mediaOffline.ts:335#export function mediaMapOffline(`). §22.5's own falsifier is met. **Still W:** nothing reaches the scope and nothing draws the cover. The one Media Map loads through the raw fetcher (`travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:65#fetchMediaMap({ city, signal: opts.signal }).then((r) =>`), and so do the Places and Experiences map modes. This is MD297's §22.5 state exactly. |
| MD288 | **W** | **W** | The first half of §19.6's falsifier is built: `GET /media/search` accepts a center (a canonical place, or a point) and a radius of 100 m to 5 km (`artifacts/api-server/src/routes/mediaWorld.ts:329#const near = parseMediaSearchNear(req.query); if (!near.ok) { sendError(res, "invalid_payload", near.message); return; }`). The radius is resolved through the canonical Map's own place contract (§24.3), and the typed client sends it (`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1488#export function mediaSearchNearParams(`). **Still W:** no screen sends it. The Search screen's "Near <city>" chip sets the CITY criterion (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:180#onPress={() => dispatch({ type: 'set_city', city: filters.city === nearCity ? null : nearCity })}`), and the screen calls the search with no `near` (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:102#fetchMediaSearch(queryString, opts)`). So "near Da Nang", asked on the screen, is still answered city-coarse. |

These rows change no parsed count.

### 24.2 MD300 — one cover per cluster, and the `map_thumbnails` scope

**Server.** Each cluster carries `coverMedia`, an array of zero or one items.
No new rule decides who may see a cover:

1. **The candidates.** A cover is one of the cluster's own items. Every item has
   already passed the loader's gates (eligibility, blocks, mutes, private
   accounts, delayed publish). It has also passed `projectCandidatesProtected`:
   the servable-media gate over processing and moderation, the §6 canonical
   read, the §6.1 attachment override for this viewer, and the location choke
   point. These are the same steps the place projection's perspectives take.
2. **The directional override.** Candidates are filtered with the router's own
   boundary function BEFORE one is chosen. If a crew member hid themselves from
   this viewer in a trip, the cluster shows its next item and does not lose its
   image
   (`artifacts/api-server/src/test/mediaWorldProjection.test.ts:1867#it("a crew member who hid themselves from this viewer in that trip is never the cover — the next item is"`).
3. **Why an array.** That boundary filter prunes media only out of arrays
   (`artifacts/api-server/src/lib/mediaVisibility.ts:387#if (Array.isArray(value)) return value.filter((item) => {`).
   A cover sent as a lone object would pass it unexamined.
4. **An image or nothing.** A cover is an image, or a video that has its
   server-derived poster
   (`artifacts/api-server/src/services/media/MediaProjectionService.ts:1819#export function hasClusterCoverImage(`).
   A video file is never a thumbnail.
5. **Fail closed on images.** If the directional read cannot complete, the
   clusters are served with no covers. The counts are served as before.
6. **Slim.** A cover carries id, media type, url, thumbnail, dimensions,
   capture time and freshness. It carries no contributor, no place labels and
   no provenance. The byte gate still decides the file's signature.

**Client.** `fetchMediaMap` now maps each cluster's cover
(`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1270#return getJson(`).
It keeps a cover only if it carries an image
(`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1444#const hasImage = m.mediaType === 'video' ? !!m.thumbnailUrl : !!(m.thumbnailUrl || m.url);`).
The device never picks a cover of its own.

**The scope.** `map_thumbnails` is keyed per city, with a one-day TTL and six
entries
(`travel-buddy-standalone/src/services/media/mediaCache.ts:71#map_thumbnails: { requirement: 'Map thumbnails', ttlMs: 1 * DAY, maxEntries: 6 },`).
It is filled through lane D's cache-through rule, so every §39 rule already
enforced there binds:

- **Only what the server chose is stored.** The images are fetched through the
  signer, so a cover the byte gate refuses for this viewer is never written to
  the device.
- **Revocation is honoured.** A server answer of "no clusters here" deletes the
  stored map
  (`travel-buddy-standalone/src/services/media/mediaOffline.ts:344#{ isEmpty: (p) => p.clusters.length === 0, toStore: storedMap },`).
- **An auth failure is never covered** by the cache.
- **Freshness only decays.** Offline, the map is served with its "Cached ·
  updated" label and never reads live. One gap was closed here: a cluster's
  freshness has no age of its own, so `decayFreshness` could never demote it.
  Each stored cluster is therefore stamped with the least age it can have had
  (`travel-buddy-standalone/src/services/media/mediaOffline.ts:320#ageMinutes: 0,`),
  and each cover with its real age. A "fresh" pin read back three hours later
  reads "recent".
- **No coordinates.** The payload carries none, and the store's scrub still
  runs.

CAP: cache-through only. A city's map is stored when it is viewed online; the
§39 warm-up does not pre-fill it, as MD298 is capped in §22.3.

**Tests.**
- Server: `artifacts/api-server/src/test/mediaWorldProjection.test.ts:1803#describe("MD300 — each /media/map cluster carries ONE cover image the viewer may open"`
  (8 cases, including a CONTROL that the hidden crew item IS the cover when
  there is no override) and, over HTTP,
  `artifacts/api-server/src/test/mediaWorldProjection.test.ts:2162#it("GET /media/map serves each cluster's cover, and not a hidden crew member's"`.
- Client: `travel-buddy-standalone/src/features/media/__tests__/searchAndStores.test.ts:271#test('MD300 fetchMediaMap carries each cluster`
  and `travel-buddy-standalone/src/services/media/__tests__/mediaOffline.test.ts:487#describe('MD300 — Map thumbnails:`
  (4 cases).

**RED WHEN (narrowed from §22.5):** the Media Map's cluster source reads
through `mediaMapOffline`, draws each cluster's `cover`, and shows
`offline.label` when it is served from the cache. That covers the standalone
screen's default loader and the Places / Experiences map modes, which each
pass their own loader. **WHO:** the owner of the Media Map screens (lane A's
files; the World shell is excluded from this lane by name), or the
integrator. Nothing server-side remains.

### 24.3 MD288 — "near X" as a bounded radius, resolved through the canonical Map

**What the request takes.** The request adds `nearPlaceId` (a canonical place)
or `nearLat` + `nearLng` (a point), plus `radiusM`: a whole number of metres
from 100 to 5000. The parameters are validated with zod
(`artifacts/api-server/src/services/media/MediaSearchService.ts:683#export function parseMediaSearchNear(`).
A half-given center, two centers, or a radius outside the bounds is refused
with 400. It is never clamped and never dropped.

**What "resolved through the canonical Map" means here.** A place's position is
the one the Map's own pipeline would publish for it:

- **The Map's place projector.** The canonical `places` row goes through
  `projectPlace` (`artifacts/api-server/src/lib/mapProjectPlace.ts:205#export function projectPlace(`),
  which drops an inactive, merged, coordinate-less or unservable row.
- **Then the §24 gate.**
  `artifacts/api-server/src/services/media/MediaSearchService.ts:760#for (const obj of applyProtection(objects, zones).objects) {`
  uses the policy from the ONE zone reader
  (`artifacts/api-server/src/services/media/MediaSearchService.ts:772#const zones = await loadActiveProtectedZones(sc);`).
  A place in a suppress-class zone has no position, so it is never near
  anything. A place in a coarsen-class zone sits at the zone's anchor, where
  the Map would draw it.
- **The filter.** Distance runs from that position
  (`artifacts/api-server/src/services/media/MediaSearchService.ts:384#if (nearCtx) matched = await keepWithinRadius(sc, nearCtx, matched);`),
  before places, people, gems and experiences are rolled up.
- **Events and trips.** Those found by name are kept only through a place of
  their own inside the radius
  (`artifacts/api-server/src/services/media/MediaSearchService.ts:541#if (query.near && !(await anyPlaceWithinRadius(sc, query.near, exp.placeIds))) continue;`).

**The rules it stays inside, read before it was written.**

- **The gateway-bypass guard.** The guard reserves `loadViewportPlaceRows` for
  the gateway
  (`artifacts/api-server/src/test/gatewayBypassGuard.test.ts:105#loadViewportPlaceRows: {`).
  It is not called. Search reads `places` BY ID, and only the places a result
  already names. That is the narrower read Discovery's search takes, for the
  reason Discovery gives
  (`artifacts/api-server/src/routes/discoverySearch.ts:1275#WHY IT DOES NOT CALL`):
  search is not a projection, has no viewport, and serves no MapObject. The
  guard suite still passes with no approval added.
- **The zone model.** It is the gateway's alone
  (`artifacts/api-server/src/routes/mapProjection.ts:91#THE ZONE MODEL IS THIS ROUTE'S JOB, AND ONLY THIS ROUTE'S.`),
  which is why MD162 stays blocked. This change reads no `geo_zones` and
  resolves no zone for any place. For the same reason, a center named only as a
  city ("Da Nang") cannot be resolved server-side. It must arrive as a
  canonical place or a point.
- **No coordinate leaves.** The response carries
  `near: { center, radiusM, refusal }`: the center's KIND and the radius, never
  a point. The router's boundary scrub still stands behind it.
- **Only disclosed places.** Candidates are the places the disclosure choke
  point already lets this viewer be told about. So the radius narrows an answer
  and never widens one. A Hidden Gem's ceiling binds first: a place hosting a
  `protected` gem has no disclosed id, so it is never a radius result (tested).
- **A place center.** It goes through the same two steps and nothing else. It
  is deliberately NOT refused for hosting a gem. The Map's place layer
  publishes that position anyway (§24.6, item 2), and a gem-dependent refusal
  would itself answer "is this place a hidden gem?".

**Fail-closed, in two different ways.**

- **An unreadable §24 policy or place read refuses with a retryable 503.** It is
  the same envelope `MediaCandidatesUnavailableError` uses
  (`artifacts/api-server/src/services/media/MediaSearchService.ts:774#throw new MediaSearchNearUnavailableError("protected_zones", "the §24 policy could not be read");`).
- **A center the Map would not place gets an empty answer that says so**
  (`artifacts/api-server/src/services/media/MediaSearchService.ts:355#if (nearCtx?.report.refusal) return answer(emptyResults(nowMs, criteriaUsed));`).
  The unplaceable cases are: unknown, merged, coordinate-less, or suppressed by
  §24.

**Recall.** Stated in the service header: the radius narrows the shared
loader's page, as free text does.

**Client.** `fetchMediaSearch(queryString, { near })` appends the parameters
(`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1386#return path.kind === 'request' ? getJson(path.url, mapMediaSearchWithNear, opts) : Promise.resolve(path.answer);`).
A `near` the server would refuse is refused on the device, with no request
(`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1512#if (near && !nearQs) {`).
Sending the search without it would answer city-coarse under a "near" label.
The server's report is mapped
(`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1532#export function mapMediaSearchWithNear(`).

**The capability boundary string** was reworded in place, keeping its anchor for
§19.6's citation: `artifacts/api-server/src/services/media/MediaSearchService.ts:71#search is city-coarse; the canonical Map owns proximity`.
It now reads "wider than 5 km, or with no center given".

**Tests.**
- Server: `artifacts/api-server/src/test/mediaWorldProjection.test.ts:1952#describe("MD288 — parseMediaSearchNear`
  (3 cases) and
  `artifacts/api-server/src/test/mediaWorldProjection.test.ts:1983#describe("MD288 — §38 'near X' is a radius resolved through the canonical Map's own place contract"`
  (10 cases). Each suppress, coarsen and gem case has a no-zone or no-gem
  CONTROL. Over HTTP:
  `artifacts/api-server/src/test/mediaWorldProjection.test.ts:2145#it("GET /media/search refuses a radius past the bound with 400, and answers a bounded one"`.
- Client: four cases from
  `travel-buddy-standalone/src/features/media/__tests__/searchAndStores.test.ts:294#test('MD288 fetchMediaSearch appends`.

**RED WHEN (narrowed from §19.6):** the Search screen sends `near` with a
center and a bounded radius. The center can be the viewer's coarse position
(the one the World shell already hands the Media Map), the place the search was
opened from, or a place result. A named city is resolved by the client's Map
data, not by Media. The alternative stands unchanged: the owner rules that
city-coarse satisfies "near", which makes this row C as it is. **WHO:** the
Search screen and filter-store owner (lane A's files) together with the World
shell (outside this lane by name), or the owner. Nothing server-side remains.

### 24.4 Mutations — each seen red, the file checked byte-identical after every run

Server (`mediaWorldProjection.test.ts`, 101 tests):

| # | Mutation | Red |
| --- | --- | --- |
| E-M1 | covers never attached | 7 map cases, HTTP map |
| E-M2 | directional pre-filter removed (cover chosen before the override) | hidden-crew builder case, boundary-delivery case, fail-closed case, HTTP map |
| E-M3 | an unreadable directional read treated as "all visible" | fail-closed case |
| E-M4 | a posterless video accepted as a cover | video case |
| E-M5 | cover taken from the whole page, not the cluster's own items | own-items case, video case |
| E-M6 | cover sent as a lone object | 7 map cases, HTTP map |
| E-M7 | the full projection sent as the cover | own-items (slim) case |
| E-M8 | upstream gate dropped: the private-account guard in the loader | the private-account cover case, plus 3 pre-existing private-account cases |
| E-R1 | no radius filter | point, place, suppress, coarsen, gem, places-unreadable, HTTP search |
| E-R2 | radius ignored (×100) | point, place, coarsen, HTTP search |
| E-R3 | §24 skipped (raw rows positioned) | suppress, coarsen, suppressed-center |
| E-R4 | §24 coarsen ignored (raw position, not the anchor) | coarsen |
| E-R5 | unreadable §24 policy treated as no policy | policy-unreadable |
| E-R6 | unreadable place read treated as no places | places-unreadable |
| E-R7 | an unpositioned center falls back to an unfiltered answer | unpositioned-center |
| E-R8 | radius tested on the RAW candidate place id (bypasses disclosure) | protected-gem place |
| E-R9 | events and trips found by name not filtered by `near` | event-by-name |
| E-R10 | route does not refuse an invalid `near` | HTTP 400 |
| E-R11 | parser drops the radius upper bound | parser refusals, HTTP 400 |

Client (`searchAndStores.test.ts` + `mediaOffline.test.ts`, 49 tests):

| # | Mutation | Red |
| --- | --- | --- |
| E-C1 | client drops the covers | fetchMediaMap case, both offline storage cases |
| E-C2 | a posterless video accepted as a cover | fetchMediaMap case |
| E-C3 | `near` never sent | place-center and point-center cases |
| E-C4 | a `near` the server would refuse is sent, which drops it | local-refusal case |
| E-C5 | the near report never mapped | place-center and point-center cases |
| E-C6 | the client's radius upper bound dropped | local-refusal case |
| E-O1 | the map never written to its scope | online/offline case, signer-refusal case |
| E-O2 | an empty map kept as content | "no clusters here" case |
| E-O3 | no age stamped on stored clusters and covers | online/offline case (freshness never decays) |
| E-O4 | read back from a scope it is not written to | online/offline case |
| E-O5 | map thumbnails kept a fortnight | scope-policy case |

Every mutation went red on its first run. None survived, so no test had to be
added for one.

### 24.5 Checks

- **Server tests.**
  - `mediaWorldProjection.test.ts`: 101 / 101.
  - The 81 server test files that import or scan the changed files, run
    together: 1799 / 1799. They include `gatewayBypassGuard`,
    `schemaReferenceStatic`, `silentSchemaErrorCatches`, `mapProjectPlace`,
    `protectedLocations`, `mapProtectionUnreadable`, `mediaAccess` and
    `docCitations`.
- **Client tests.**
  - `searchAndStores` and `mediaOffline` under node:test: 49 / 49.
  - The seven jest suites that render the Media Map, Search, World shell,
    offline lenses, Hidden Gems, context sheet and place consensus: 47 / 47.
- **Types and lint.**
  - `tsc` is clean in both packages.
  - `typecheck:tests` is at baseline in both: 863 and 173 diagnostics. It first
    caught a duplicate import in the new server cases, which was removed.
  - eslint on every changed file: 0 errors.
  - The client's `lint:imports`, `lint:mocks`, `lint:orphan-tests` and
    `lint:bare-image` pass.
- **Census checks.**
  - `check:doc-citations` passes.
  - `check:citation-targets` stays at 165 / 165.
  - `check:census-integrity` passes, with media unchanged at 450 / 398 C / 38 W /
    12 N / 2 X.
  - `check:census-scope-coverage` passes: media 210 of 218 watched, unchanged.
  - `check:test-registration` passes.
  - What `check:census-freshness` flags for the changed counted files is
    reported to the integrator. The acknowledgement ledger is not a lane's to
    edit.
- **Registration.** No new test file was added; every case sits in a file
  already registered or discovered.

### 24.6 Production — nothing here is deployed

Nothing in §24 is merged or deployed. No flag, seed or migration was touched.

**MD300 depends on:**
- the World shell, the only way to reach the Media Map
  (`MEDIA_WORLD_SHELL_ENABLED`, seeded off);
- the canonical Map gateway, which places nothing in production while
  `map_projection_enabled` has no row there (§23.1);
- the screen wiring in §24.2.

Covers come from `post_media` while `media_canonical_read_enabled` is off, so
there are covers only where there is media.

**MD288:**
- The route change is live on deploy. It has no flag, and it answers only
  callers that send `near`, which today is none.
- `protected_zones` exists in production with zero rows (applied 2026-09-21, per
  `checkProductionDrift.ts`). So `applyProtection` is an identity pass there
  and positions are the canonical rows' own. That is exactly what the Map would
  publish.
- How many canonical `places` in production carry coordinates was not measured
  by this lane. It read no database.
- The search itself is reached only through the dark World shell.

### 24.7 Found outside the rows — recorded, not fixed

1. **Counts include items the directional override hides.** A cluster's
   `perspectiveCount` is taken from its items
   (`artifacts/api-server/src/services/media/MediaProjectionService.ts:1649#perspectiveCount: z.items.length,`)
   before the router's directional filter runs. That filter prunes item arrays,
   not numbers. The `/media/world` zone counts work the same way. A crew member
   who hid themselves from the viewer in a trip is therefore still counted at
   that place, which discloses existence (not identity). The covers above do
   not have this problem. **Owner:** the projection and visibility owner.
2. **The Map's place layer does not consult Hidden Gem sensitivity.** Between
   `projectPlace` and the wire, no step was found that joins a place to a gem.
   The gateway's place task, `projectPlace` and the map libraries were read.
   A canonical place linked to a `protected` gem is therefore drawn at
   `place_level`, while the gem layer withholds that gem's coordinates. What
   stays protected is the association, not the position. This lane's radius
   mirrors the Map rather than diverging from it. Recorded for census-map to
   confirm.
3. **A stale header.** The header of `MediaSearchService` still says its
   client half is "still unbuilt and its census rows stay N" (lines 6–8), but
   MD324 is C (§23.5). Comment only. It was left alone because it is not in
   this lane's change.

## 25. Lane F — World items explain themselves from the terms that ranked them (§47) — 2026-09-26

Lane F of the Media pass owns one row, **MD428**. The work is on branch
`worktree-agent-a8c9a2ac918e3010e`, cut from `b1903565b`, the head of
`claude/sensing-completion-20260925` with lanes A–D merged. **MD428 moves
`W → C`** on built, tested and mutated work. No other row moves.

As in §21, every statement here is an IMPLEMENTATION claim. §25.8 gives the
production state, and it is dark. This lane wrote no migration, enabled or
seeded no flag, and read or wrote no database.

§23 says a later lane's section goes above it. This section is at the end
because the lane brief said to put it there. The integrator may move it; no
citation in it depends on where it sits.

### 25.1 The row's text is out of date on one point

§19's MD428 row states its falsifier as "a §47 explanation on World items built
from the five named reasons, two of which (MD184, MD185) are not ranking inputs
today". That was true at §14 but is not true now:
- §21 moved **MD184** `N → C`: a live-qualified claim is now a ranking input (V05).
- **MD185** (Freshness) has been `C` since the first census, and freshness is also a term of the §24 World ranker.

So each of §47's five reasons now has a ranker term:

| §47 bullet (verbatim) | §24 input | Ranker term | Weight |
| --- | --- | --- | --- |
| "Nightlife matches your current intent" | Viewer intent | `artifacts/api-server/src/lib/mediaRankingSignals.ts:299#export function intentTerm(` | 0.12 |
| "7 minutes away" | Current location | `artifacts/api-server/src/lib/mediaRankingSignals.ts:349#export function locationTerm(` | 0.04 |
| "Fresh perspectives from the last 10 minutes" | Freshness | `artifacts/api-server/src/lib/mediaRankingSignals.ts:431#export function freshnessTerm(` | 0.07 |
| "Area activity is increasing" | Live state, minus "− Low-confidence Live Claims" | `artifacts/api-server/src/lib/mediaRankingSignals.ts:415#export function liveTerm(` minus `artifacts/api-server/src/lib/mediaRankingSignals.ts:425#export function lowConfidenceLiveTerm(` | 0.06 − 0.08 |
| "You've saved nearby places" | Discovery behavior | `artifacts/api-server/src/lib/mediaRankingSignals.ts:409#export function discoveryTerm(` | 0.04 |

The mapping is at
`artifacts/api-server/src/services/media/MediaExplanationService.ts:117#export const SECTION_47_REASONS`.
The test reads the five bullets from the spec text and each §24 input from
`SPEC_24_COVERAGE`, so a reason cannot be mapped to a term that does not
implement it.

The row's statements about the CLIENT still hold, and the client code was not
changed:
- The card offers "Why this?" only when a reason is served: `travel-buddy-standalone/src/features/media/components/ChangingNowCard.tsx:84#{item.whyThis && onWhyThis ? (`.
- The shell opens the sheet with exactly that reason: `travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:139#if (item.whyThis) setWhy({ visible: true, explanation: item.whyThis });`.
- The changing-now mapper already reads the field: `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:448#whyThis: asString(raw.whyThis),`.

The missing piece was on the server: nothing sent a reason.

### 25.2 What was built

**The ranker returns the scores it ordered by.** `rankMediaCandidates` and
`rankCandidatesForViewer` now take an optional `scoresOut` map. It is filled
with the same `MediaRankingScore` object each row was ranked on:
`artifacts/api-server/src/services/media/MediaRankingService.ts:224#for (const e of scored) scoresOut?.set(String(e.row.id), e.score);`
and `artifacts/api-server/src/services/media/MediaRankingService.ts:300#}, scoresOut);`.
The change is additive: the order and the set of rows are unchanged, and a test
checks both. The World builder creates the map at
`artifacts/api-server/src/services/media/MediaProjectionService.ts:800#const scores = new Map<string, MediaRankingScore>();`
and passes it through at
`artifacts/api-server/src/services/media/MediaProjectionService.ts:661#}, scoresOut),`.

**The explanation reads only those scores.** Three functions do the work:
- `artifacts/api-server/src/services/media/MediaExplanationService.ts:142#export function reasonLift(` computes each reason's lift from the ranker's score.
- `artifacts/api-server/src/services/media/MediaExplanationService.ts:243#export function explainWorldZone(` turns the material reasons of a zone's perspectives into §47 bullets.
- `artifacts/api-server/src/services/media/MediaExplanationService.ts:270#export async function explainWorldZones(` writes the bullets onto the World zones. It is called once per page at `artifacts/api-server/src/services/media/MediaProjectionService.ts:836#await explainWorldZones(`.

**The served shape.** `WorldZone` gains two fields: `whyThis` (the bullets,
strongest first, one per line) and `whyThisReasons` (the same reasons as codes).
They are declared at
`artifacts/api-server/src/services/media/MediaProjectionService.ts:1740#export interface WorldZone {`,
at the end of the file, so no cited line above it moved. `changingNow` is a
filter over the same zone objects, so each changing-now card carries its zone's
explanation. A zone with no reason has no `whyThis` key at all
(`artifacts/api-server/src/services/media/MediaExplanationService.ts:255#if (best.size === 0) return null;`),
and nothing on the path falls back to a generic sentence.

**What counts as a World item here.** `GET /media/world` serves two kinds of
entry:
- **Zones**: `cityVisualState`, and `changingNow` drawn from it. The zone is the item the client offers "Why this?" on.
- **Per-category counters**: `forYouNow`, for example "Food · 3 fresh". These are counts rather than items. They carry no explanation, and the client shows no "Why this?" on them.

### 25.3 What "materially contributed" means, and how it is tested

A reason's LIFT is how much its term added to the score beyond what the ranker
gives an item it knows nothing about. That baseline is the ranker's own score
for a bare row
(`artifacts/api-server/src/services/media/MediaExplanationService.ts:136#export function neutralRankingScore(): MediaRankingScore {`),
so the neutral value for freshness is the ranker's own 0.5.

    lift = w × (t − t_neutral)          (area activity also subtracts w_penalty × p)

A reason is MATERIAL when its lift is at least **0.03**, a quarter of the
largest single weight. The threshold is defined at
`artifacts/api-server/src/services/media/MediaExplanationService.ts:126#export const MATERIAL_LIFT =`
and applied at
`artifacts/api-server/src/services/media/MediaExplanationService.ts:159#if (lift >= MATERIAL_LIFT) out.push({ reason: r.reason, lift });`.
Reasons are listed strongest lift first. An exact tie keeps §47's order.

| Reason | Admitted | Not admitted, although the term is non-zero |
| --- | --- | --- |
| intent | wanted item 0.12, wanted place 0.096, wanted category 0.06 | — |
| distance | a trip active today in the media's city, 0.04 | the viewer's home country, 0.012 |
| freshness | posted within about 12.4 hours (at 12 hours: 0.0302) | at 13 hours: 0.0298; at one day: 0.0257 |
| area activity | a live-qualified claim, 0.06 | the same claim with a material conflict, 0.06 − 0.08 < 0 |
| prior saves | a place the viewer saved, 0.04 | — |

### 25.4 What each reason says, and where it differs from §47's example

Each sentence states what its term measured, at the level of detail the term
measured:

| Reason | Served sentence | Why it differs from the example's words |
| --- | --- | --- |
| intent | "You marked a perspective here as one you want", "You want to go to {place}", or "{Category} matches what you want" | The sentence follows the level the term matched: item, place or category. |
| distance | "In {city}, where you're travelling now" | The ranker never reads the viewer's position (`artifacts/api-server/src/lib/mediaRankingSignals.ts:345#Current location (§24). Media never carries the viewer's GPS`), so no term computes minutes. |
| freshness | "A fresh perspective, posted in the last 10 minutes" (then 30 minutes, an hour, then whole hours) | The term reads how long ago the post was published, so the sentence says "posted". |
| area activity | "Live reports of what's happening here right now" | The term reads whether a live-qualified claim EXISTS, not a trend. "Is increasing" would claim a direction the ranking never used. |
| prior saves | "You saved this place" | The term fires for media AT a saved place, not near one. |

**This leaves one decision for the owner.** MD428's requirement is an
explanation "naming intent match, distance, perspective freshness, area
activity and prior saves". This section grades it `C` because each of those
reasons is named, from the term that ranked the item.

If the owner reads §47's bullets as literal copy (minutes of travel, a rising
trend), the row goes back to `W`. Each of those two would first need a new
RANKER term:
- **A distance term from the viewer's position.** This is a privacy decision. The ranker refuses the viewer's GPS by design, and the sheet's own footnote promises "We never use your exact location to rank content".
- **A trend term over the gated `crowd.trajectory` claim.**

Adding either term is outside this lane. Until one exists, the explanation must
not say anything the ranking did not use.

### 25.5 Privacy: the explanation discloses nothing the viewer is not already served

- **Only the viewer's own signals and what is already served.** Three of the five reasons come from the viewer's own wants, trips and saves. Freshness is the age of a perspective the viewer is already served. Activity comes from the zone's own served live claims. Other people's follows, saves, visits and crews are not §47 reasons, and none of them is read here.
- **Only zones keyed by a canonical place, and only from perspectives served AT that place.** A zone with no place is never explained: `artifacts/api-server/src/services/media/MediaExplanationService.ts:244#if (!zone.placeId) return null;`. A perspective contributes only when the zone's place is on both its served projection and its row: `artifacts/api-server/src/services/media/MediaExplanationService.ts:247#if (item.projection.placeId !== zone.placeId || item.row.canonical_place_id !== zone.placeId) continue;`. When the owner or a hosting Hidden Gem withholds a perspective's place, that perspective is not in a place zone, so the viewer's own save or want of the place cannot surface through it.
- **The circle-override filter runs on the inputs.** The route's payload filter removes media objects, but it cannot see inside a zone. The explanation therefore filters the items first: `artifacts/api-server/src/services/media/MediaExplanationService.ts:283#visible = (await filterMediaProjectionVisibility(sc, viewerId, all))` and `artifacts/api-server/src/services/media/MediaExplanationService.ts:296#if (!visibleIds.has(projection.id)) continue;`. If the filter cannot decide, no zone is explained: `artifacts/api-server/src/services/media/MediaExplanationService.ts:287#if (!Array.isArray(visible)) {`.
- **A reason is dropped when the projection withholds what it rests on.**
  - The city sentence needs the served city: `artifacts/api-server/src/services/media/MediaExplanationService.ts:222#if (!city || norm(city) !== norm(row.location_city)) return null;`.
  - The category sentence needs the served category: `artifacts/api-server/src/services/media/MediaExplanationService.ts:217#if (!cat || cat !== norm(row.category)) return null;`.
  - The activity sentence needs the zone's served claims: `artifacts/api-server/src/services/media/MediaExplanationService.ts:231#return zone.liveClaims.length > 0`.
- **The k-floor.** §21's gem outcome shows no number below `OUTCOME_MIN_REPORTERS = 3` distinct reporters, because each number is a fact about people the viewer cannot see. The explanation here contains no count of perspectives or people and no total over anyone else, so there is nothing for that floor to apply to. Any later reason that does emit a count must apply the floor, and the module header says so.

### 25.6 Tests, and the mutations that turned them red

**Server tests.** 25 cases were added to the already-registered
`src/test/mediaRankingObjectives.test.ts`, in five blocks:
- `artifacts/api-server/src/test/mediaRankingObjectives.test.ts:708#describe("MD428 — §47's five reasons`: the spec mapping, the definition of MATERIAL, and the returned scores.
- `artifacts/api-server/src/test/mediaRankingObjectives.test.ts:748#describe("MD428 — one case per §47 reason`: one case per reason and level, plus the ordering.
- `artifacts/api-server/src/test/mediaRankingObjectives.test.ts:817#describe("MD428 — 'materially contributed' is a threshold`: the threshold cases.
- `artifacts/api-server/src/test/mediaRankingObjectives.test.ts:854#describe("MD428 privacy`: the privacy cases.
- `artifacts/api-server/src/test/mediaRankingObjectives.test.ts:893#describe("MD428 — GET /media/world serves`: runs the real loader, ranker and World builder over a fake database. One case goes over HTTP: `GET /api/media/world` with the router mounted.

**Client test.** One case,
`travel-buddy-standalone/src/features/media/__tests__/MediaWorldShell.component.test.tsx:282#it('NOW: "Why this?" opens the §47 reasons the SERVER derived`.
A zone in the served shape shows its reasons word for word in the sheet. A zone
served without one offers no "Why this?".

**Mutations.** Each mutation was applied to the tree, the suite run, and the
file restored.

| Mutation | What was changed | What turned red |
| --- | --- | --- |
| F1 | the intent_match and prior_saves term mappings swapped | "intent — the wanted item itself", "intent — a wanted place", "intent — a wanted category, §47's own example", "prior saves — a place the viewer saved", "each reason is the §24 input SPEC_24_COVERAGE says its term implements", and the World-builder and HTTP cases (10) |
| F1b | the distance and fresh_perspective term mappings swapped | "distance — …", "freshness — a perspective posted minutes ago", the day-old threshold case, two privacy cases, and the World-builder, override and HTTP cases (10) |
| F2 | the materiality filter removed | 20 cases, including every per-reason case and "the viewer's home country scores 0.3 on location and is NOT 'distance'" |
| F2b | "material" weakened to any positive lift | 18 cases, including the home-country, day-old and conflicted-claim cases |
| F3 | a fallback sentence emitted when no reason applies | 11 cases, including "perspectives lifted only by terms §47 does not name get NO explanation — not a generic one" and "a zone's reasons are the ranker's material terms for its perspectives; a zone with none has no whyThis key" |
| F4 | the explanation recomputes scores itself instead of reading the ranker's | the World-builder case, the withheld-place case, the undecidable-filter case and the HTTP case |
| F5 | the ranker stops filling `scoresOut` | "rankMediaCandidates hands back, per row, the very score it ordered by — and passing the map changes nothing", and the World-builder, override, withheld-place and HTTP cases |
| F6 | the circle-override filter skipped | "a perspective hidden from this viewer by a circle override cannot speak for its zone" |
| F7 | a perspective not served at the zone's place accepted | "a perspective not served AT the zone's place contributes nothing, and a zone with no place is never explained" |
| F8 | the raw city stated whether or not it is served | "the city sentence needs the SERVED city, the category sentence the SERVED category" |
| F9 | activity stated without the zone's served claims | "the activity sentence needs the zone's own served live claims" |
| F10 | the low-confidence penalty removed from area activity | "a live claim the ranker penalised as materially conflicted is NOT 'activity'" |
| F11 | explain anyway when the filter cannot decide | **survived its first form** (see below); then red: "when the circle-override filter cannot decide, no zone is explained — and there is no fallback sentence" |
| F12 | lift measured from zero instead of from the ranker's neutral item | 19 cases: freshness' neutral value is 0.5, so every item read as fresh |
| F13 | the World builder never explains | the World-builder, override, withheld-place and HTTP cases |
| F14 | reasons listed in §47 order rather than by lift | "several reasons: strongest lift first, an exact tie in §47's order" |
| F15 | a zone keyed by no place explained | **survived at first** (see below); then red: "a perspective not served AT the zone's place contributes nothing, and a zone with no place is never explained" |
| F16 | the category stated whether or not it is served | "the city sentence needs the SERVED city, the category sentence the SERVED category" |
| mC1 | the shell opens the sheet without the served reason, so the generic sentence shows | client: the MD428 shell case |
| mC2 | the changing-now mapper drops `whyThis` | the same case |
| mC3 | the card offers "Why this?" with no served reason | the same case |

**Two mutations did not turn anything red on their first form. Both are reported here:**
- **F11.** The first form set the fallback but left the `return` beneath it, so it changed nothing. Rewritten to fall through with every item, it turns red.
- **F15.** No test put a perspective with no place into a zone with no place. Every placeless zone the tests built held only items that the per-item place check already refused. The case now includes such a perspective: its distance term is material, and the reason is still not stated. F15 then turns red.

**Checks, from `artifacts/api-server` unless noted.**
- `tsc --noEmit`: clean.
- `typecheck:tests`: at baseline, 863 diagnostics across 115 files.
- `check:doc-citations`: clean.
- `check:citation-targets`: 165 / 165.
- `check:census-scope-coverage`: passed.
- `check:census-integrity`: the rows now count C 399 / W 37 / N 12 / X 2, which is this row's move. The check exits non-zero with exactly one error: §23.6's stated headline (C 398 / W 38) no longer matches those rows. The lane brief reserves restating the headline for the integrator, so this section does not restate it.
- No new server test file was added, so `check:test-registration` is unchanged.
- eslint on the changed server files: 0 errors.
- Client (`travel-buddy-standalone`):
  - `tsc --noEmit`: clean.
  - `typecheck:tests`: at baseline, 173 across 60.
  - eslint on the changed test: 0 errors.
  - The shell component suite: 11 / 11.
  - `mediaProjection` and `worldState`: 45 / 45, run with `--import tsx`, the Node 22 local equivalent that `scripts/run-node-tests.mjs` selects.

### 25.7 Row move

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD428 | **W** | **C** | Every zone `GET /media/world` serves carries a §47 explanation built only from the five reasons. Each reason comes from the ranker term that implements it, read from the score the ranker ordered by, and appears only where that term materially lifted a perspective served at the zone's place (§25.2, §25.3). Where no reason applies there is no explanation and no fallback. Privacy as in §25.5. The client shows the served reason word for word. Server mutations F1–F16 and client mutations mC1–mC3 turned red (§25.6). The grade reads §47's bullets as example copy; a literal reading is the owner's decision (§25.4). |

### 25.8 Branch versus production

**Nothing here is deployed.** The work is built on this lane's branch and is
neither merged nor deployed.

The World shell that renders the sheet is dark. `MEDIA_WORLD_SHELL_ENABLED` is
seeded
(`artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql:115#'MEDIA_WORLD_SHELL_ENABLED',`)
as
`artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql:116#false,`,
and it is OFF in production (§14 F1). This lane did not re-read production (no
database was queried) and enabled nothing.

`GET /media/world` has no flag of its own. Once this code ships, the field is
sent to any signed-in caller of that endpoint, while no reachable screen shows
it. Two of the reasons also depend on production state this lane did not
change:
- Area activity needs the gated live path. That path is fail-closed and serves nothing while live is off.
- Intent needs rows in `media_intent_signals`.

Realising MD428 in production takes three steps: merge, deploy, and the
integration owner's flag decision in §14 F1.

### 25.9 Found outside this row: recorded, not fixed

1. **`/media/world`'s zone and bucket totals count a perspective the viewer is not allowed to see.**
   - **Measured on this lane's fixture.** An author's trip post was hidden from the viewer by a `hide_me_from` circle override. The place's zone still served `perspectiveCount` 2, `freshness` "fresh" (coming from the hidden post) and `totalPerspectives` 2. The Food bucket served `freshPerspectives` 1.
   - **Why the filter misses them.** The route's filter, `filterMediaProjectionVisibility`, removes media OBJECTS. Zones and buckets carry no media objects, so the filter cannot reach their counts. `buildWorldProjection` computes them before the filter runs.
   - **Effect on this row.** The explanation built here applies the filter to its own inputs, so it does not widen the leak. The counts, however, already disclose the recency that the explanation withholds.
   - **Owner:** the World builder, together with the §33 visibility owner (`lib/mediaVisibility`). It is not part of MD428.
2. **The sheet's footnote describes a different ranker.** The footnote reads `travel-buddy-standalone/src/components/media/WhyThisSheet.tsx:81#Your feed is shaped by your travel interests, the places you've explored, and creators you engage with.` The World ranker reads no engagement by design; it reads the follow graph. The sheet is shared with Watch and Gems, whose ranker does read engagement. The copy is static and belongs to the client lane, and this section does not grade it.

## 26. Lane G — three C grades re-read against the spec, and the message-poster test — 2026-09-26

Built on `claude/sensing-completion-20260925` at `b1903565b` (§23.7). §22.6
items 2–3 and §23.4 recorded three `C` rows as possibly wrong. Each is re-read
here against the spec's own sentence and against the code at that commit. This
section also adds the messaging test §23.4 said was missing. Earlier rows are
not edited; the table below is the later statement.

This section is appended at the file's end because this lane was told to put
it there. §23's opening says the integration section stays last. The
integrator places it.

### 26.1 Row moves

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD152 | **C** | **C** | **The old `C` was overstated, and it is now proven.** The spec asks for it wherever reports disagree (`docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt:210#When reports disagree, surface uncertainty`). The server emits the line on the place projection (`artifacts/api-server/src/services/media/MediaProjectionService.ts:954#consensus: buildVisualConsensus(media, currentState.claims, nowMs, {`) and on every world zone (`artifacts/api-server/src/services/media/MediaProjectionService.ts:830#consensus: buildVisualConsensus(z.items, current.claims, nowMs, {`). The client rendered it on the place view only. Both zone mappers dropped it, so the NOW lens's city pulse, its "Changing now" cards and the Places lens's zone list showed a disputed zone exactly like one whose reports agreed. The "Changing now" card is the case that matters. It is filtered to zones WITH a live claim (`artifacts/api-server/src/services/media/MediaProjectionService.ts:838#const changingNow = cityVisualState.filter((z) => z.liveClaims.length > 0);`), and those are the only zones whose claims can conflict. Its crowd label is the plurality value even under a material conflict (`artifacts/api-server/src/services/media/MediaProjectionService.ts:738#crowdLabel = typeof level === "string" && level.length > 0 ? level : null;`). So a disputed zone showed a confident state and nothing else. **Now:** both mappers keep the line (`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:399#uncertaintyLabel: zoneUncertainty(raw.consensus),` and `travel-buddy-standalone/src/features/media/services/mediaProjection.ts:450#placeId: asString(raw.placeId), uncertaintyLabel: zoneUncertainty(raw.consensus),`). They use the place view's rule, which never invents a line and never drops one (`travel-buddy-standalone/src/features/media/services/mediaProjection.ts:1413#function zoneUncertainty(rawConsensus: unknown): string | null {`). Three surfaces render it: the city pulse (`travel-buddy-standalone/src/features/media/components/CityVisualPulse.tsx:81#<Text style={styles.uncertainty} accessibilityRole="alert"`), the changing-now card (`travel-buddy-standalone/src/features/media/components/ChangingNowCard.tsx:78#<Text style={styles.uncertainty} accessibilityRole="alert"`) and the Places zone list (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:124#<ZoneUncertainty zone={z} />`). Tests: `travel-buddy-standalone/src/features/media/__tests__/worldZoneUncertainty.component.test.tsx:69#it('a mixed zone carries the line on the city pulse AND on its changing-now card`, `travel-buddy-standalone/src/features/media/__tests__/worldZoneUncertainty.component.test.tsx:75#it('never invents one`, `travel-buddy-standalone/src/features/media/__tests__/worldZoneUncertainty.component.test.tsx:89#it('NOW lens: under the disputed zone`, `travel-buddy-standalone/src/features/media/__tests__/worldZoneUncertainty.component.test.tsx:102#it('Places lens overview: under the disputed zone in the list`. Mutations u1–u6, each seen red (§26.2). Dark: all three surfaces are in the World shell. |
| MD153 | **C** | **C** | **Re-proven, and one earlier finding is corrected.** §22.6 item 3 said the prompt was "mounted nowhere". That is false. It has been mounted since #305 on the place detail screen (`travel-buddy-standalone/app/place/[id].tsx:423#<RequestAViewPrompt placeId={canonicalPlace.id} city={city} />`), but only on the classic fallback branch. That branch renders when `live_places_enabled` is off or the living read returns nothing (`travel-buddy-standalone/app/place/[id].tsx:383#if (canonicalPlace !== null && living !== null) {`). What was actually wrong is below. **The spec's prompt** (`docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt:212#Last visual update 28m agoShow what's happening?Is the entrance still busy?[Quiet] [Moderate] [Busy] [Take Photo]`) is a MISSION: the viewer who is there shows what is happening. Request a View, which asks OTHER people, is the next sentence and its own row, MD154. The component had only the Request-a-View half. It was absent from the Media place view (§13), and the §18 flag the server says routes to it (`artifacts/api-server/src/services/media/MediaConsensusService.ts:132#requestAnotherObservation: boolean;`) reached nothing. **Now** it is mounted on the Places lens's place view, both when the view is ready (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:264#</View><PlaceMissionPrompt`) and when a place has no picture yet (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:245#{state.status === 'empty' ? <PlaceMissionPrompt`). It mounts only for a canonical place (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:399#if (!UUID_RE.test(placeId)) return null;`). §18 is routed to it (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:405#requestAnotherObservation={consensus?.requestAnotherObservation === true}`). It shows on a stale or absent picture, or on a dispute, but never on a coverage that could not be read (`travel-buddy-standalone/src/features/media/components/RequestAViewPrompt.tsx:313#return flagEnabled && coverage !== null && requestAnotherObservation === true;`). The mission actions are: [Take Photo] opens this lens's existing §4 contribution (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:406#onTakePhoto={onContribute ? () => onContribute(placeId) : undefined}`), and [Quiet] [Moderate] [Busy] opens the existing Quick Signal composer for this place in its `arrival` context (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:409#pathname: '/intel/quick-signal',`). The answer chip keeps Intelligence Gathering's own gates, its flag and no Safe Return (`travel-buddy-standalone/src/features/media/components/RequestAViewPrompt.tsx:71#const captureGate = enabled && Boolean(onAnswerNow) && isEnabled(INTEL_FLAGS.quickSignal);`, `travel-buddy-standalone/src/features/media/components/RequestAViewPrompt.tsx:73#const canAnswer = captureGate && !safeReturn.active && !safeReturn.loading;`). Those are the same two the Living page's "Share a signal" uses (`travel-buddy-standalone/src/components/place/living/LivingDestinationPage.tsx:375#const showShare = captureEnabled && !safeReturnActive;`). **Same job, different shape**, stated rather than hidden: the answer is one tap into the composer, whose options are dead / quiet / good energy / busy / packed. It is not three inline chips. The composer keeps its own consent gate and private default, and no write happens from the Media card. The place detail mount is unchanged, with the Request-a-View half only. Tests: `travel-buddy-standalone/src/features/media/__tests__/requestAViewMission.component.test.tsx:108#it('flag on and coverage stale`, plus eleven more cases in that file (`travel-buddy-standalone/src/features/media/__tests__/requestAViewMission.component.test.tsx:107#describe('MD153`). Mutations m1–m11, each seen red (§26.2). **RED WHEN** the Quick Signal composer stops accepting `subjectId` with `context: 'arrival'`, the answer chip shows while `intel_capture_quick_signal` is off or Safe Return is active, or a place view renders without the prompt while the flag is on and its coverage is stale. |
| MD262 | **C** | **W** | **The `C` rested on a protection, not on a choice.** In the spec, "Show neighborhood only" is one of the five §34 Delayed Publishing options a person picks when they post (`docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt:313#Show neighborhood only`). The row cited line 98 of mediaLocationVisibility.ts, which is stale; the case is at `artifacts/api-server/src/lib/mediaLocationVisibility.ts:110#case "approximate":`. That is `gemSensitivityToCeiling`: a Hidden Gem's sensitivity capping media NEAR the gem. Nobody posting media can choose it. **FALSIFIER, measured:** (1) The owner's post modes have no neighbourhood mode (`artifacts/api-server/src/lib/mediaLocationVisibility.ts:385#export const POST_LOCATION_PRIVACY_MODES = [`), and the mode-to-ceiling map sends every restrictive mode to `city` (`artifacts/api-server/src/lib/mediaLocationVisibility.ts:412#export function locationPrivacyModeToCeiling(`). (2) The canonical writer never sends `media_assets.location_visibility` (`artifacts/api-server/src/lib/mediaAssets.ts:24#(location_visibility is never sent by this writer)`), and the legacy feed read defaults a post to `place` (`artifacts/api-server/src/routes/mediaFeed.ts:230#locationVisibility: (row as any).location_visibility ?? "place",`). (3) One per-post `neighborhood` input exists: `POST /posts` accepts it (`artifacts/api-server/src/lib/postSchemas.ts:224#locationVisibility: pulseLocationVisibility.optional(),`) and hands it only to the Pulse geo-tag writer (`artifacts/api-server/src/routes/posts.ts:864#locationVisibilityOverride: (locationVisibility ?? null) as any,`). No client sends it: `grep -rn locationVisibility` over the client's composers and post service returns nothing. No Media route reads `pulse_geo_tags`. The client's four-way selector, whose third option is `neighborhood` (`travel-buddy-standalone/src/components/selectors/LocationPrivacySelector.tsx:23#{ value: 'neighborhood', label: 'Area', sub: 'Neighborhood', Icon: MapPin },`), is mounted nowhere. **Not built here, because it is a privacy and product change.** The options are a new post location mode that Media's disclosure honours, or making Media honour `pulse_geo_tags`. Either one widens what a poster can publish, and the owner decides. **RED WHEN** a person posting media can choose neighbourhood-only, and every Media read discloses that post at no finer than `neighborhood`. **Blocker: owner decision.** |

**Headline.** It is not restated here. MD262's move leaves the rows one `C`
lower and one `W` higher than §23.6 states, so `check:census-integrity` reports
that difference until the integrator restates. MD152 and MD153 do not move.

### 26.2 Mutations, every one seen red on the final tree and restored

Each mutation was one exact-string change, run, then restored from a copy made
before the runs. The file's hash was checked against the copy after every run.

| Mutation | File | Red |
| --- | --- | --- |
| m1 the prompt unmounted from the ready place view | MediaPlacesScreen | 7 of 12 MD153 cases |
| m2 the prompt unmounted from the empty place view | MediaPlacesScreen | "a place with no current picture yet" |
| m3 a §18 dispute never prompts | RequestAViewPrompt | the §18 case, the pure case |
| m4 a dispute prompts on an unread coverage | RequestAViewPrompt | the §18 case, "could not be read", the pure case |
| m5 Safe Return ignored | RequestAViewPrompt | both Safe Return cases |
| m6 the capture flag ignored | RequestAViewPrompt | the first case (answer chip must be absent) |
| m7 Take a photo not wired | MediaPlacesScreen | 4 cases |
| m8 the canonical-place guard removed | MediaPlacesScreen | "a label-only zone never asks" |
| m9 the answer opens the wrong composer context | MediaPlacesScreen | the answer case |
| m10 the §18 flag not routed | MediaPlacesScreen | the §18 case |
| m11 the `media_request_a_view_enabled` gate removed | RequestAViewPrompt | "flag off: nothing renders" |
| u1 the city-pulse mapper drops the line | mediaProjection | all 4 MD152 cases |
| u2 the changing-now mapper drops the line | mediaProjection | the mapper case, the NOW-lens case |
| u3 the city pulse does not render it | CityVisualPulse | the NOW-lens case |
| u4 the changing-now card does not render it | ChangingNowCard | the NOW-lens case |
| u5 the Places zone list does not render it | MediaPlacesScreen | the Places case |
| u6 every zone gets the line | mediaProjection | all 4 MD152 cases |

m4 went red partly by crashing: the prompt rendered before its coverage was read, and dereferenced null. That is red, and it is also the reason the rule exists.

### 26.3 The message-video poster test §23.4 asked for

Lane D changed what `uploadMedia` stores as a message video's thumbnail. It is
now the poster the server writes at the video's derived path. The upload route
returns the video as its relay path (`artifacts/api-server/src/routes/posts.ts:254#const mediaRelayUrl =`),
and the poster route returns `post-media/<video>.poster.jpg`. The byte gate decides
a poster as its video (`artifacts/api-server/src/lib/mediaAccess.ts:369#{ const posterOf = derivedPosterBase(path); if (posterOf !== null) return decide(sc, viewerId, bucket, posterOf); }`),
and a video carried by a message is decided in branch 3c
(`artifacts/api-server/src/lib/mediaAccess.ts:594#.or(`). `mediaAccess.ts` was
not edited.

The tests are appended to an existing registered file,
`artifacts/api-server/src/test/mediaAccess.test.ts:1658#describe("a message video's derived poster is shown to exactly its thread (census-media §26)"`.
They use the rows the real writers produce:
- a thread member loads the poster and an outsider does not (`artifacts/api-server/src/test/mediaAccess.test.ts:1672#it("a thread member loads the poster; an outsider does not"`);
- the poster is served when the row names no thumbnail, because it is decided as its video (`artifacts/api-server/src/test/mediaAccess.test.ts:1686#it("the poster is decided as its VIDEO`);
- a member who has left is refused (`artifacts/api-server/src/test/mediaAccess.test.ts:1702#it("a member who has LEFT the thread is refused the poster"`);
- the §14.3 history bound applies (`artifacts/api-server/src/test/mediaAccess.test.ts:1709#it("the §14.3 history bound applies to the poster`);
- a message naming someone else's video is not a key (`artifacts/api-server/src/test/mediaAccess.test.ts:1724#it("a message naming SOMEONE ELSE's video`);
- on the wire, a member gets a signed 302 and an outsider a 403 (`artifacts/api-server/src/test/mediaAccess.test.ts:1747#it("a member is redirected to a signed poster URL; an outsider gets 403"`).

Every denial carries an allowing control. Suite: 89 tests, 0 failures.

| Mutation (on `mediaAccess.ts`, restored byte-identical) | Red |
| --- | --- |
| G1 the §37 poster rule removed | "decided as its VIDEO" |
| G2 3c membership not required | the member/outsider case, "decided as its VIDEO", "LEFT", the wire case, and the pre-existing "message media: thread member allowed, outsider denied" |
| G3 the §14.3 window ignored | the history-bound case |
| G4 the sender need not own the object | "SOMEONE ELSE's video", and the pre-existing MEDIA-2 case |

**G1 left the first case green, and that is a finding, not a gap.** A message's
poster is authorized twice: by the poster rule (as its video) and by 3c's own
`media_thumbnail_url` clause, because the poster's path owner is the sender.
The two agree today. The null-thumbnail case is what makes the poster rule
load-bearing, and it is what G1 turned red.

### 26.4 Production

**Nothing here is deployed**, and no flag was changed. No database was read,
so every production statement below is a seed or an earlier section's
reading, not a new one.
- **MD152:** all three new surfaces are inside the Media World shell, which
  `MEDIA_WORLD_SHELL_ENABLED` keeps dark (seeded `false` by 2300).
- **MD153:** the place-view prompt needs both the World shell and
  `media_request_a_view_enabled` (seeded `false` by 2257; this census records
  2257's tables as absent from production, §6). Its answer chip also needs
  `intel_capture_quick_signal` (seeded `false` by 2165). The place detail mount
  is unchanged and needs `media_request_a_view_enabled`.
- **MD262:** nothing was built.
- **The poster test:** it changes no behaviour.

### 26.5 Found while doing it — recorded, not fixed

1. **Media shows a zone's plurality crowd state under a material dispute.**
   `readCurrentState` takes the crowd value from the rich envelope (§26.1,
   MD152). The legacy string read refuses it under the same conflict
   (`artifacts/api-server/src/lib/liveClaimRead.ts:461#if (crowd.conflictState === "material") return null;`).
   The "Mixed reports" line now accompanies the state. Whether the state chip
   should also be withheld is a projection change in
   `MediaProjectionService.ts`, and it is left for its owner.
2. **The mobile reachability ledger** lists `RequestAViewPrompt.tsx` as the
   consumer of the visual-coverage and view-request routes with
   `"screens": []`. Its line numbers for `viewRequest.ts` (312, 366) are behind
   this tree's (332, 386). The ledger is pinned to commit `22ab17151b98…`, which
   this clone does not contain. Whether `"screens": []` was already wrong at
   that pin cannot be checked here.
3. **MD262's own citation**, line 98 of mediaLocationVisibility.ts, is
   unanchored and stale; the case is on line 110. It is superseded by the row
   above, not repointed.

### 26.6 Counted files this section changed

- **Counted by census-media only:**
  - `travel-buddy-standalone/src/features/media/components/RequestAViewPrompt.tsx`;
  - `CityVisualPulse.tsx`, `ChangingNowCard.tsx`;
  - `travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx`;
  - `travel-buddy-standalone/src/features/media/services/mediaProjection.ts`;
  - `travel-buddy-standalone/src/features/media/types/mediaContext.ts`;
  - the two new suites under `travel-buddy-standalone/src/features/media/__tests__/`.
- **Counted by census-telegraph:** the byte-gate suite
  (`artifacts/api-server/src/test/mediaAccess.test.ts:1658#describe("a message video's derived poster is shown to exactly its thread (census-media §26)"`).
  The new cases are appended at its tail, so its cited lines 798 and 858 do not move.
  That file is not in census-media's own scope. Adding it is a change to
  `checkCensusFreshness.ts`, which this lane does not edit; the integrator may add it.
- **Cited lines kept in place:**
  - `travel-buddy-standalone/src/features/media/components/RequestAViewPrompt.tsx:63#export function RequestAViewPrompt(` (the one line this census cites in that file);
  - every line of `MediaPlacesScreen.tsx` that §19–§22 cite. Its edits extend
    existing lines, and the new components and imports sit at the tail.
  - `mediaProjection.ts`, whose two mapper edits extend existing lines. The helper and import are at the tail.
  - `MediaWorldShell.tsx` was not edited.
- **No acknowledgement was edited.**

## 27. Lane H — the two CANNOT-VERIFY rows measured — 2026-09-26

Lane H of the Media pass owns two rows, **MD403** and **MD441**. Both have
been `?` since the first census (§6, §14.4). The work is on branch
`lane-h-v2`, cut from `396348728`, the head of
`claude/sensing-completion-20260925`.
- **MD403 moves `? → W`.** The tree now runs a contrast measurement, and some
  of what it measures fails.
- **MD441 moves `? → C`** under the reading of §49 given in §27.3. §27.3 also
  names the owner ruling that would make it W.

No other row moves. The headline is not restated here, because the integrator
restates it once for all lanes. This lane wrote no migration, read or wrote no
database, and enabled no flag.

An earlier pass of this lane was measured on `main` (`1a861c3a1`) instead of
this branch. That pass is withdrawn, and every number below was measured again
on this head.

### 27.1 MD403: contrast measured from the source

**The test** is `travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts`,
a node:test file that `scripts/run-node-tests.mjs` discovers on its own. It
measures 312 pairs from 41 source files: 234 text pairs, 69 state-indicator
pairs and 9 decorative marks. The files are:
- the World shell;
- the four Media routes that paint the ink ground;
- every lens screen;
- every component under `src/features/media` that those render, including
  lane A–D's new ones: the World header and lens tabs, `MediaMapCanvas`, the
  Media Map list, the offline and cached labels, the perspective viewer and its
  context sheet, the contribution sheet, and the action rail and its panels;
- the "Why this?" sheet;
- `RequestAViewPrompt`, which is measured on the light place page where it is
  rendered (§27.5, item 1).

**How each ratio is computed**
- **Formula.** WCAG 2.x relative luminance. Every translucent layer is
  composited source-over onto the opaque layers it is actually painted on.
- **Thresholds.** Text must reach 4.5:1 and a state indicator 3:1 (1.4.11). No
  large-text relief is claimed.
- **Not asserted.** Disabled controls (1.4.3), and marks whose state is also
  carried by a text label, are measured and printed but not asserted.
- **Colours come from the source.** Tokens, the §46 state maps, the gem accent
  and the in-tree dark map palette are imported. Every component-local literal
  is tied to its file by a needle the test must find
  (`travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts:808#test('every pair is anchored in the source`).
  So a component that changes a colour turns the test red.
- **Text over a photograph gets two numbers.**
  - The FALLBACK: the fill painted when there is no image, asserted like any
    solid pair.
  - The FLOOR: the lowest ratio over a 16-level-per-channel sRGB grid of
    underlays. This is what the scrim guarantees. The repository's own scrim
    test uses a white fixture, so a floor below threshold is a finding, not a
    device question.
- **Map markers are measured over the map's own paints.** The Media Map's style
  is in the tree, so markers are floored over every area and line colour it
  paints, plus the gem-zone wash
  (`travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts:197#const MAP_AREA_KEYS`).
  The four `label*` colours are excluded, because they are glyphs a marker is
  never wholly over. With them included, the gem marker's ring falls to 1.02:1
  against `label`.

**Results**

| Surface group | Pairs | Asserted | Pass | Fail | Lowest passing |
| --- | --- | --- | --- | --- | --- |
| Solid dark ground (shell, lenses, sheets) | 207 | 201 | 200 | 1 | text 5.44, indicator 3.04 |
| Light sheets and cards (action rail, panels, trust chips, request prompt) | 37 | 35 | 31 | 4 | text 5.00, indicator 3.14 |
| Text over a photo: no-image fallback | 26 | 26 | 26 | 0 | 4.89 |
| Text over a photo: guaranteed floor | 36 | 36 | 8 | 28 | text 5.04, indicator 3.37 |
| The in-tree dark map (canvas markers) | 6 | 5 | 4 | 1 | indicator 3.30 |

**The failures.** Each is pinned in the test: it must stay below its threshold
and within 0.005 of its recorded ratio. A pinned pair that starts passing turns
the test red, and the test reports it as "FIXED"
(`travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts:841#test('pinned findings are still below threshold`).
1. **The selected Media Map bubble's count is invisible: 1.00:1.** Selecting a
   cluster turns its fill `onInk`
   (`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:150#bubbleSelected: { backgroundColor: color.onInk },`).
   The count keeps `onInk` text
   (`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:151#bubbleText: { color: color.onInk,`).
   This is the one failure on a solid ground.
2. **Text and state colour over photographs have no guaranteed floor.** 28 of
   36 floor pairs fail.
   - The NOW card's zone-state chip sits on a 0.55 scrim
     (`travel-buddy-standalone/src/features/media/components/ChangingNowCard.tsx:124#backgroundColor: 'rgba(17,17,15,0.55)',`)
     and floors at 1.40 to 2.31.
   - The viewer's observation-class labels sit on a 0.62 scrim
     (`travel-buddy-standalone/src/features/media/screens/MediaPerspectiveViewerScreen.tsx:694#backgroundColor: 'rgba(17,17,15,0.62)',`)
     and floor at 1.58 to 2.93.
   - The viewer's freshness dots floor at 1.29 to 2.39.
   - Three items sit on the photo with no scrim at all and floor at 1.00: the
     viewer's top title
     (`travel-buddy-standalone/src/features/media/screens/MediaPerspectiveViewerScreen.tsx:605#topTitle: {`),
     its buffering label, and the progress fill.
   - 22 of the 28 have a no-image fallback pair, and every one of those 22
     clears its threshold on it. They fail only over bright imagery, which is
     where §46's "high contrast" is tested.
3. **Two shared light-surface tokens fail on paper.** These are pinned, not
   changed, because both tokens are app-wide.
   - `faint` measures 2.73:1 as the trust chips' description and caption
     (`travel-buddy-standalone/src/features/media/components/ContributorTrustChips.tsx:103#desc: { fontSize: 11, lineHeight: 14, color: color.faint },`).
   - `signal` measures 2.85:1 as the action rail's active label and icon
     (`travel-buddy-standalone/src/features/media/components/MediaActionRail.tsx:493#rowLabelActive: {`).
4. **The §46.1 gem-zone contour falls to 2.65:1 over road casings.** It is drawn
   at 0.7 opacity
   (`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:92#paint={{ 'line-color': GEM_ACCENT,`)
   and measures at least 3.03 over every other paint.

**The one token changed.** `FRESHNESS_COLOR.historical` and
`OBSERVATION_COLOR.generated` were `#6B6862`, the light-ground `mute` grey
copied into a dark-ground palette.
- **Before.** It measured 3.40:1 as label text on the ground, and 1.83:1 as a
  dot on a selected Media Map row.
- **After.** Both are now `#908C84`:
  - `travel-buddy-standalone/src/features/media/state/stateColors.ts:20#historical: '#908C84',`;
  - `travel-buddy-standalone/src/features/media/state/stateColors.ts:36#generated: '#908C84',`.
- **What it measures now.**
  - 3.04:1 as the dot on the selected row: the dot sits on the badge's 0.10
    wash over the row's 0.12 wash
    (`travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:262#rowSelected: { backgroundColor: 'rgba(250,249,246,0.12)' },`).
  - 5.64:1 as text on the ground.
  - 5.47:1 on the viewer fallback.
- **The ramp still reads as a ramp.** Its luminance, 0.264, stays below `recent`
  (0.303) and `user_claimed` (0.315).
- **Usage check, re-run on this head before the edit.**
  - `FRESHNESS_COLOR` is read only by `FreshnessBadge`.
  - `OBSERVATION_COLOR` is read only by `IntelligenceStrip`, `PerspectiveTile`,
    `MediaTimeRail` and `timeBands`.
  - All of these are under `src/features/media` and all paint dark surfaces.
  - The other `#6B6862` literals in the app (the `mute` token and five
    component literals) are separate strings and do not change.
  - No document cites a line of `stateColors.ts`.
  - The only other test that reads these maps, `mediaTimeline.test.ts`, passes.

**The state maps clear their bars on every ground they are painted on.** This
is asserted, not sampled
(`travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts:856#test('the shell ground is dark and every state map clears its bar`).

**Dynamic type.** No Media text opts out of or caps OS font scaling
(`travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts:903#test('dynamic type: no Media Text opts out of, or caps, OS font scaling'`).
- The scan covers 80 files and 182 `<Text` elements: every non-test file under
  `src/features/media`, the "Why this?" sheet and the six Media routes. None
  sets `allowFontScaling={false}` or `maxFontSizeMultiplier`.
- No global `Text` default overrides scaling anywhere in the app's 1,508
  source files.
- **Not measured:** whether each layout holds at the largest OS text sizes,
  screen-reader output, and touch-target sizes. These are device properties.
  None of them is needed to settle the grade, because the failures above
  already make it W.

### 27.2 MD403: mutations, each run on this head and restored

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `onInkMute` alpha 0.72 → 0.12 | red: 81 pairs below threshold, 6 pinned ratios drift |
| M2 | the two state greys back to `#6B6862` | red: 5 pairs (the historical dot at 2.65 / 2.29 / 1.83, the generated label at 3.40 / 3.30) and the state-map test |
| M3 | the freshness badge wash 0.10 → 0.30 | red: 2 needles not found |
| M4 | `allowFontScaling={false}` on the lens-state heading | red: the dynamic-type test names the file |
| M5 | `signal` → `#B8321C` | red: the For You sparkle icon falls to 2.76, and the rail's active label and icon report FIXED at 5.16 |
| M6 | the historical grey set to `#85817A`, the first candidate | red: the dot on the selected map row at 2.63 |

The tree was restored after each mutation, and the test was green on the
restored tree.

### 27.3 MD441: the audit, and why the grade is C

**The audit** is `docs/media/canonical-foundation-audit-2026-09-26.md`. It is
dated 2026-09-26 and taken at `396348728b76592080580fb8ac19348920c13fb1`.
- **Areas covered.** It covers §49's seven areas, each as what exists, what the
  spec requires, the gaps by census row (not re-graded), and the risks.
- **Anchors.** Every one of its 106 references is anchored, and each anchor
  was checked against this head.
- **Lanes B and D.** It covers what they added:
  - 3320 and 3321, applied to `portava-ci` only (`docs/migrations.md`, §23.2);
  - `MediaModerationService` (§20);
  - the upload, poster and resumable transport routes (§22);
  - the byte gate, including §23.7's recorded-variant rule;
  - the override filter in `prepareCanonicalRows`.

**What it says about itself.** It says in its first section that it is NOT
the historical Phase-1 audit.
- **No document was written when Phase 1 was built.**
  - The Phase 1 build is `286813ed5` (#273, 2026-08-31 13:30:32 -0400). It
    touched ten files and none is a document.
  - Phase 2 landed 49 minutes later: `693da9448` (#279) and `c58f6a7d4` (#278).
- **The nearest earlier document is a Phase 0 report** at
  `travel-buddy-standalone/docs/media-phase0-report.md`, dated 2026-07-24 and
  client-only. §6's statement that no such document exists covers only the
  root `docs/` directory, so it did not reach this file.

**Why C.** §49 is a two-column table, "Phase | Deliverable". It gives Phase 1's
deliverable as the audit, and states no ordering between phases.
- This census grades every sibling row the same way. MD442 is C, "Delivered
  (and dark)", for a Phase 2 shell built before any Phase 1 audit existed.
  MD443 to MD450 are graded on what exists.
- The row's own falsifiers ask for "the audit document" (§6) and "the audit
  artifact being committed" (§14.4). The audit document is now committed, so
  the row is C.

**The condition.** If the owner rules that §49 is a sequence, the grade is W.
- **What "sequence" means here:** the audit had to come before Phase 2 was
  built.
- **Why nothing can satisfy it now.** Phase 2 was built 49 minutes after
  Phase 1, with no audit in between. No later commit can change that order.
- **So the W would be permanent.** No further work closes it; only the ruling
  sets it.

### 27.4 Row moves

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD403 | **?** | **W** | The dark foundation and the state labels are built. §46's "high contrast" is measured by `travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts:835#test('every solid-ground and fallback pair meets WCAG AA` and fails in four places, each pinned (§27.1): the selected Media Map bubble's count at 1.00:1; 28 of 36 photo-floor pairs; `faint` 2.73 and `signal` 2.85 on light sheets; the gem-zone contour at 2.65 over road casings. One state colour was fixed after a usage check. Dynamic type is honoured in code. Mutations M1–M6 turned red (§27.2). |
| MD441 | **?** | **C** | `docs/media/canonical-foundation-audit-2026-09-26.md`, dated, at `396348728`, covering all seven §49 areas with 106 anchored references, and disclaiming that it is the historical Phase-1 audit. C reads §49 as deliverables, as MD442–MD450 are graded. If the owner rules that §49 is a sequence, the row is W, permanently (§27.3). |

### 27.5 Found while doing it — recorded, not fixed

1. **§22.6 item 3 and §23.4 are wrong: `RequestAViewPrompt` is mounted.**
   - It has been rendered on the place page since `f4526dba5` (#305,
     2026-08-31): `travel-buddy-standalone/app/place/[id].tsx:423#<RequestAViewPrompt placeId={canonicalPlace.id} city={city} />`.
   - The component gates itself on `media_request_a_view_enabled`.
   - MD153's C does not rest on the false sentence, so no row is re-graded.
2. **`/media/upload` buffers the whole body before it authenticates, and sets
   no ceiling while it reads.**
   - Every chunk was kept, and authentication ran only after the stream ended. **Fixed in §28.7:** the caller is authenticated first (`artifacts/api-server/src/routes/posts.ts:87#async (req, res, next) => { const auth = await requireUser(req, res); if (!auth) return;`),
     then the body is read bounded (`artifacts/api-server/src/routes/posts.ts:88#collectBody(Math.max(...Object.values(MEDIA_SIZE_LIMITS))),`).
   - A bounded collector already exists, and the poster routes use it: `artifacts/api-server/src/routes/postcardMediaTransport.ts:136#export function collectBody(limitBytes: number) {`.
3. **An owner's retry parks an asset in `queued`, and nothing claims queued
   work.**
   - The retry writes `artifacts/api-server/src/services/media/MediaLifecycleService.ts:382#processing_status: "queued",`.
   - Its only non-test caller is `artifacts/api-server/src/routes/mediaActions.ts:213#const result = await retryMediaProcessing(sc, id, auth.user.id);`.
   - `claimMediaProcessing`, `completeMediaProcessing`, `failMediaProcessing`,
     `recoverStaleMediaProcessing` and `softDeleteMediaAsset` have no non-test
     caller.
   - §20.4's MD338 cites "lifecycle (MediaLifecycleService)" among its
     responsibilities. MD338 is not re-graded here.
4. **The event/trip header mask fails open on a read error** (**fixed in §28.8**; the comment keeps the old words):
   `artifacts/api-server/src/routes/mediaFile.ts:44#Fail-OPEN: any DB error`.
5. **The eligibility module's rationale points 36 lines above the code it
   names.** (**Fixed in §28.11.**)
   - The rationale is `artifacts/api-server/src/lib/mediaEligibility.ts:66#already blocks four of these on`.
   - The set it names is at `artifacts/api-server/src/services/wall/WallCandidateLoaders.ts:1156#const QUICK_MEDIA_BLOCKED_MODERATION`.
6. **Seven prose pointers into 0191 in this census's §5 rows name the wrong
   line.** (**Fixed in §28.11.**) They carry no file extension, so no checker reads them.
   - MD37's pointer to line 31 (source) belongs on
     `artifacts/api-server/src/migrations/0191_media_assets.sql:28#source_type`.
   - MD269's pointer to lines 32-34 (moderation) belongs on
     `artifacts/api-server/src/migrations/0191_media_assets.sql:29#moderation_status`.
     Lines 32-34 are the processing CHECK.
   - MD40's lines 46-58 start one line late; the table opens at line 45.
   - MD41's line 49 is `entity_id`; `entity_type` is at line 48.
   - MD42's lines 51-52 should be 50-51.
   - MD42's cover index at lines 60-61 should be 59-60.
   - MD43's line 53 is `created_at`; `visibility_override` is at line 52.
7. **The lane's own mistake.** The first pass was measured on `main`, not on the
   branch this census describes. Two of its findings are false here:
   - `inherit` does not deny non-owners (`artifacts/api-server/src/lib/mediaVisibility.ts:93#case "inherit":`);
   - `shared_moment` is decided by Moment membership, not trip crew (`artifacts/api-server/src/lib/mediaVisibility.ts:175#async function isSharedMomentAudience(`).

### 27.6 Files changed, and the censuses that count them

| File | Change | Counted by |
| --- | --- | --- |
| `travel-buddy-standalone/src/features/media/state/stateColors.ts` | two colour values and their comments; no line added or removed | census-media |
| `travel-buddy-standalone/src/features/media/__tests__/mediaContrast.test.ts` | new | census-media |
| `docs/media/canonical-foundation-audit-2026-09-26.md` | new | none |
| `docs/architecture/census-media.md` | this section, appended; no earlier line edited | — |

`CENSUS_STALENESS_ACKNOWLEDGED.json` and `checkCensusFreshness.ts` are not
edited. Guard results are in the lane report, not restated here.

## 28. Integration of lanes E–H, and a privacy fix one of them found — 2026-09-26

The lanes' own sections are §24 (E), §25 (F), §26 (G) and §27 (H). Each is
appended in merge order, after §23, and each records its own rows. This section
records only what the integration itself changed.

### 28.1 World counts leaked perspectives hidden from the viewer (found by lane F, §25)

**The defect.** `routes/mediaWorld.ts` filters every response through the
trip-context visibility rule
(`artifacts/api-server/src/routes/mediaWorld.ts:110#const filtered = await filterMediaProjectionVisibility(ctx.sc, ctx.viewerId, payload);`).
That filter removes hidden media OBJECTS from the payload. It cannot reach a
number, and every builder counts its page before the route sees it:
- a World zone's `perspectiveCount`, freshness and consensus;
- a bucket's fresh and total perspectives;
- `totalPerspectives`.

So a trip post that its owner hid from this viewer with a circle override was
still counted. In lane F's fixture, a hidden fresh post at a place made that
place "2 perspectives, fresh" for a viewer who could see one three-day-old
perspective.

**The fix.** It is in the one projection path that the world, place,
experience, people and search builders all use.
`artifacts/api-server/src/services/media/MediaProjectionService.ts:698#return visibleToViewerOrRefuse(sc, viewer.viewerId, out);`
filters the projected page through the same rule before anything is counted.
The helper is appended at the file's tail:
`artifacts/api-server/src/services/media/MediaProjectionService.ts:1764#async function visibleToViewerOrRefuse(`.

A filter that cannot decide refuses the page with
`artifacts/api-server/src/services/media/MediaProjectionService.ts:1772#throw new MediaCandidatesUnavailableError("visibility"`,
which returns a 503, as an unreadable candidate read already does. It never
counts a page it could not decide about. The route's own filter stays as the
second line. Every edit is on an existing line or at the file's tail, and no
cited line moved.

**Tests and mutations.** The tests are at
`artifacts/api-server/src/test/mediaRankingObjectives.test.ts:991#describe("census-media §28 — World counts are counts of what this viewer may see"`:
- a control;
- the override case (`artifacts/api-server/src/test/mediaRankingObjectives.test.ts:1015#it("with the owner hiding their trip from this viewer`);
- the undecidable case (`artifacts/api-server/src/test/mediaRankingObjectives.test.ts:1028#it("when visibility cannot be decided`), which fails only the filter's own read, so the candidate read still succeeds.

Both mutations were seen red:
- Bypassing the filter turned 2 tests red.
- Treating "undecidable" as "keep everything" turned 1 test red. It survived the first draft, which had no undecidable case.

Across the media server suites, 2,970 tests pass. The 7 file-level failures
are live-database tests that refuse to run without credentials, and they fail
identically with and without this change.

**Rows.** No row moves. The fix narrows what a count may include, and no
graded row rested on a hidden perspective being counted. MD9 ("privacy …
resolve before client projection") is C, and after this fix it is true of the
counts as well as the objects.

**Production.** Not deployed. `/media/world` has no flag of its own, but no
screen a user can reach calls it: the World shell is seeded off. Circle
overrides that hide a trip do exist as a production feature, so this leak
would matter the moment the shell is turned on.

### 28.2 Merges, and the headline

**Lane F (§25).** Merged at `71a6327b2`. MD428 moves W → C.

**Lane G (§26).** Merged at `6b5ad4608`:
- MD262 moves C → W;
- MD152 and MD153 stay C and are re-proven;
- six message-poster cases are appended to the byte-gate test.

**The census.** Both merges conflicted only at this file's tail, and every
section was kept.

**Freshness.** The census-media acknowledgement names every file the lanes
changed, as a re-measurement. The five other censuses that count
`MediaProjectionService.ts` carry a note for §25 and §28.1.

**The headline after F and G** is **C 398 · W 38 · N 12 · X 2** of 450. It is
unchanged from §23.6 because the two moves cancel. `check:census-integrity`
reads it from the rows. Lanes E (§24) and H (§27) are not yet merged, and the
headline is restated again when they are.

### 28.3 The "Why this?" footnote on World items described a different ranker (found by lane F, §25)

**The defect.** The shared sheet's footnote is Watch's copy: "creators you
engage with". That copy was shown under World explanations, but the World §24
ranker reads no engagement. What it reads:
- what the viewer said they want;
- their trips;
- their saved places;
- who they follow;
- how fresh and useful a perspective is.

Its "location" is an active trip's destination, never GPS
(`artifacts/api-server/src/lib/mediaRankingSignals.ts:349#export function locationTerm(`).

**The fix.** The sheet takes an optional `footnote`. The default is
unchanged, so Watch and Gems read as before. The World shell passes the
footnote that is true of its list
(`travel-buddy-standalone/src/features/media/screens/MediaWorldShell.tsx:207#footnote={WORLD_WHY_FOOTNOTE}`).
Every edit is line-neutral, and §25's citation of the default text
(`WhyThisSheet.tsx:81`) still resolves.

**Test and mutation.** The World shell's MD428 test now also asserts that
the World footnote is shown and that "creators you engage with" is absent.
With the prop removed, it goes red. No row moves; this is copy under MD428,
which is already C.

### 28.4 Lane E (§24) merged, and how §28.1 changes one of its cases

**Lane E merged at `c91cc5665`:** MD300 and MD288 stay **W**, with narrower
falsifiers. The server and the client services are built and each mutation was
seen red. What remains is screen wiring. Lane I (§29) was started on it.

**Conflicts, and how they were resolved.**
- `MediaProjectionService.ts` and the client's `mediaProjection.ts` each had
  two tails appended at once. Both were kept.
- Lane E imported `filterMediaProjectionVisibility` a second time at its tail.
  That import was dropped, because §28.1 already imports it on the file's
  import line.
- The census conflicted at its tail, and §24 is placed before §25.
- Eleven §24 citations shifted in the merge. They were repointed from
  `check:doc-citations`' own "the WHOLE anchor is at" statements.

**One case changes meaning.** Lane E wrote "a directional read that cannot be
completed serves the counts with no covers" when the counts were still taken
before the filter. After §28.1, counts are taken from what the viewer may see,
so a page whose visibility cannot be decided has no counts to serve either. It
is refused with a 503, and the test now asserts that. The cover's own filter
in `attachClusterCovers` stays as the second line.

**Lane E's §24.7 finding 1 is fixed by §28.1.** Lane E found that `/media/map`
cluster counts and `/media/world` zone counts included items hidden by the
directional override. Both builders project through
`projectCandidatesProtected`, which now filters before anything is counted.

**The headline after E** is **C 398 · W 38 · N 12 · X 2** of 450, unchanged,
as `check:census-integrity` reads it from the rows.

### 28.5 CI on `c91cc5665`: one new blind spot for the column checker, removed

**What failed.** `check:write-path-columns` was red on `c91cc5665`.

Lane E's "near" place read passed `.select(PLACE_SELECT_COLUMNS)`, an
identifier imported from `lib/mapProjectPlace`. The checker resolves a select
list only when it is a literal at the call site, so this site was a new
statically unresolvable site. That is a blind spot: nothing verifies its
columns against the live schema.

**The fix.**
- The select list is now written as the literal
  (`artifacts/api-server/src/services/media/MediaSearchService.ts:749#.select("id, name, primary_category, city, neighborhood, country_code, latitude, longitude, status, merged_into_place_id")`).
- A test pins it equal to `PLACE_SELECT_COLUMNS`, so the two cannot drift
  (`artifacts/api-server/src/test/mediaWorldProjection.test.ts` §28.5 case).
  Dropping a column from the literal turns that test red.

**Verified.**
- The offline extractor now counts 75 unresolvable sites, not 76.
- Read-only on portava-ci, `places` has all ten columns.
- The module header's stale "client half is still unbuilt" is corrected in
  place, as §24.7 item 3 recorded.

No row moves.

### 28.6 Lane H (§27) merged: lane G's new surfaces measured, one fails and is fixed

Lane H's contrast test was written against a tree without lane G, so the
merge extended it. Lane G added two things it had not measured:
- an `ink` tone for the §19 prompt, for the Media World shell's dark surface;
- "Mixed reports" lines on three zone surfaces.

All of them are now measured under the same rules: WCAG AA, and no large-text
relief. One pair failed. The ink-tone sent-confirmation was `success` green on
`ink` at 3.78:1. It is now `onInk`, because the sentence's own words carry the
outcome:
`travel-buddy-standalone/src/features/media/components/RequestAViewPrompt.tsx:263#resultOk: { ...t.small, color: color.onInk },`.

With the old colour back, the contrast test goes red. Lane H's `Eye`-icon
needle was updated to lane G's line.

**The headline after H** counts **C 399 · W 39 · N 12 · X 0**, restated in
§28.9. The two moves are MD403 ? → W and MD441 ? → C.

### 28.7 `/media/upload` authenticated after reading an unbounded body (found by lane H, §27.5 item 2)

**The defect.** The route buffered every chunk of the request before it
authenticated, and it set no ceiling while it read. An unauthenticated caller
could therefore make the server hold an arbitrarily large body in memory.

**The fix.**
- The caller is now authenticated before a byte is read:
  `artifacts/api-server/src/routes/posts.ts:87#async (req, res, next) => { const auth = await requireUser(req, res); if (!auth) return;`.
- The body is then read through the bounded collector the poster routes
  already use, capped at the largest per-kind ceiling:
  `artifacts/api-server/src/routes/posts.ts:88#collectBody(Math.max(...Object.values(MEDIA_SIZE_LIMITS))),`.
- `verifyUploadedBytes` still applies the real kind's own ceiling after that.
- The edits are line-neutral, and the new imports sit at the file's tail.

**Test and mutation.**
- `artifacts/api-server/src/test/mediaUploadHardening.test.ts:280#it("authenticates BEFORE reading the body`
  declares a 200 MB body, sends 16 bytes and never ends the body. It gets a
  401 at once. Against the old route it gets no answer and fails ("no answer
  within 3 s").
- The existing oversized-video case is rewritten, not weakened. The server now
  stops reading, so the client may see its socket reset. A 400 or a reset
  both count as a refusal, and an upload is never allowed.
- All 21 cases pass.

**What remains** (moved before the read in §28.10)**.** The kill switch and the per-user upload budget still run
after the body is read. The body is now bounded and authenticated, so this is
a smaller cost, recorded rather than moved.

### 28.8 The event/trip header mask failed open (found by lane H, §27.5 item 4)

**The defect.** `routes/mediaFile.ts` replaces an event or trip's generated
header with a generic cover when its owner set `show_header_publicly = false`.
The read of that setting failed open: a database error served the real
header. The membership reads beside it already failed closed.

**The fix.** A read error, and a thrown read, now mask
(`artifacts/api-server/src/routes/mediaFile.ts:69#if (error) return true; if (!data) return false;`,
and the same rule for trips). A missing row still means "not a header of
anything".

Masking blocks nothing: the viewer still gets an image, just not the one its
owner hid. Read-only, production has `show_header_publicly` on both `events`
and `trips`, so the change masks only on a genuine error.

**Test and mutation.**
`artifacts/api-server/src/test/mediaAccess.test.ts:1770#describe("census-media §28.8`
has two cases:
- a control, with both settings;
- a failing setting read with the byte gate's own read healthy, which must
  serve the generic cover.

With the old code, the second case goes red. All 91 byte-gate cases pass.

### 28.9 Lane I (§29) merged, MD338 re-read, and the headline

**Lane I merged** from `lane-i` (`c7822eff1`, `8aff42996`, `1170da620`,
`b9ed68021`). The census conflicted only at its tail, and §29 follows §28.

**One pinned finding became a pass.** Lane I's §29.8 fixed the selected Media
Map bubble that lane H pinned at 1.00:1. Lane H's test reports a pinned pair
that starts passing as "FIXED" and goes red, so the pair is now asserted as a
passing pair: `ink` on the `onInk` fill, with needles on the tail style and on
the `Text` that applies it. The edit is line-neutral, so none of lane H's
citations into the test moved. MD403 stays **W**: three of lane H's four failure
groups remain (photo floors, the `faint` / `signal` light-surface tokens, and
the gem-zone contour).

**Scope and freshness.**
- `app/media-search/index.tsx` and `app/media-world/index.tsx` join
  census-media's scope, because MD288's C rests on them. Coverage is
  220 of 228 cited files (96.5 %), and the floor is unchanged.
- The census-media acknowledgement names lane I's files as a re-measurement.

**MD338 moves back to W.** §20.4 moved it to C "by responsibility", naming
"lifecycle (MediaLifecycleService)" among them. Lane H's §27.5 item 3 recorded
that the processing half of that lifecycle has no worker, and it was not
re-graded then. Read again at this head, the responsibility is not met:

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD338 | **C** | **W** | The owner's retry refuses only an asset that is already queued or processing (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:378#if (asset.processing_status === "queued" || asset.processing_status === "processing") {`), so a `ready` asset is re-queued too (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:382#processing_status: "queued",`). `claimMediaProcessing` (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:88#export async function claimMediaProcessing(`) has no non-test caller, so nothing ever takes a queued asset out of `queued`. Every canonical read serves only `ready` (`artifacts/api-server/src/services/wall/WallCandidateLoaders.ts:1165#if (row.processing_status !== "ready") return false;`). So one `POST /media/:id/retry` takes an owner's ready asset off every read path for good, and a failed asset the owner retries is parked for good. `softDeleteMediaAsset` also has no non-test caller. **RED WHEN** a production caller claims queued assets and completes or fails each one, and a retry cannot take a `ready` asset off a read path. **Blocker: none; branch work** (§30). |

**The headline after lanes E–I and §28**, restated from `check:census-integrity`:

> | Measure | §23.6 (after lanes A–D) | Now, after lanes E–I and §28 |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 398 | **400** |
> | BUILT-BUT-WRONG | 38 | **38** |
> | NOT-BUILT | 12 | **12** |
> | CANNOT-VERIFY | 2 | **0** |
> | **CONSTRUCTED%** = (C+W)/450 | 96.9 % | **438 / 450 = 97.3 %** |
> | **CORRECT%** (raw) = C/450 | 88.4 % | **400 / 450 = 88.9 %** |
>
> The moves since §23.6: MD428 W → C (§25); MD262 C → W (§26); MD403 ? → W and
> MD441 ? → C (§27); MD300 and MD288 W → C (§29); MD338 C → W (above). These are
> construction verdicts. **Not one of them is realised in production.**

**What the 50 non-C rows wait on**, by blocker. Each row names its falsifier
where it was graded.
- **The World shell as the shipped surface, and Watch no longer the default
  (F1/F2)**, owner decisions: MD1, MD2, MD3, MD11, MD29, MD87, MD215, MD286,
  MD402, MD408, MD412, MD419, MD424, MD425, MD427 (15 W).
- **Media as an intelligence contribution (MD65's safety decision)**: MD53, MD58,
  MD65, MD66, MD71, MD370, MD445 (7 W).
- **Where a perspective's vantage is stored**: MD82–MD85 (4 N) and MD444 (W).
- **A vendor, a native build or a device run**: MD63, MD277, MD280, MD282 (4 N);
  MD269, MD283, MD284 (3 W).
- **An owner definition or product rule**: MD77, MD162, MD175, MD293 (4 N);
  MD37, MD79, MD101, MD197, MD255, MD262, MD289, MD385, MD435, MD446 (10 W).
- **Branch work, started at this head**: MD338 (above) and MD403's three
  remaining failure groups, which sit inside Media's own files (§30 for
  MD338, §31 for MD403).

### 28.10 `/media/upload` refuses before it reads (the remainder of §28.7)

**The defect.** §28.7 left the kill switch, the per-user upload budget and the
declared-type check running after the body was read. So a refused upload still
cost the server up to the largest per-kind ceiling in bytes: while uploads were
switched off, when the caller was over budget, or when the declared type was
one the route never accepts.

**The fix.**
- All three are now decided after authentication and before the first byte is
  read:
  `artifacts/api-server/src/routes/posts.ts:87#if (!(await admitUploadBeforeBody(req, res, auth.user.id))) return;`,
  through the helper at the tail
  (`artifacts/api-server/src/routes/posts.ts:3669#async function admitUploadBeforeBody(req: any, res: any, userId: string): Promise<boolean> {`).
- The budget is charged once. The handler reads the stored result
  (`artifacts/api-server/src/routes/posts.ts:102#(req as any).uploadGuard;`);
  it does not call `guardUploadRequest` a second time. The old call is kept in
  a comment at the end of that same line, so the §49 audit's citation of it
  still reads.
- The edits are line-neutral.

**One behaviour changes.** An over-ceiling upload is now charged against the
budget, because the budget is decided before the size is known. Before, it
was refused by the bounded collector without being charged.

**Tests and mutations.** The tests are
`artifacts/api-server/src/test/mediaUploadHardening.test.ts:813#describe("census-media §28.10 — /media/upload refuses before reading the body"`.
Each refusal case declares 200 MB, sends 16 bytes and never ends the body, so
only a route that decides without the bytes can answer it.

| # | Mutation | Red |
| --- | --- | --- |
| U-M1 | the old order: all three decided after the read | the kill-switch case and the declared-type case, each "no answer within 3 s" |
| U-M2 | the handler charges the budget again | the CONTROL: one upload must leave the bucket at 1 |
| U-M3 | the declared type checked only after the read | the declared-type case |

`posts.ts` was byte-identical after each run. All 24 cases pass.

### 28.11 Two kinds of stale pointer corrected (lane H's §27.5 items 5 and 6)

**The eligibility module's rationale.** It named a line in
`WallCandidateLoaders.ts` that had moved 36 lines. The line number is dropped
and the symbol, which the next line already names, is kept
(`artifacts/api-server/src/lib/mediaEligibility.ts:66#services/wall/WallCandidateLoaders.ts already blocks four of these on`).
The edit is comment-only and line-neutral.

**Six prose pointers into 0191 in §5's rows.** Each was re-read against the
file and corrected in place. Each carries the note "pointer corrected
2026-09-26, §28.11". No verdict changes.

| Row | Was | Now | What is there |
| --- | --- | --- | --- |
| MD37 | `0191:31` | `0191:28` | `source_type ... DEFAULT 'user'` |
| MD40 | `0191:46-58` | `0191:45-55` | the `media_attachments` table, `CREATE` to `);`, `UNIQUE` included |
| MD41 | `0191:49` | `0191:48` | `entity_type TEXT NOT NULL` |
| MD42 | `0191:51-52`, `:60-61` | `0191:50-51`, `:59-60` | `position`, `is_cover`; the partial cover index |
| MD43 | `0191:53` | `0191:52` | `visibility_override TEXT` |
| MD269 | `0191:32-34` | `0191:29-30` | `moderation_status` and its CHECK (32–34 is the processing CHECK) |

Lane H counted seven; MD42 carries two of them. For MD40, lane H read "starts
one line late"; the table itself also ends at 55, not 58, which is the entity
index.

### 28.12 CI on `0f0ecde26`: the §28.7 test hung on a stale keep-alive socket, and the harness is fixed

**What failed.** The CI node:test suite on `0f0ecde26` passed 26,502 of
26,503 tests. The one failure was §28.7's
`artifacts/api-server/src/test/mediaUploadHardening.test.ts:280#it("authenticates BEFORE reading the body`,
which got no answer within 3 s. It had never run to completion in CI before,
because the run on `f31d94812` was cancelled by the next push. It passes
locally on Node 22 and Node 24, with CI's environment variables, and under
CPU contention: no local run reproduced it.

**The cause, as far as it can be shown.** It is the one request in the file
issued straight after a request the server destroys: the 101 MB
oversized-video case, which the bounded collector cuts off. Locally, that case
always ends in a reset before any answer, so its socket is never pooled. On a
faster CI loopback it can read its 400 first. The global agent keeps sockets
alive by default since Node 19, so it can then hand that socket to the next
request before the server's destroy arrives. That is the documented
keep-alive race: `reusedSocket` exists for it. The test ignored
`ECONNRESET` / `EPIPE`, so a stale socket became a silent 3 s hang rather than
an error.

**The fix is to the harness, not the route.**
- Every raw request in the file now opens a fresh connection (`agent: false`),
  so no request can inherit a socket the server has already destroyed.
- The two "refuse before the body" cases no longer swallow a reset. A
  connection error before any answer now fails the case at once, and names
  its code and whether the socket was reused.
- No assertion changed. Every edit is on an existing line.

**Still red when it should be.** Under Node 24 with CI's environment:
- the §28.7 order (authenticate after the read) turns this case red;
- U-M1 (§28.10's decisions after the read) turns both §28.10 refusal cases
  red.

The file passes 24/24 on Node 22 and Node 24.

## 29. Lane I — the Media Map draws its covers from the cache, and Search asks 'near' — 2026-09-26

§24 built the server and client-service halves of MD300 and MD288, and left
each **W** for one reason: no screen used them. §24.2 and §24.3 each ended with
a narrowed RED WHEN. This lane wired both into the screens. Each row is graded
here against that falsifier, as §24 states it. No server file, migration, flag
or seed was touched.

Worked from `claude/sensing-completion-20260925` at `c91cc5665`, on branch
`lane-i`. The code and tests are in `c7822eff1`; this section is in the commit
after it. A follow-up commit, `1170da620`, makes the two map files and the
Search route line-neutral against the base, so lane H's citations into them
hold. It also fixes the selected-bubble contrast that lane H found (§29.8).

### 29.1 Row table

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD300 | **W** | **C** | §24.2's RED WHEN is met on every loader it names. The standalone map's default loader now reads through the `map_thumbnails` scope (`travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:65#mediaMapOffline({ city, signal: opts.signal }).then((r) =>`). The NOW lens and the Places overview Map also use that loader. The Places one-place Map (`travel-buddy-standalone/src/features/media/screens/MediaPlacesScreen.tsx:162#mediaMapOffline({ city, signal: opts.signal }).then((r) =>`) and the Experiences Map (`travel-buddy-standalone/src/features/media/screens/MediaExperiencesScreen.tsx:146#mediaMapOffline({ city, signal: opts.signal }).then((r) =>`) read through the same scope. Each cluster's `cover` is drawn on its map marker (`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:112#const cover = clusterCoverImage(c);`) and on its list row (`travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:185#<ClusterRowMark placeId={c.placeId} cover={clusterCoverImage(c)} />`), through `CachedImage`. A video is drawn only by its poster (`travel-buddy-standalone/src/features/media/state/mediaMapCover.ts:32#if (m.mediaType === 'video') return thumb;`). When the map came from the cache, the screen shows `offline.label` (`travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:130#testID="media-map-cached"`), whichever loader supplied it (`travel-buddy-standalone/src/features/media/screens/MediaMapScreen.tsx:83#const { loader, cachedLabel } = useCachedLabel(`). Tests: `travel-buddy-standalone/src/features/media/__tests__/MediaMapCovers.component.test.tsx:156#describe('census-media §29 (MD300)` (5 cases, over the real cache) and `travel-buddy-standalone/src/features/media/__tests__/mapCoverAndSearchNear.test.ts:39#describe('MD300 — clusterCoverImage` (3). |
| MD288 | **W** | **C** | §24.3's RED WHEN is met: the Search screen sends `near` with a center and a bounded radius (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:102#const opts = { signal: o.signal, near: near.param }; return fetchMediaSearch(queryString, opts);`). The center is the place the search was opened from, or else the viewer's point (`travel-buddy-standalone/src/features/media/state/mediaFilterStore.ts:181#export function searchNearCenter(`). The radius is 1500 m (`travel-buddy-standalone/src/features/media/state/mediaFilterStore.ts:159#export const MEDIA_SEARCH_NEAR_RADIUS_M = 1_500;`). The viewer's point is the one `/media-world` hands the World shell and its Media Map (`travel-buddy-standalone/app/media-world/index.tsx:27#const coords = locationState.ok ? locationState.coords : null;`). The Search route passes the same field from its existing `useActiveLocation` call (`travel-buddy-standalone/app/media-search/index.tsx:41#viewerPoint={viewerPointFrom(locationState)}`, built at `travel-buddy-standalone/app/media-search/index.tsx:71#function viewerPointFrom(`). The server's `center_unpositioned` renders as "We can't place that center" (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:206#results?.near?.refusal === 'center_unpositioned' ? <NearRefused`). The city chip is unchanged (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:180#onPress={() => dispatch({ type: 'set_city', city: filters.city === nearCity ? null : nearCity })}`). Tests: `travel-buddy-standalone/src/features/media/__tests__/MediaSearchNear.component.test.tsx:63#describe('census-media §29 (MD288)` (7 cases, including a CONTROL) and `travel-buddy-standalone/src/features/media/__tests__/mapCoverAndSearchNear.test.ts:59#describe('MD288 — the filter store` (5). |

Both are construction verdicts. Neither is realised in production (§29.6).
The two rows move the parsed media counts by two, from W to C. The headline is
not restated here; restating it is the integrator's job (§28.2).

### 29.2 MD300 on the screens

**Which maps read through the cache.** Every Map surface that shows the
world's clusters:
- `/media-map`, the NOW lens's Map and the Places overview Map, through
  `MediaMapScreen`'s default loader;
- the Places one-place Map and the Experiences Map, through their own loaders.

Two Map surfaces are left as they were, on purpose:
- My World's Map shows the owner's own media grouped by place. It carries no
  server cover and no cached label.
- The Hidden Gems Map draws gems only.

`fetchMediaMap` now has one caller, `mediaMapOffline` itself.

**What is drawn.** `clusterCoverImage` only chooses which of the server's
references to draw. It never picks a cover.
- An image is drawn by its thumbnail, or else by its own file.
- A video is drawn by its poster, never by the video file.
- A cluster with no cover, or with a cover that has no image, renders as
  before: the count bubble and the pin.

The reference goes to `CachedImage`, which signs it. Offline, the image layer
(`mediaUrl`) serves the cache's own copy, which §24.2 stored only after the
signer allowed it.

**The label.** `useCachedLabel` wraps whichever loader the map was given. It
works like `useOfflineLens`: it holds the "Cached · updated …" label while the
map on screen came from the cache, and clears it on the next live answer. So
the Places and Experiences Maps show the label too.

**The cited lines.** In the two map files and the Search route, every line of
the base keeps its number. Edits sit on existing lines or at each file's tail,
so this census's citations and lane H's (§27: `MediaMapCanvas.tsx` :92, :150,
:151, and `MediaMapScreen.tsx` :262) still land. `MediaMapScreen.tsx:65` is the
loader line itself, so it had to change. §24.1's anchor for it (the old
`fetchMediaMap(...)` call) now sits in a note at the end of that same line, so
§24's citation still resolves and shows what the line used to be.

### 29.3 MD288 on the screen

**One chip, offered and never applied by default.** It is labelled with its
center and its radius:
- "Near <place> · 1.5 km" when the search was opened from a canonical place;
- otherwise "Near me · 1.5 km" when the viewer's point is known;
- no chip when there is neither.

Nothing invents a center. A place id that is not canonical cannot be a center,
because the Map positions places by their canonical id.

**What pressing it sends.** `fetchMediaSearch(q, { near })` with that center and
`radiusM=1500`, next to whatever else was asked. With no words, "Near me" is a
search on its own: the first answer arrives without typing
(`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:200#{queryString == null && !near.param ? (`).
"Near" is not part of the query string. The store says only whether it is on,
and `toSearchNear` builds what is sent
(`travel-buddy-standalone/src/features/media/state/mediaFilterStore.ts:194#export function toSearchNear(`).

**The refusal.** When the server answers `near.refusal: 'center_unpositioned'`,
every list is empty because the Map would not place the center, not because
nothing matched. The screen says exactly that, and offers "Search without
'near'" (`travel-buddy-standalone/src/features/media/screens/MediaSearchScreen.tsx:506#function NearRefused(`).
A CONTROL case checks that a genuinely empty "near" answer still reads
"Nothing matched".

**The viewer's point.** The Search screen is its own route, pushed from the
shell. It is not rendered inside the shell. That route already calls
`useActiveLocation` for "Near <city>"
(`travel-buddy-standalone/app/media-search/index.tsx:28#const { locationState } = useActiveLocation();`).
It now also passes that call's coords, gated on `ok` exactly as `/media-world`
gates the point it hands the shell. So there is no new location read and no new
permission, and `MediaWorldShell.tsx` is unchanged. The point is not put in a
URL.

**What the server sees.** The point goes as `nearLat` / `nearLng` on
`GET /media/search`. The Media Map already sends the same point to the Map
gateway as a bbox query, and `useActiveLocation` already syncs it to
`/api/me/location-state`. The search response carries no coordinate (§24.3).

**Limit, recorded rather than hidden.** §38's own example names a city: "near
Da Nang". A typed city is still the coarse city criterion, through the
unchanged city chip and field. §24.3 lists three centers that satisfy its
falsifier: the viewer's position, the place the search was opened from, or a
place result. A named city is not one of them, and turning one into a radius
needs the client's Map data (§24.3). Asked in Da Nang, the example becomes
"beach" plus the gem kind plus "Near me · 1.5 km". Asked from elsewhere, it is
city-coarse.

### 29.4 Design choices the owner may want to revisit

1. **One chip, not two.** A place context replaces "Near me" rather than
   sitting beside it, following the rule "a place when there is one, else the
   viewer".
2. **A fixed 1500 m radius** with no picker. It sits inside the server's
   100–5000 m bound, and the chip states it.
3. **The place context arrives only as route params**
   (`nearPlaceId`, optionally `nearPlaceName`). No in-app surface opens Search
   with a place yet, and place results carry no "Search near here". Both would
   be small additions. Neither is needed for the falsifier.
4. **The refusal's way out** turns "near" off. It does not fall back to the city
   silently.
5. **`MediaMapScreen.tsx:65` was reworded in place** (§29.2), rather than left
   as an unused raw loader to keep the old text alive.

### 29.5 Mutations — each seen red, every file checked byte-identical after each run

Map (`MediaMapCovers.component.test.tsx`, plus the node file where named):

| # | Mutation | Red |
| --- | --- | --- |
| I-M1 | the standalone map's loader unwired (raw `fetchMediaMap`) | the offline standalone case; the Places case (its overview Map) |
| I-M2 | the Places one-place loader unwired | the Places case |
| I-M3 | the Experiences loader unwired | the Experiences case |
| I-M4 | the cover dropped from the map marker | the 4 cover and cache cases |
| I-M5 | the cover dropped from the list row | the cover case |
| I-M6 | the cached label dropped | the 3 offline cases |
| I-M7 | the default loader drops the `offline` meta | the offline standalone case |
| I-M8 | a video cover drawn by its `url` (the video file) | the cover case; node: the poster case |
| I-M9 | a selected bubble's count left `onInk` on its `onInk` fill (§29.8) | the selected-contrast case |

Search (`MediaSearchNear.component.test.tsx`, plus the node file where named):

| # | Mutation | Red |
| --- | --- | --- |
| I-S1 | no `near` sent | 6 of 7 (all but the city-only case) |
| I-S2 | the refusal rendered as empty ("Nothing matched") | the refusal case |
| I-S3 | "near" on by default (applied silently) | 5 cases; node: 2 |
| I-S4 | the place context ignored (always the viewer) | the place and refusal cases; node: 2 |
| I-S5 | a radius past the server bound (10 km) | 6 cases; node: 2 |
| I-S6 | the chip never offered | 6 cases |

All fifteen went red on their first run. I-M1 to I-M8 and I-S1 to I-S6 were
re-run after the line-neutral rework, and each was red again.

### 29.6 Production — nothing here is deployed

Nothing in §29 is merged to main, pushed or deployed, so none of it is in any
build a user has. No flag, seed or migration was touched, and no database was
read. Once shipped, it stays dark behind the same two switches as §24:
- The World shell is the only in-app path to the Media Map and to Search, and
  `MEDIA_WORLD_SHELL_ENABLED` is seeded off and is OFF in production (§25).
- The canonical Map gateway places nothing in production, because
  `map_projection_enabled` has no row there (§23.1, §24.6). So no cluster, and
  no cover, is positioned on a map.

`/media-map` and `/media-search` are additive routes with no flag of their own,
so a deep link could open them (§19).

### 29.7 Checks

- **Client.**
  - `tsc` is clean.
  - eslint on every changed file: 0 errors. The warnings are the test files'
    `require` in `jest.mock` factories (the repo's pattern) and one
    pre-existing warning in `MediaMapCanvas.tsx` at line 19, which this lane
    did not touch.
  - `lint:bare-image`, `lint:imports`, `lint:mocks`, `lint:orphan-tests` and
    `lint:avatar-icon-sizing` pass. The last caught a hardcoded 40 px cover
    bubble, which now uses `avatar.s40`.
  - The media node tests pass: 346 / 346, 8 of them new.
  - The 15 media jest suites pass: 96 / 96 tests, 12 of them new, in 2 new
    suites.
- **Census.**
  - `check:doc-citations` passes, including §24's anchor on
    `MediaMapScreen.tsx:65`.
  - `check:citation-targets` stays at 165 / 165.
  - `check:census-scope-coverage` FAILS for media: 215 of 225 watched
    (95.6 %), against a floor of 96 %. It was 211 of 219 before this section.
    The two newly counted unwatched files are the routes that MD288's evidence
    rests on: `app/media-search/index.tsx` and `app/media-world/index.tsx`.
    Both are outside census-media's `CENSUS_SCOPE`. §19 already cited both, but
    in an anchored form this check does not count. Naming them here makes the
    check count them, and that is the true state: census-freshness does not
    watch the route that passes the viewer's point. This lane did not edit the
    scope. Adding both paths to it is the integrator's call, and would put media
    at 217 of 225.
  - `check:census-integrity` FAILS, and it is expected to. The rows now count
    two more C and two fewer W than the stated headline. Restating the headline
    is the integrator's job (§28.2), so this section does not.

### 29.8 A selected map bubble's count was invisible — found by lane H (§27), fixed here

**The defect.** Lane H measured it. A selected count bubble is filled
`color.onInk`
(`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:150#bubbleSelected: { backgroundColor: color.onInk },`).
Its count stayed `color.onInk` too
(`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:151#bubbleText: { color: color.onInk,`),
which measures 1.00:1. So the count vanished the moment its cluster was
selected.

**The fix.** Both cited lines are unchanged. When the bubble is selected, the
count is drawn in `color.ink`
(`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:203#selected && tailStyles.bubbleTextSelected`,
`travel-buddy-standalone/src/features/media/components/MediaMapCanvas.tsx:226#bubbleTextSelected: { color: color.ink },`).
That is the pair the Media Map's own "See these perspectives" button already
uses, and it measures well above 4.5:1. The unselected count is unchanged. A
cluster with a cover draws its count on its own dark badge, so this defect
never applied to it.

**Test and mutation.** The selected-contrast case is
`travel-buddy-standalone/src/features/media/__tests__/MediaMapCovers.component.test.tsx:211#it('a SELECTED count bubble keeps its count readable`.
It asserts four things:
- the selected fill is `color.onInk`;
- the count's colour differs from that fill;
- their WCAG contrast is at least 4.5:1 (the AA threshold for 12 px text,
  above the 3:1 floor that was asked for);
- the unselected count is still `color.onInk`.

With the selected style removed (I-M9) it goes red. Lane H's
`mediaContrast.test.ts` pins this pair as a known failure and is not on this
branch. The integrator reconciles that pinned value when both lanes are merged.
No row moves: MD403 is lane H's row.

## 30. Lane J — the media processing lifecycle has a worker, and retry cannot hide a ready asset — 2026-09-26

§28.9 moved MD338 back to **W** and gave it a RED WHEN: *a production caller
claims queued assets and completes or fails each one, and a retry cannot take a
`ready` asset off a read path.* This lane built against that falsifier. It adds
one migration file, seeded OFF and applied nowhere; it reads and writes no
database and turns on no flag.

Worked from `claude/sensing-completion-20260925` at `f31d94812`, on branch
`lane-j`. The code, the migration and the tests are in `99a4eea31`; this
section is in the commit after it. Every edit to a file this census cites by
line was made in place, on the cited line or at the file's end, so no cited
line moved; `check:doc-citations` is clean.

### 30.1 Row table

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| MD338 | **W** | **C** | §28.9's RED WHEN is false on this branch, on both halves. **(1) A production caller claims queued work and completes or fails each item.** `lib/media/mediaProcessingWorker` is started at boot (`artifacts/api-server/src/index.ts:302#startMediaProcessingWorker();`, imported at `artifacts/api-server/src/index.ts:41#import { startMediaProcessingWorker } from "./lib/media/mediaProcessingWorker.js";`). Each pass first recovers lapsed leases (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:235#out.recovered = await recoverStaleMediaProcessing(db, { now, limit });`), then reads `queued` and non-terminal `failed` work (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:240#.in("processing_status", ["queued", "failed"])`) and claims each item (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:261#const claim = await claimMediaProcessing(db, row.id, { now });`). It re-runs the upload pipeline over the stored object (§30.4), then completes the item with its lease token (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:280#done = await completeMediaProcessing(db, claim, {`) or fails it (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:301#const failure = await failMediaProcessing(`). **(2) A retry cannot take a `ready` asset off a read path.** Only `failed` is re-queued (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:434#if (processingStatus !== "failed") return { ok: false, alreadyQueued: false, notRetryable: true };`, called from `artifacts/api-server/src/services/media/MediaLifecycleService.ts:380#const refusal = await retryRefusal(sc, asset.processing_status); if (refusal) return refusal;`). The re-queue itself is conditional on `failed` and reads its row back, so a lost race cannot re-queue an asset that has since become ready (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:389#.eq("processing_status", "failed").select("id, processing_status").maybeSingle();`). While the worker is off, the retry refuses and writes nothing, so it cannot park work that nothing will claim (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:435#if (!(await isMediaProcessingWorkerEnabled(sc))) return { ok: false, alreadyQueued: false, workerDisabled: true };`). Tests: `artifacts/api-server/src/test/mediaProcessingWorker.test.ts:216#describe("census-media §30 (MD338) — retryMediaProcessing re-queues only a FAILED run"`, `artifacts/api-server/src/test/mediaProcessingWorker.test.ts:294#describe("census-media §30 (MD338) — POST /api/media/:id/retry"`, `artifacts/api-server/src/test/mediaProcessingWorker.test.ts:370#describe("census-media §30 (MD338) — runMediaProcessingPass"` and `artifacts/api-server/src/test/mediaProcessingWorker.test.ts:591#describe("census-media §30 (MD338) — the worker is started at boot"`: 26 cases, and every behaviour was seen red (§30.8). **Owner deletion is not graded here.** §28.9 lists `softDeleteMediaAsset`'s missing caller as evidence, but its RED WHEN does not name deletion. It is still not wired; §30.7 gives the reason and cites the spec. **RED WHEN** the boot call or the worker's claim, complete, fail or recover step is removed; or a retry writes to an asset whose `processing_status` is not `failed`; or a retry re-queues while `media_processing_worker_enabled` is off. |

### 30.2 The retry refuses what is not retryable

**Which states are retryable.** One: `failed`. It is the only value
MediaLifecycleService writes for a run that did not produce a ready asset.
`failMediaProcessing` writes it, terminal or not, and so does
`recoverStaleMediaProcessing` when a lease lapses.

The other states are refused:
- `ready` has nothing to retry.
- `removed` is an owner deletion.
- `rejected` and `expired` are not processing outcomes an owner can undo.
- The rest of the 0191 vocabulary (`local`, `uploading`, `uploaded`,
  `scanning`, `moderating`) are in-flight states. They are refused rather than
  guessed at.

`queued` and `processing` are unchanged: they are still answered as
`alreadyQueued`, with no write
(`artifacts/api-server/src/services/media/MediaLifecycleService.ts:378#if (asset.processing_status === "queued" || asset.processing_status === "processing") {`).

**The HTTP answers**, from the repo's `sendError` vocabulary. Both are
given only to the asset's owner.
- **409 `invalid_state_transition`**: the asset is the owner's, but its
  processing did not fail
  (`artifacts/api-server/src/routes/mediaActions.ts:593#sendError(res, "invalid_state_transition", "Only media whose processing failed can be retried");`).
- **404 `feature_disabled`**: the processing failed, but the worker is off
  (`artifacts/api-server/src/routes/mediaActions.ts:597#sendError(res, "feature_disabled", "Media processing is not available");`).
  This is the same code `/media/:id/event-link` gives when its flag is off.

The route checks both refusals on the existing call line
(`artifacts/api-server/src/routes/mediaActions.ts:213#if (sendRetryRefusal(res, result)) return;`).

**Id probing is still blocked.** A missing asset and one owned by somebody
else still return the service's plain `{ ok: false }`. They still share the
route's one `not_found`
(`artifacts/api-server/src/routes/mediaActions.ts:215#sendError(res, "not_found", "Media item not found");`).
So a stranger gets `not_found` for another owner's ready asset, never 409. The
test "no probing: a stranger's retry of a READY asset and a missing id both get
not_found" pins this.

**The race.** The old UPDATE matched on `id` and `owner_user_id` only. A
retry that read `failed`, while a worker completed the asset in between, would
have re-queued a READY asset. The test "does not re-queue an asset that became
READY between its read and its write" drives exactly that interleaving. It
uses the retry's own flag read as the point where the concurrent write lands.

### 30.3 The worker, a production caller

The worker follows the house pattern for a flag-gated interval worker (the
event-start scheduler and the Trips outbox worker):
- It is started unconditionally from `src/index.ts`.
- Its timer reschedules itself only after a pass ends, so two passes never
  overlap in one process. The startup delay is 3 minutes and the interval is
  1 minute.
- The flag is read at the top of every pass
  (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:227#if (!(await isMediaProcessingWorkerEnabled(db))) return { ...EMPTY, reason: "disabled" };`).

Across instances, the service's conditional claim makes a duplicate worker
harmless: only one lease token can land.

Each pass handles at most 10 assets. They are read earliest-retry first, and
`claimMediaProcessing` stays the authority on whether an asset is due and
unleased. The two repository guards that exist for this defect class now cover
the worker too:
- `src/test/schedulerRegistration.test.ts` checks that every `start*Worker`
  in `src/lib` is called from `src/index.ts`;
- `src/test/backgroundWorkerWiring.test.ts` checks that every imported
  starter is called.

Both went red when the boot call was removed (§30.8, J19).

A failure is **retryable** when another attempt could change it: the object
could not be read, the claimed row could not be re-read, or something threw.
It then follows the service's own clock: 5 attempts, backoff from 30 s.

A failure is **terminal at once** when the stored bytes decide it
(`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:305#outcome.permanent ? { now, maxAttempts: claim.attemptNumber } : { now },`).
That covers bytes that do not verify, bytes that carry location, bytes that do
not decode, and a container that states no size. The object will not change
between attempts, so retrying would only re-download it (up to 100 MB).

MediaLifecycleService's header names a "shared background-work tracker". It
does not exist as a module (§30.11 item 3), so there was none for the worker
to register with.

### 30.4 What "processing" means for a stored asset, and the limits

The upload route processes bytes it is **holding**:
- `verifyUploadedBytes` (`artifacts/api-server/src/routes/posts.ts:125#const verified = verifyUploadedBytes(rawBody, declaredInfo.mediaType);`);
- for a still, `processImage`, which auto-orients, caps, re-encodes (dropping
  all EXIF) and measures (`artifacts/api-server/src/routes/posts.ts:151#const img = await processImage(rawBody, sniffed);`);
- for a video, the fail-closed location scrub (`artifacts/api-server/src/routes/posts.ts:198#const scrub = stripVideoLocationMetadata(rawBody, sniffed);`)
  and the container probe (`artifacts/api-server/src/routes/posts.ts:146#probeVideoContainer(rawBody)`).

A row with both dimensions is written `ready`, and a row without them
`processing`
(`artifacts/api-server/src/lib/mediaAssets.ts:397#input.width != null && input.height != null ? "ready" : "processing"`).

**The pipeline cannot be re-run as it stands for a queued asset.** Its input
is the request body, and that is gone. What exists is the stored object. So
the worker downloads the stored object and runs the **same functions** over
it. It adds one check the upload does not need, the GPS check in step 2,
because the upload strips EXIF from bytes it holds and the worker can only
inspect bytes already stored:

1. **Verify the bytes and the kind.** The upload's own verifier checks that the
   object is non-empty, recognisable, within its real kind's ceiling, and the
   kind the row says it is
   (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:164#const verified = verifyUploadedBytes(bytes, kind);`).
2. **A still: no GPS, then decode and measure.** At upload `processImage`
   strips all EXIF on the way into storage, so a stored still that carries a GPS
   IFD did not come out of the pipeline. It is refused, not published
   (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:172#if (exifFactsFrom(bytes)?.hasGpsIfd) {`).
   The check uses `lib/exifFacts`, the `audit:storage-exif` parser, which never
   reads a coordinate. `processImage` then decodes the still and measures it,
   exactly as at upload
   (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:176#const img = await processImage(bytes, sniffed, MEASURE_MAX_DIM);`).
   The only difference is the cap. It is 16384 rather than 4096, so a stored
   object is measured as it is, not as a capped copy. A pipeline output is
   never resampled either way.
3. **A video: probe, then prove no location.** The container is probed
   (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:184#const probe = probeVideoContainer(bytes);`).
   The upload's scrub then runs
   (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:185#const scrub = stripVideoLocationMetadata(bytes, sniffed);`)
   and must find **nothing** to strip
   (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:187#if (scrub.stripped.length > 0) {`).
   A stored object that still carries location is refused, not repaired. The
   probe must also state a display size.
4. **Complete.** The asset is completed with the measured dimensions (and, for
   a video, the probed duration). The row's own thumbnail is passed through
   (`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:286#thumbnailPath: asset.thumbnail_path ?? null,`),
   because `completeMediaProcessing` writes both thumbnail columns, and without
   it completion would erase a poster or thumbnail the asset already had.

**The limits, stated.**
- **The worker never writes storage.** It does not re-store, re-encode,
  thumbnail or transcode anything. The re-encoded buffer from step 2 is
  discarded. The test double records every storage write, and the image case
  asserts there are none. A stored object is either what the pipeline
  produced, or it is refused.
- **A video whose container states no display size cannot be completed.**
  There is no decoder in this tier
  (`artifacts/api-server/src/lib/mediaProcessing.ts:17#Videos are NOT transcoded here (no ffmpeg in this tier)`).
  Such a video fails terminally, with that reason recorded in
  `processing_error`.
- **An owner retry of an asset at the attempt cap gets one more attempt.**
  The retry keeps attempt history, so the next failure is terminal at once
  (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:192#const terminal = claim.attemptNumber >= (opts.maxAttempts ?? DEFAULT_PROCESSING_MAX_ATTEMPTS);`).
  That behaviour predates this lane and is left as it was.

### 30.5 Gating

**New flag: `media_processing_worker_enabled`.** It is seeded FALSE by
`artifacts/api-server/src/migrations/3338_media_processing_worker_flag.sql:54#media_processing_worker_enabled',`
(`artifacts/api-server/src/migrations/3338_media_processing_worker_flag.sql:55#false,`),
with a rollback at `db/rollback/2026-09-26-3338-media-processing-worker-flag-rollback.sql`.
- **The number.** 3338 is unused and above 3321. It was chosen clear of 3322
  onward, which parallel lanes are likeliest to take.
- **The convention.** The file follows 3313's flag-seed convention:
  preconditions, `ON CONFLICT DO NOTHING`, a postcondition that refuses a seed
  finding the flag ON, and a NOTICE that counts what the first ON pass would
  claim.
- **Classification.** The lowercase `*_enabled` name makes it CAPABILITY by
  convention. `check:flag-polarity` reconciles it both ways: 203 flags
  classified, and 246 seeded with 202 read (each was one fewer before).

**One reader** is shared by the worker and the retry
(`artifacts/api-server/src/services/media/MediaLifecycleService.ts:421#export const MEDIA_PROCESSING_WORKER_FLAG = "media_processing_worker_enabled";`).
So "the worker is on" and "a retry may queue work for it" cannot disagree. It
is fail-closed: absent, FALSE and unreadable all read as off.

**Off means:**
- the worker makes one flag read a minute and nothing else (the test asserts
  exactly one request, no download and no write);
- the retry refuses a failed asset without writing.

**Why a new flag rather than `media_canonical_enabled`.** That flag gates the
canonical *writer*. Turning on processing changes which rows reach `ready`, and
so which reach the canonical read paths. That is a separate decision, and it
gets its own switch.

### 30.6 What the worker does not claim: `processing` rows with no lease

Two writers leave a `media_assets` row in `processing` with no lease:
- the upload route, for a video whose container states no size;
- `recordEntityMedia`, for every memory, hidden-gem and postcard file it
  records. It is staged "so it is not served as ready until a dimension sweep
  fills it in"
  (`artifacts/api-server/src/lib/mediaAssets.ts:861#as ready until a dimension sweep fills it in.`).

`claimMediaProcessing` would accept these rows, but the worker does not read
them. `recoverStaleMediaProcessing` skips them too, because it matches only a
lease that has lapsed, and these rows have none.

Completing them would publish legacy entity media as `ready` on the canonical
read paths. That dimension sweep is a separate decision and is not taken here.

These rows cannot be retried by their owner either, because they are not
`failed`. So they stay parked, as they were before this lane. Item 1 of §30.11
records it.

### 30.7 Owner deletion — not wired, and why

**No owner-facing delete route exists for a canonical asset.**
- The owner's delete routes take a post or a hidden-gem id and soft-delete that
  row
  (`artifacts/api-server/src/routes/mediaFeed.ts:2563#router.delete("/media/:id", asyncHandler(async (req, res) => {`,
  `artifacts/api-server/src/routes/posts.ts:2375#router.delete("/posts/:postId", async (req, res) => {`).
- `softDeleteMediaAsset` still has no non-test caller.

**The spec does not require an asset-level delete.**
- Its only owner-deletion content is a state:
  `owner_deleted` in §36's moderation vocabulary
  (`docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt:319#type MediaModerationStatus`).
  That vocabulary is MD274's and MD351's, and both are graded **C** on it.
- §41 names MediaAssetService and defines no operations for it
  (`docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt:354#MediaAssetServiceMediaAttachmentService`).
- §28.9's RED WHEN does not name deletion.

**Wiring it would be destructive in a way the spec leaves undefined.**
- `softDeleteMediaAsset` purges the object at `storage_path`
  (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:279#const paths = [...new Set([asset.storage_path, asset.thumbnail_path]`,
  `artifacts/api-server/src/services/media/MediaLifecycleService.ts:281#const { error: storageError } = await sc.storage.from(asset.storage_bucket).remove(paths);`).
- The upload stores ONE object. The canonical row records it
  (`artifacts/api-server/src/routes/posts.ts:260#storagePath: path,`), and the
  client is handed the same path to keep on the post
  (`artifacts/api-server/src/routes/posts.ts:284#url: mediaRelayUrl, path,`).
- `recordEntityMedia` records assets over the existing files of memories, gems
  and postcards.
- So an asset-level purge removes the bytes from under every legacy row and
  every §6.1 attachment that points at them, while those rows are still served.
  The existing post delete is soft and purges nothing.

What deleting an asset should do to what it is attached to is a product
decision for the owner. §30.11 item 2 records it.

MD338 is graded on its RED WHEN. If the integrator reads deletion as part of
the row, the row should stay **W**, with "an owner-facing canonical delete"
named as the remaining gap.

### 30.8 Mutations — each seen red, every file checked byte-identical after each run

All were run against `99a4eea31`. Each was applied in place, the suite named
was run, and the file was restored with `git checkout --`. `git diff --quiet`
confirmed each file byte-identical to the commit. The suite was green, 26 of
26, before the mutations and after them.

| # | Mutation, applied in place | File | Went red (of `mediaProcessingWorker.test.ts` unless named) |
| --- | --- | --- | --- |
| J1 | The whole retry fix reverted: the refusal call removed, and the UPDATE back to `.eq("id").eq("owner_user_id")` with `{ ok: !error }` | `services/media/MediaLifecycleService.ts` | 6: "refuses a READY asset and writes nothing, with the worker ON"; "refuses every other non-failed state too, writing nothing"; "does not re-queue an asset that became READY between its read and its write"; both service and route "GATED OFF" cases; route "a READY asset: 409 invalid_state_transition…" |
| J2 | Only the `!== "failed"` refusal line removed; the conditional UPDATE kept | same | 3: the two READY/non-failed service cases (the conditional UPDATE still matched nothing, but a PATCH was ISSUED), and the route's 409 |
| J3 | Only `.eq("processing_status", "failed")` removed from the UPDATE | same | 1: "does not re-queue an asset that became READY between its read and its write" |
| J4 | The retry's flag refusal removed | same | 3: both "GATED OFF" retry cases, and the race case (whose seam is that flag read) |
| J5 | The route's `sendRetryRefusal` call removed | `routes/mediaActions.ts` | 2: "a READY asset: 409…"; "GATED OFF: a FAILED asset gets 404 feature_disabled…" |
| J6 | The worker's flag gate removed | `lib/media/mediaProcessingWorker.ts` | 1: "GATED OFF: one flag read and nothing else…" |
| J7 | The claim replaced by `null` (nothing claimed) | same | 10: every complete and fail case, the re-claim, the end-to-end retry-to-ready, and the boot "runs the REAL pass" case |
| J8 | `completeMediaProcessing` replaced by a stub answering `false` | same | 6: image and video completion, the re-claim, the end-to-end retry-to-ready, the location case's CONTROL, and the boot real-pass case |
| J9 | `failMediaProcessing` replaced by a stub (nothing failed) | same | 5: every FAILS case |
| J10 | Permanent failures not made terminal (`{ now }` for both) | same | 4: the four "FAILS terminally…" cases |
| J11 | `recoverStaleMediaProcessing` not called | same | 1: "RECOVERS a stale lease…" |
| J12 | The GPS refusal disabled (`if (false && …)`) | same | 1: "…stored still carries a GPS IFD". Under it the still COMPLETED (`completed: 1`). |
| J13 | The video strip check disabled (`if (false && …)`) | same | 1: "…stored video still carries a location atom (its size is readable)". Under it the video COMPLETED. |
| J14 | `verifyUploadedBytes(bytes)`, without the row's kind | same | 1: "FAILS terminally when the bytes are not the kind the row says…" |
| J15 | Thumbnail not passed through (`thumbnailPath: null`) | same | 1: "claims a QUEUED image… completes it READY with its measured size" |
| J16 | Only `queued` read, not `failed` | same | 2: "re-claims a FAILED asset once its retry clock is due…"; "RECOVERS a stale lease…" (the recovered row was no longer seen as not-due) |
| J17 | The timer not re-armed after a pass | same | 1: "arms once, runs the pass after the startup delay, re-arms after each pass, and stops" |
| J18 | The no-argument start running a no-op instead of `runMediaProcessingPass` | same | 1: "with no arguments — exactly as src/index.ts calls it — runs the REAL pass against the service client" |
| J19 | The boot call removed (`startMediaDedupWorker();` restored alone; import kept) | `src/index.ts` | 3: "src/index.ts imports startMediaProcessingWorker… and calls it"; `backgroundWorkerWiring.test.ts` "every start* imported into the entry point is also called there"; `schedulerRegistration.test.ts` "every background worker exported from src/lib is started from src/index.ts" |
| J20 | 3338 seeded `true` | `migrations/3338_media_processing_worker_flag.sql` | 1: "seeds exactly the flag the service reads, FALSE…" |

**How the tests were built.** The double is the real supabase-js client over
`src/test/helpers/postgrestOracle.ts`, an injected `fetch` that emulates
PostgREST over in-memory tables. This matters in three ways:
- **A zero-row conditional UPDATE comes back as the client really returns
  it.** J2 and J3 depend on that.
- **The column lists are the migrations'.** `media_assets` gets 0191, 2250,
  2951, 2952 and 2953; `media_processing_attempts` gets 2951. A misspelt
  column is a 42703, not a silent `undefined`.
- **The fixtures are real where it counts.** The video fixtures are real
  ffmpeg output from `videoProbeFixtures.ts`. The location case adds a `©xyz`
  atom to one and keeps a control that completes, so its refusal is shown to
  be the atom's. The GPS still is hand-built, because sharp writes no GPS IFD
  (`exifFacts.test.ts` measured that).

### 30.9 Production — nothing here is deployed

- **Nothing was applied anywhere.** Migration 3338 has not been applied to
  portava-ci or to production. Where it is absent, the flag reads FALSE, and
  that is the same as applied-and-off.
- **Nothing has been deployed.** A server built from any tree before this
  branch has no worker, and its retry re-queues a `ready` asset (§28.9's
  defect). This lane did not look at what is deployed.
- **What deploying with the flag off changes.** The one user-visible change is
  the retry: it refuses `ready` with a 409, and a failed asset with a 404
  `feature_disabled`, where it used to re-queue. The worker is one flag read a
  minute.
- **What turning the flag ON means** — an owner decision, not a rollout step.
  On the first pass the worker claims every `queued` row (any owner retry since
  the route shipped), and each non-terminal `failed` row once its clock is due.
  Each one it completes becomes `ready` and joins the canonical read paths
  under their own eligibility rules. 3338's NOTICE counts both groups on the
  database it runs against.
- **What production writes today.** Per §23.2, production's canonical writer
  is off (`media_canonical_enabled` FALSE), so no new `media_assets` row is
  written there for a worker to process.
- **This section does not claim** that any production row is `queued` or
  `failed`. It did not read one.

### 30.10 Checks

All were run from `artifacts/api-server` on the final tree.

| Check | Result |
| --- | --- |
| `pnpm -s run typecheck` | exit 0 (after symlinking `lib/api-zod` and `lib/db` `node_modules` into the worktree; both are gitignored) |
| `pnpm -s run typecheck:tests` | exit 0: 863 diagnostics across 115 files, the same as the baseline |
| `node --import tsx/esm --test src/test/mediaProcessingWorker.test.ts` | 26 / 26 |
| The existing suites: `mediaAssetsRecord`, `mediaActionsCompass`, `mediaActionsSection21`, `mediaEventLink`, `mediaAccess`, `mediaAccessFailClosed`, `mediaCanonicalLayers`, `mediaUploadHardening`, `mediaVideoTransport`, `mediaVideoPosterGeneral`, `backgroundWorkerWiring`, `schedulerRegistration`, `fakeConformanceRegistry`, `silentSchemaErrorCatches`, `uncheckedSupabaseReads`, `accountStatusFailOpenWrites` | 430 / 430 |
| `check:doc-citations`, `check:citation-targets`, `check:citation-symbols` | clean; citation-targets at its ceiling, 165 / 165 |
| `check:test-registration` | passes; the new file is registered in `test` (1478 registered) |
| `check:census-scope-coverage` | passes after the widening in §30.12. census-media is at 241 cited and 232 watched, 96.3% against its 96% floor; before the widening it was at 93%. The floor is unchanged. |
| `check:write-path-columns` | exits 2 here on "KNOWN_PROD_PROJECT_REF is empty", as expected. The offline extractor `extractSchemaReferences` over routes, services, domain, server and `lib/media` resolves every site in the three changed code files, with none skipped and none partly unresolved. |
| `check:schema-references`, `check:enum-literals`, `check:flag-polarity`, `check:migration-prefixes`, `check:silent-supabase-writes`, `check:unissued-supabase-writes`, `check:async-handlers`, `check:route-auth-gate`, `check:guard-coverage`, `check:writerless-reads`, `check:not-null-writes`, `check:test-runner-flags`, `check:api-prefix`, `check:deletion-coverage`, `check:data-rights` | all exit 0 |
| `check:census-row-move-labels`, `check:census-policy-citations` | exit 0 |
| `check:census-integrity` | **fails, as expected.** The stated headline is C 400 / W 38; the rows now count C 401 / W 37, because MD338 moves W → C and this section does not restate the headline. The integrator restates it. |
| `check:census-freshness` | **fails: census-media is STALE.** Eight counted files changed that its acknowledgement does not name: the three new files; `src/index.ts`; and four files under `src/test/` that this section newly brings into scope, which changed before this lane. The acknowledgement is not this lane's file, so the integrator names them or re-measures. |

### 30.11 Found while doing it — recorded, not fixed

1. **`processing` rows with no lease are never processed, and cannot be
   retried.** §30.6 gives the detail. `recordEntityMedia`'s own comment
   promises a "dimension sweep", and none exists. This is an owner decision,
   because completing these rows publishes legacy entity media on the canonical
   read paths.
2. **No owner-facing canonical delete.** §30.7 gives the detail. An
   asset-level purge would remove bytes that legacy rows still serve.
3. **The "shared background-work tracker" does not exist.**
   MediaLifecycleService's header says the purge runs "on the shared
   background-work tracker"
   (`artifacts/api-server/src/services/media/MediaLifecycleService.ts:21#removed on the shared background-work tracker`).
   No such module is in the tree. The service returns the `purge` promise, and
   callers await it or ignore it.
4. **One existing test's retry half is now vacuous.**
   `mediaAssetsRecord.test.ts` "uses only CHECK-legal status values when it
   does transition" retries through a fake that answers every table with the
   asset row
   (`artifacts/api-server/src/test/mediaAssetsRecord.test.ts:625#await retryMediaProcessing(retryClient, ASSET, OWNER);`).
   Its flag read therefore reads `enabled` as undefined, which is off. The retry
   now refuses and writes nothing, so that half checks an empty list and passes.
   The test is not this lane's file. The re-queue's values are asserted here,
   against the migrations' columns, in "re-queues a FAILED asset (terminal or
   not)…".
5. **The legacy owner delete still distinguishes "exists" from "not yours".**
   `DELETE /media/:id` answers a non-owner 403
   (`artifacts/api-server/src/routes/mediaFeed.ts:2582#sendError(res, "forbidden", "Only the owner can delete this post"); return; }`)
   and a missing id 404. That lets a caller tell which post ids exist. It is
   outside MD338.
6. **An already-queued asset still answers 202 `alreadyQueued: true` while the
   worker is off.** That path writes nothing, so it parks nothing new. It is
   left as it was, because an existing test pins that shape.

### 30.12 Files changed, and the census that counts them

| File | Change | Counted by census-media |
| --- | --- | --- |
| `artifacts/api-server/src/services/media/MediaLifecycleService.ts` | six lines changed in place (none moved); helpers appended | yes (directory) |
| `artifacts/api-server/src/routes/mediaActions.ts` | one import and one call line extended; helper appended | yes |
| `artifacts/api-server/src/lib/media/mediaProcessingWorker.ts` | new | yes (directory) |
| `artifacts/api-server/src/index.ts` | two lines extended in place | added below |
| `artifacts/api-server/src/test/mediaProcessingWorker.test.ts` | new | added below |
| `artifacts/api-server/src/migrations/3338_media_processing_worker_flag.sql` | new | added below |
| `artifacts/api-server/src/lib/exifFacts.ts` | unchanged; §30.4 grades the worker's use of it | added below |
| `artifacts/api-server/src/test/helpers/postgrestOracle.ts`, `artifacts/api-server/src/test/videoProbeFixtures.ts`, `artifacts/api-server/src/test/exifFacts.test.ts` | unchanged; §30.8 rests on them | added below |
| `artifacts/api-server/src/test/schedulerRegistration.test.ts`, `artifacts/api-server/src/test/backgroundWorkerWiring.test.ts` | unchanged; §30.3 and J19 rest on them | added below |
| `artifacts/api-server/src/test/mediaAssetsRecord.test.ts` | unchanged; §30.11 item 4 is about it | added below |
| `db/rollback/2026-09-26-3338-media-processing-worker-flag-rollback.sql` | new | no — a rollback is not graded |
| `artifacts/api-server/package.json` | the test path appended to `test` | no (machinery) |
| `artifacts/api-server/src/scripts/checkCensusFreshness.ts` | census-media's `CENSUS_SCOPE` widened, appended at its end | no (machinery) |
| `docs/architecture/census-media.md` | this section, appended; no earlier line edited | — |

This section does not edit `CENSUS_STALENESS_ACKNOWLEDGED.json`.

### 30.13 Integration: lane J merged, one vacuous case repaired, and the headline

**Lane J merged** from `lane-j` (`99a4eea31`, `9055552a8`). It was reviewed
before merging:
- The retry re-queues only a `failed` asset. The update is conditional on
  `failed` and reads its row back. Every refusal writes nothing, and a
  stranger and a missing id still share one `not_found`.
- The worker reads only through its lease token and never writes storage.
- 3338 seeds the flag FALSE, and fails its own postcondition if the flag is
  ON.

**§30.11 item 4 is fixed here, not left vacuous.** The shared fake in
`mediaAssetsRecord.test.ts` now answers a `feature_flags` read with the flag
ON. The case also asserts that the retry wrote something
(`artifacts/api-server/src/test/mediaAssetsRecord.test.ts:625#await retryMediaProcessing(retryClient, ASSET, OWNER); assert.ok(retryClient.writes.some(`).
With the flag read as off again, that case goes red. Both edits are on
existing lines.

**3338 is applied to no database.** CI's `audit:schema` diffs only the schema
objects a migration creates (tables, columns, functions, indexes, policies,
enums, triggers and views). A flag-seed INSERT creates none of these, so a
green drift job says nothing about whether 3338 was applied. The flag reads
FALSE wherever it is absent, which is the seeded state.

**Freshness.** The census-media acknowledgement names the eight counted files
the merge made visible.
- Four are lane J's own, and §30 grades them: `mediaProcessingWorker.ts`,
  its test, 3338, and `index.ts`'s start call.
- Four are older tests that joined the scope because §30 now cites them:
  `backgroundWorkerWiring.test.ts`, `schedulerRegistration.test.ts`,
  `mediaAssetsRecord.test.ts` and `videoProbeFixtures.ts`.

**The headline after lane J**, restated from `check:census-integrity`:

> | Measure | §28.9 | Now, after lane J |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 400 | **401** |
> | BUILT-BUT-WRONG | 38 | **37** |
> | NOT-BUILT | 12 | **12** |
> | CANNOT-VERIFY | 0 | **0** |
> | **CONSTRUCTED%** = (C+W)/450 | 97.3 % | **438 / 450 = 97.3 %** |
> | **CORRECT%** (raw) = C/450 | 88.9 % | **401 / 450 = 89.1 %** |
>
> The one move is MD338 W → C (§30). It is a construction verdict: the worker
> is seeded off, and nothing here is deployed.
