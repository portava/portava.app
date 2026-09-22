# LANE HM-CLIENT — report

Worktree `/home/user/wt-hm-client`, branch `lane/hm-client`, from `561a0a7b0`.
Every file touched is inside `travel-buddy-standalone/` and inside this lane's
ownership list. `artifacts/api-server/**` was read extensively and **not
edited**. `docs/architecture/census-*.md` was read and **not edited**.

## 0. How the "current verdict" column was derived

Not by reading the census body. By the tool:

```
cd artifacts/api-server
CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity 2>/dev/null | grep '^highlights-memories|'
```

266 rows out, `highlights-memories|<id>|<verdict>|<line>`, normalised to
C/W/N/X. Run **before** any edit and **after** the last commit; the two dumps
are byte-identical, which is the expected result and not a null finding — this
lane may not edit `census-highlights-memories.md`, so it moves no verdict cell
by construction. Everything in the "my verdict" column below is a **proposal
for whoever owns the census**, measured against the tree at
`travel-buddy-standalone/` and `artifacts/api-server/` as of this branch.

**Headline: I propose ZERO verdict moves across my 56 rows.** Client work
landed, was wired to a screen the navigator mounts, and was tested; none of it
removes the blocker any of these rows actually rests on. Eleven rows carry
evidence I re-tested and found FALSE — §7 — and in every one of those cases the
verdict still stands for a different, re-measured reason.

### A format finding that changes no count

`checkCensusIntegrity.ts:157#VERDICT_ALIASES` accepts `C/BAC/BC`, `W/BBW/BW`,
`N/NB`, `X/CV` — short tokens only. Several later sections restate rows in the
SPELLED-OUT form (`| H93 | BUILT-BUT-WRONG | … |` at line 5459, and likewise
H99 `:5461`, H100 `:5462`, H112 `:5463`, H75 `:4855`/`:5250`, H91
`:4852`/`:5245`, H103 `:4858`, H201 `:4854`, H260 `:4857`). The parser does not
read those as verdicts, so the tool reports each row's current line as the
older short-form cell and a reader following that line gets the older REASON.
I checked every one against its long-form restatement: **all agree on the
bucket (W), so no count anywhere changes.** Flagging the format, not a defect
in any verdict.

---

## 1. Row table

`current` = the tool dump (line cited). `mine` = what I measured. `=` means I
re-measured and propose no move.

### Highlight presentation and curation

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H21 | W `:355` | = W | Stated missing list is **stale**: `public.highlights` now carries `lifetime_class`, `lifecycle_state`, `highlight_type`, `renderer_version` — `artifacts/api-server/src/lib/capability/snapshots/20260922-production-schema.json` `/tables/highlights` (22 columns). Still absent there: `ranking_score`, `reason_codes`, `audience_policy_id`, `presentation_json`; `source_memory_ids` lives in `highlight_sources` (2722, applied) instead. Schema row — not client-movable |
| H31 | W `:1220` | = W | Same measurement, same file. The stated "none of §3.5's …" is false for four of the nine |
| H93 | W `:855` | = W | Evidence **falsified twice** (§7.1). Client half BUILT this lane: `travel-buddy-standalone/src/services/highlights.ts:493#fetchHighlightSources` and `sourceMemoryIds` on create. W stands on the row's real reason — a sourceless create still succeeds (`artifacts/api-server/src/routes/highlights.ts:736`, `.optional()`) |
| H99 | W `:815` | = W | Re-tested: `rankHighlights` still has **no production caller** — grep over `artifacts/api-server/src` outside `highlightRanking.ts` returns only the census note at `artifacts/api-server/src/routes/highlights.ts:1261`. `ranking_score` absent from `/tables/highlights` in the 20260922 snapshot |
| H100 | W `:816` | = W | Evidence **falsified three ways** (§7.2). Verdict unchanged for §M's reason at `docs/architecture/census-highlights-memories.md:5462` — `pinnedFirst` runs on one of four read surfaces and there is no automatic ranking on it to outrank |
| H101 | W `:817` | = W | `DIVERSITY_DIMENSIONS` still applied only inside the uncalled `rankHighlights`. Same grep as H99 |
| H103 | W `:856` | = W | Evidence **falsified** (§7.3): 2339 IS applied. Re-measured blocker: `highlights_feed_bounded_enabled` reads `false` in the snapshot's flags block, so `isFlagEnabled` fails closed. Flag-off = W under this census's own rule |
| H104 | W `:3923` | = W | `GET /memories/graph` (`artifacts/api-server/src/routes/memories.ts:1010`) has **no client caller** — grep for `memories/graph` across `travel-buddy-standalone/src` and `app` returns nothing. Building one needs a screen registered in shared navigation (§6b) |
| H105 | W `:3922` | = W | Same endpoint, same absence. §E.5 filed it product-blocked and this lane does not overturn that |
| H112 | W `:1269` | = W | `privacy_eligibility` is still a gate rather than a weight in `artifacts/api-server/src/services/memoryRetrieval/searchMemories.ts`. Server model; untouched |

### Actions surface

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H102 | N `:463` | = N | Re-tested on the CLIENT: `travel-buddy-standalone/src/components/HighlightViewer.tsx` offers like, reply, report, archive, delete, pin and privacy. Not one of §12's DO THIS / SAVE / ADD TO TRIP / VIEW PLACE / ASK / MEET |
| H107 | N `:1259` | = N | Grep re-run over `artifacts/` + `travel-buddy-standalone/` for `doAgain\|do_again\|takeMeBack\|take_me_back`: the only hits are `artifacts/api-server/src/services/memory/memoryKernelMetrics.ts:88-89`, a metric string that CITES the absence |
| H108 | N `:1260` | = N | Same grep |
| H259 | N `:1473` | = N | Same grep. No route exists to build a client against (§6a) |

### Consent and privacy controls the user operates

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H2 | W `:3928` | = W | §1's private-first mandate is about the AUTOMATIC path; no candidate pipeline exists to default. No client surface can supply one |
| H75 | W `:808` | = W | Evidence **falsified** (§7.4): 2721 IS applied. Client surface exists and is reachable: `travel-buddy-standalone/src/features/highlights/HighlightPrivacySheet.tsx` ← `src/components/HighlightViewer.tsx:60,777` ← `app/(tabs)/passport.tsx:20,325`. W stands: `mayProject` still has no production caller (§P.2) |
| H76 | W `:427` | = W | Ladder is now owner-SELECTED on Highlights (`artifacts/api-server/src/routes/highlights.ts:332#applyLocationPrecision`) and settable from the sheet above; it still does not reach a Memory's `location_lat`/`location_lng` |
| H87 | W `:443` | = W | `DO_NOT_RESURFACE` settable from the sheet; still a Highlights-surface control, not a Memory one |
| H88 | W `:444` | = W | `DO_NOT_INCLUDE_IN_RECAPS` settable from the same sheet; still no recap-specific enforcement path |
| H90 | W `:4879` | = W | Re-read: `public.highlights` carries no trip reference — confirmed against `/tables/highlights` (22 columns, none trip-keyed). Nothing the client can send fixes that |
| H91 | W `:814` | = W | Settable and enforced on `proactive_resurfacing` / `public_projection`; not on the collections preview or the media bytes |
| H92 | W `:4880` | = W | `RETAIN_BUT_DO_NOT_PERSONALIZE` storable and separable; no personalization path consults it |
| H187 | W `:819` | = W | Evidence **falsified** (§7.5): 2720 IS applied. Still Highlights-surface only — no such control on a Memory |
| H188 | W `:820` | = W | Same falsification, same remaining gap |
| H189 | W `:3924` | = W | Cache half closed server-side; the losing audience of a narrowed `public` Memory is still unenumerable |
| H190 | W `:3925` | = W | The media bytes stay publicly served. Server/storage |
| H201 | W `:823` | = W | Evidence **falsified** (§7.6): 2721 IS applied. Ladder does not reach a Memory's lat/lng |

### Memory creation, confirmation and correction

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H4 | W `:3048` | = W | Returns to C only when somebody enumerates `StampAwardEngine`'s callers. Server-side enumeration; out of this lane |
| H17 | W `:351` | = W | Ten missing `memories` columns; schema row |
| H130 | W `:1315` | = W | Evidence **falsified** (§7.7): 2710 IS applied. Re-measured blocker: `memory_kernel_enabled` is `false` in the snapshot, so `isFlagEnabled` fails closed and the legacy direct write serves every request |
| H131 | W `:1316` | = W | Same gate |
| H132 | W `:1317` | = W | Same gate |
| H133 | W `:1318` | = W | Same gate; §21's five-step deletion lifecycle is server work |
| H136 | W `:1321` | = W | Same gate. Client now sends a §19 operation id on `POST /memories/:id/items` (`src/services/memories.ts#addMemoryItemFromUrl`), which is H175's half, not H136's |
| H137 | W `:1322` | = W | Same gate; storage delete stays outside the command by design |
| H138 | W `:1323` | = W | Consent authorization is server-side and unchanged |
| H139 | W `:1324` | = W | Same |
| H140 | W `:1325` | = W | `place_correction_rate` (H215) still does not exist |
| H141 | W `:1326` | = W | Same gate |

### Pin / unpin / publish / hide

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H142 | W `:5689` | = W | Client half is real and reachable: `src/features/highlights/lifetimeApi.ts:83#pinHighlight` ← `src/components/HighlightViewer.tsx:64,367-380` ← `app/(tabs)/passport.tsx:325`. W stands on the cited reason — `memory_kernel_enabled` FALSE, so the legacy direct write serves and the command boundary is unreachable |
| H143 | W `:5690` | = W | Same pair, same gate. `unpinHighlight` at `lifetimeApi.ts:88` |
| H144 | W `:5692` | = W | No storable published state: `/tables/highlights` has no `published_at` and `lifecycle_state`'s CHECK admits no `PUBLISHED`. Nothing a client can send |
| H145 | W `:5691` | = W | **Client hide/unhide built against the CURRENT contract and verified.** `archiveHighlight` / `unarchiveHighlight` (`src/services/highlights.ts`), archive button at `HighlightViewer.tsx:705-720`, restore at `app/highlights/archived.tsx`. W stands on the command boundary. Required API shape if an inverse is added: §5 |

### Media on the client

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H25 | W `:1214` | = W | `memory_items` is still the 1:N table of client-supplied URLs. Server/storage |
| H80 | N `:431` | = N | `memory_items` has no visibility column; there is no field for a client to send (§6a) |
| H182 | N `:550` | = N | Two rendition tiers, not four. Server/media pipeline |

### Sync and offline

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H175 | W `:818` | = W | Evidence **falsified** (§7.8): 2710 IS applied. **Client half BUILT this lane** — `src/services/memories.ts` now sends `Idempotency-Key` on create, patch, delete, media add and media remove, stable across a blind retry. W stands on the re-measured blocker: `memory_kernel_enabled` is FALSE, so a replayed key still produces a second write |
| H178 | W `:3459` | = W | **Client half BUILT this lane** — a 409 now arrives as `kind: 'conflict'`, distinguishable from a dropped socket, with the server's sentence intact. W stands on both stated reasons: same-field concurrent edits still resolve LWW (owner decision D-C1, open), and the CAS is on the legacy write |
| H180 | N `:543` | = N | Nothing converges cross-device. Needs a server-side identity for an operation across devices (§6a); the client operation id added here is per-device |

### Resurfacing surface

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H15 | W `:344` | = W | `MemoryRecapsService` is over derived preferences and Passport artefacts, not Memories, and ships behind `memory_recaps` seeded off. Flag-off gates the thing the row is about, so W |
| H260 | W `:1474` | = W | Evidence **falsified** (§7.9): 2720 IS applied. W stands on the half that was always true — no anniversary model and no fatigue model anywhere |

### Search / retrieval surface

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H13 | W `:799` | = W | Evidence **falsified twice** (§7.10): not test-only — `POST /memories/search` is served at `artifacts/api-server/src/routes/memories.ts:897` and reached by `src/features/memories/memorySearchApi.ts:125` ← `MemorySearchScreen` ← `app/memory/search.tsx` ← `app/memory/[id].tsx:242`; and 2730 IS applied. W stands: the row is `MemorySearchService` as §15 specifies it, and §15's retrieval model is not what ships |
| H79 | W `:2150` | = W | The public surface still reads canonical `memories`, not the 2338 derivative |
| H258 | W `:2151` | = W | Evidence already corrected in-document; §15 retrieval still unbuilt |

### Fallback rendering

| row | current | mine | evidence |
| --- | --- | --- | --- |
| H266 | W `:4349` | = W | **I nearly graded this N from the body at `:1485`.** The tool's last statement is `:4349`: a deterministic fallback EXISTS (`artifacts/api-server/src/routes/compass.ts:1068#HONEST_FALLBACK_MESSAGE`) and renders no Memory fact, so it is half. Re-tested, unchanged. No AI presentation of a Highlight exists on the client to fall back FROM, so there is nothing for this lane to render |
| H265 | N `:1484` | = N | No summarization of Memories exists; `NarrativeDerivative` is `NOT_CONFIGURED` |

---

## 2. Service naming — the thing I was asked to identify

The brief allowed for the client service living under another name. It lives
under **three**, and all three are Highlights/Memories client code:

| path | what it is |
| --- | --- |
| `travel-buddy-standalone/src/services/highlights.ts` | the named one. Feeds, create, view, like, viewers, reply, report, delete, §21 archive |
| `travel-buddy-standalone/src/services/memories.ts` | the named one. CRUD, items, feed, trip memory, like |
| `travel-buddy-standalone/src/features/highlights/lifetimeApi.ts` | §4 lifetime classes and §12 pin/unpin. **Treated as another lane's prior work and NOT edited** — I only traced it |
| `travel-buddy-standalone/src/features/highlights/privacyControlsApi.ts` | §10/§11 consent, precision ladder, resurfacing controls. Same: traced, not edited |
| `travel-buddy-standalone/src/features/memories/memorySearchApi.ts` | §15 `POST /memories/search`. Same |

I edited only the two under `src/services/`, which are unambiguously mine, and
left `src/features/**` alone because it is not on the ownership list and is
already built and tested. If a later lane wants the four `src/features` files
folded into the two services, that is a rename, not a gap.

---

## 3. BUILT

### 3.1 `src/services/memories.ts` — §19 client operation ids (H175) and a visible conflict (H178)

Commit `a4c10f3ed`.

`artifacts/api-server/src/lib/memoryCommandBus.ts:584#readMemoryCommandEnvelope`
has read an `idempotency-key` header on every Memory write route, and mints
`randomUUID()` when it is absent — its own comment says that is so "an unaware
client is not given a dedup window keyed on something it did not choose". This
client sent no header at all. It now sends one on `POST /memories`,
`PATCH /memories/:id`, `DELETE /memories/:id`, `POST /memories/:id/items` and
`DELETE /memories/:id/items/:itemId`.

The default key is derived from verb + subject + a key-order-independent
fingerprint of the payload, inside a 90-second window, rather than minted per
call. A key minted per call is exactly as useless as the server minting one:
the second attempt at the same intent carries a different key and is a
different command. The screens that call this module retry by calling the same
function again with the same arguments, hold no operation id, and are **not**
this lane's files. A caller that knows better passes `operationId` and the
guessing stops.

`kind` was added additively. Every existing caller destructures `ok` and
`message`, compiles unchanged, and behaves identically; the server's own 409
sentence still reaches `app/memory/edit.tsx:135` and is now also machine-
readable as `'conflict'`.

One honest compromise, documented in the file: `MemoryWriteResult`'s
`operationId` is **optional on the success branch and required on the failure
branch**. `app/memory/[id].tsx:178` narrows settled `addMemoryItem` results
with a hand-written predicate spelled `PromiseFulfilledResult<{ ok: true; item:
MemoryItem }>`; a required field there stops that file compiling, and this lane
may not edit it. Retry logic keys on the failure branch, where it is required.

**Not claimed:** server-side dedup. `memory_command_receipts` (2710) is applied
but sits behind `memory_kernel_enabled`, which reads `false` in the committed
production snapshot. A replayed key currently produces a second write and only
a log line records it. Implemented and tested; deployed behaviour unverified
(no device, no live call — see §8c).

### 3.2 §12 provenance — a Highlight can say what it is built from (H93)

Commits `85920c0a9`, `f97c358df`, `04bf8ca48`.

Files added/changed, all inside ownership:

- `src/services/highlights.ts` — `fetchHighlightSources`, `sourceMemoryIds` on
  `CreateHighlightInput` (sent only when non-empty; `[]` is a claim and absent
  is a different one), `Highlight.sourceMemoryIds` left **undefined** on reads
  that do not project it, and `lifetimeClass` / `lifetimeProvenance` /
  `lifecycleState` / `lifecycleProvenance` carried through `mapHighlight`
  three-valued.
- `src/hooks/useHighlightSources.ts` — four states, because three of them
  collapse into an empty list if the distinction is not carried and only a 200
  may say "sourceless".
- `src/components/highlights/HighlightSourcesDisclosure.tsx` — §4's five truth
  levels named per source; a retry offered for `degraded_unavailable` /
  `network_unreachable` / `db_error` and **not** for `feature_disabled`.
- `app/highlights/archived.tsx` — mounts it, collapsed, one row open at a time.
- three test files (§4).

### 3.3 IMPORT CHAINS (every component I claim is built)

**`HighlightSourcesDisclosure`** — new this lane:

```
app/(tabs)/passport.tsx:29           import { PassportOwnerMenuSheet }
app/(tabs)/passport.tsx:906          <PassportOwnerMenuSheet …>
src/components/passport/PassportOwnerMenuSheet.tsx:142
                                     closeThenNavigate(p.onClose, '/highlights/archived')
app/highlights/archived.tsx:38       import { HighlightSourcesDisclosure }
app/highlights/archived.tsx (list)   <HighlightSourcesDisclosure … />
src/components/highlights/HighlightSourcesDisclosure.tsx:37
                                     useHighlightSources
src/hooks/useHighlightSources.ts:36  fetchHighlightSources
src/services/highlights.ts:493       GET /api/highlights/:id/sources
```

`app/(tabs)/passport.tsx` is a tab the navigator mounts.
`app/highlights/archived.tsx` is registered at
`src/navigation/portavaRoutes.ts:1082` (`path: 'highlights/archived'`) and
`node scripts/check-route-registry.mjs` passes — 199 screens, all represented.
Rendering is pinned by `app/highlights/__tests__/archived.sources.component.test.tsx`,
which mounts the real screen and asserts the disclosure is on it.

**`src/services/memories.ts`** (no new component; existing reachable callers):

```
app/(tabs)/passport.tsx → MemoriesTab → MemoriesStrip.tsx:7   getMemoryFeed
MemoriesStrip.tsx:56    router.push('/memory/<id>')
app/memory/[id].tsx:24  addMemoryItem, deleteMemoryItem, deleteMemory
app/memory/edit.tsx:19  getMemory, updateMemory
app/trip/[id].tsx:54    getTripMemory, createTripMemory
```

Every §19 header therefore crosses the wire from screens already on the
navigator, with no edit to any of them.

**Chains I traced but did NOT build** (prior lanes' work, verified reachable so
the rows above can rest on them):

```
app/(tabs)/passport.tsx:20,325 → src/components/HighlightViewer.tsx:60,777
                               → src/features/highlights/HighlightPrivacySheet.tsx   (H75, H76, H87, H88, H91, H92, H187, H188, H201)
app/(tabs)/passport.tsx:20,325 → src/components/HighlightViewer.tsx:64,367-380
                               → src/features/highlights/lifetimeApi.ts:83,88        (H142, H143)
app/(tabs)/passport.tsx        → MemoriesStrip → app/memory/[id].tsx:242
                               → app/memory/search.tsx → src/features/memories/MemorySearchScreen.tsx
                               → memorySearchApi.ts:125                              (H13)
```

---

## 4. TEST EVIDENCE

Commands run from `/home/user/wt-hm-client/travel-buddy-standalone`, exactly as
`package.json` defines them.

| command | result |
| --- | --- |
| `npm run typecheck` (`tsc -p tsconfig.json --noEmit && node scripts/check-import-extensions.mjs`) | **pass**, exit 0. `lint:imports — no import-extension violations found in src.` |
| `npm test` (`node scripts/run-node-tests.mjs`) | **`# tests 6598 / # pass 6598 / # fail 0`**, exit 0. Pre-change baseline on the same tree was `# tests 6595 / # pass 6595 / # fail 0` |
| `npm run test:component` (`check-test-mocks` + `jest` + `jest -c jest.web.config.js`) | **pass**, exit 0. Native run: **`Test Suites: 617 passed, 617 total` / `Tests: 3919 passed, 3919 total`**. Web run: **`Test Suites: 3 passed, 3 total` / `Tests: 8 passed, 8 total`** |
| `npm run typecheck:tests` | **pass**: "173 diagnostics across 60 files (baseline 173 across 60) … no file is above its baseline" |
| `node scripts/check-route-registry.mjs` | **pass**: "All 199 screen file(s) are represented in PORTAVA_ROUTES and all 9 layout file(s) …" |
| `node scripts/check-orphan-tests.mjs` | **pass**: "942 test files; 29 orphaned (all known…); 0 newly introduced" |
| `node scripts/check-test-mocks.mjs` | **pass**: "no crash-prone jest.mock stand-ins found" |
| `npm run lint:bare-image` | **pass** |
| `npm run lint:avatar-icon-sizing` | **pass**: "0 pre-existing, allowlisted, ceiling 0" |
| `npm run test:avatar-icon-sizing-guard` | **pass**: 14 passed, 0 failed |
| `npm run lint:dev-proxy-not-shipped` | **pass**: 2393 shipped files scanned |

`package.json` also defines `check:all` (`bash scripts/run-all-checks.sh`); I ran
each of its nine constituents individually rather than the wrapper, and all nine
pass. No check I report here was invented — each is a script name in
`travel-buddy-standalone/package.json`.

Census integrity, run twice around the work:

```
cd artifacts/api-server
CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity | grep '^highlights-memories|'
```

266 rows both times, `diff` **identical** — 0 verdict cells moved, which is what
a lane that may not edit the census should produce.

### Failing-first, watched

`src/services/__tests__/memories.operationId.component.test.ts` was run against
the **pre-change** service (restored with `git show 561a0a7b0:…/memories.ts`):

```
Tests:       11 failed, 11 total
Test Suites: 1 failed, 1 total
```

Then against the implementation:

```
Tests:       11 passed, 11 total
Test Suites: 1 passed, 1 total
```

I watched RED and then green. The RED was partly a compile-level failure
(`_resetMemoryOperationIds is not a function`) rather than purely behavioural,
because the suite needs exports the old file does not have; saying so rather
than dressing it up.

### Per-suite, re-run after the last commit

| suite | result |
| --- | --- |
| `src/services/__tests__/memories.operationId.component.test.ts` | 11 passed, 11 total |
| `src/services/__tests__/highlights.sources.component.test.ts` | 12 passed, 12 total |
| `src/components/highlights/__tests__/HighlightSourcesDisclosure.component.test.tsx` | 7 passed, 7 total |
| `app/highlights/__tests__/archived.sources.component.test.tsx` + `archived.screen.component.test.tsx` | 12 passed, 12 total (6 of them the pre-existing suite, unmodified) |

No assertion was weakened and no test was deleted.

---

## 5. NEEDS FROM HM-API

### 5.1 The inverse of `HIDE_HIGHLIGHT`, if one is added

Built against the CURRENT contract: `POST /highlights/:id/archive` and
`DELETE /highlights/:id/archive`, both direct writes, mapped in
`src/services/highlights.ts` and surfaced on `HighlightViewer` (archive) and
`app/highlights/archived.tsx` (restore). If the inverse becomes a command, the
client needs **exactly this and nothing more**:

```
POST   /api/highlights/:id/unhide
       headers  Idempotency-Key: <1-200 chars, client-chosen>
       body     {}                          (no body fields; the subject is the path)
       200      { "id": "<uuid>",
                  "archivedAt": null,
                  "lifecycleState": "ACTIVE" | "EXPIRED",
                  "lifecycleProvenance": "stored" | "derived" }
       409      { "error": "conflict",  "message": "<a sentence a person can read>" }
       403      { "error": "feature_disabled", "message": "…" }   # kernel off / column absent
       404      { "error": "not_found", "message": "Highlight not found" }
       503      { "error": "degraded_unavailable", "retryable": true, "message": "…" }
```

Two requirements on it, both from what this lane had to work around:

1. **`lifecycleState` must come back with its `lifecycleProvenance`.** §5's
   machine says HIDDEN → EXPIRED is legal and HIDDEN → ACTIVE is not, so an
   unhide of a Highlight whose `expires_at` has passed lands on EXPIRED, not
   ACTIVE. The client cannot compute which without re-implementing
   `describeHighlightLifecycle`, and a client copy of that is the second
   vocabulary this codebase keeps refusing.
2. **Keep `DELETE /highlights/:id/archive` working** until the client is
   migrated, or the restore button on `app/highlights/archived.tsx` breaks.
   If it must go, say so and I will ship the swap in one commit.

### 5.2 `GET /highlights/archived` emits RAW rows

`artifacts/api-server/src/routes/highlights.ts:2182` is
`res.status(200).json({ highlights: (rows ?? []) as any[] })` — the raw
PostgREST rows, snake_case, **without** `describeLifetimeFields`. The other two
list reads call it (`:1103`, `:1353`). Consequence: on the archive screen
`pinnedAt` is always `undefined` even when `pinned_at` is populated, and no
class or lifecycle field is readable at all.

Needed: run the same shaping pass the profile read uses, so the response
carries `pinnedAt`, `lifetimeClass`, `lifetimeProvenance`, `lifecycleState`,
`lifecycleProvenance`. I deliberately did **not** read the snake_case columns
as a fallback: without `lifetimeProvenance` the client cannot tell a stored
class from an invalid one, and guessing is what this census exists to catch.

### 5.3 `GET /highlights/following-feed` likewise

Same omission at `artifacts/api-server/src/routes/highlights.ts:2582`. Until
both are shaped, §12's "pinned order always outranks automatic ordering" cannot
be rendered on three of the four surfaces even as a client-side sort, which is
part of H100's ceiling.

### 5.4 Nothing else

`GET /highlights/:id/sources`, `POST /highlights` with `sourceMemoryIds`,
`POST|DELETE /highlights/:id/pin`, `GET /highlights/lifetime-classes`,
`GET|PUT|DELETE /highlights/resurfacing-controls`,
`GET|PUT /highlights/:id/projection-policy` and `POST /memories/search` all
exist and all now have a client. I needed no new route for anything I built.

---

## 6. NOT DONE AND WHY

### (a) Needs a server route that does not exist

- **H102, H107, H108, H259** — the eight executable actions. There is no
  `do_again`, `take_me_back` or Memory-aware `add_to_trip` anywhere in
  `artifacts/`; the only textual hits are a metrics string that cites the
  absence. A client cannot be built against nothing, and inventing the verbs
  client-side would be the "Stories product wearing the spec's noun" the census
  names.
- **H80** — `memory_items` has no visibility column. There is no field to send.
- **H180** — cross-device convergence needs a server-side operation identity
  across devices. The operation id added in §3.1 is per-device and per-process
  by construction; presenting it as H180's answer would be false.
- **H265** — nothing summarizes a Memory, so there is no original voice to
  preserve through anything.

### (b) Needs another lane's file

- **Provenance in the Highlight viewer.** `HighlightSourcesDisclosure` belongs
  in `src/components/HighlightViewer.tsx` as well as on the archive screen —
  that is where most people meet a Highlight. `HighlightViewer.tsx` is not in
  this lane's ownership list. The component, its hook and its service call are
  all built and tested; wiring it is a two-line import plus one JSX block
  inside the `isOwner` branch that already hosts `HighlightPrivacySheet`
  (`:776-786`).
- **A §13 compression surface (H104, H105).** `GET /memories/graph` is served
  and has no client. A screen for it must be registered in
  `src/navigation/portavaRoutes.ts` or `check:route-registry` fails — and that
  file is shared navigation, explicitly forbidden here. I did not add an
  unregistered screen, because an unregistered screen is an NB by this census's
  own rule and would have broken a green check for nothing.
- **A conflict-reload affordance on the edit screen (H178).** The service now
  reports `kind: 'conflict'`; turning that into a "Reload and try again" button
  is four lines in `app/memory/edit.tsx`, which is `app/memory/**` and not
  `app/memories/**`. I read the ownership list strictly. The server's sentence
  does reach the user today through the existing `result.message` render at
  `:135`, so the flow is not silent — it just has no dedicated recovery action.

### (c) Needs an external credential / service / device

- **Every deployed claim.** `eas.json:10` points at `https://portava.replit.app`
  and that deployment may lag this branch. I made no live call and ran no
  build. Everything above is **implemented and tested; device and deployment
  acceptance pending.** In particular `fetchHighlightSources` is built against
  `GET /highlights/:id/sources` as it exists ON THIS BRANCH; if the deployed API
  predates that route the client will receive a 404 and render its `not_found`
  refusal, which is correct behaviour but is not the same as the route working.
- Nothing here needed a credential I lacked.

### (d) Out of scope

- **H21, H31, H17, H25, H182, H190** — schema and storage rows. No client
  change moves them.
- **H4, H79, H99, H101, H112, H258, H189** — server-side model, ranking and
  retrieval. I re-measured them and wrote what I found; I did not touch
  `artifacts/api-server/**`.
- **H130–H141** — the command boundary. All twelve rest on
  `memory_kernel_enabled` being false. That is a production flag, not a file.
- **H266** — a deterministic fallback renderer for AI presentation. There is no
  AI presentation of a Highlight or Memory on the client to fall back from, so
  building a fallback would be building the second half of a thing whose first
  half does not exist.

---

## 7. STALE EVIDENCE FOUND

Eleven rows whose **currently-parsed** evidence I re-tested and found false. In
every case the verdict still stands, for a reason I re-measured. Sources: the
20260922 production schema snapshot and
`artifacts/api-server/src/lib/capability/production-applied-migrations.json`,
both committed in this tree.

1. **H93** `:855` — *"`highlight_sources` … is migration 2722, written,
   **unapplied**, and has no TypeScript writer."* **Both clauses false.** 2722
   is in the applied list; the writer is
   `artifacts/api-server/src/services/highlights/highlightSources.ts#linkHighlightSources`,
   called from the create route, and `GET /highlights/:id/sources` reads it
   back. W stands because a sourceless create still succeeds.
2. **H100** `:816` — *"No pin column, no pin route, no pin in the client."*
   **Three clauses, three false.** `pinned_at` is in `/tables/highlights`;
   `POST|DELETE /highlights/:id/pin` are at `routes/highlights.ts:1463,1517`;
   the client is `src/features/highlights/lifetimeApi.ts:83,88` used by
   `HighlightViewer.tsx:367-380`. W stands for §M's reason at census `:5462`.
3. **H103** `:856` — *"migration 2339 … **not in the applied list**."* **False**,
   2339 is applied. The live blocker is the flag reading `false`.
4. **H75** `:808` — *"`highlight_projection_policies` is 2721, **unapplied**."*
   **False**, 2721 is applied and the table is in the snapshot.
5. **H187** `:819` — *"Storage unapplied (2720)."* **False**, 2720 is applied.
6. **H188** `:820` — *"Storage unapplied."* **False**, same.
7. **H130** `:1315` — *"No durable receipt (2710 unapplied)."* **False**, 2710
   is applied. The receipt is unreachable because the kernel flag is off, which
   is a different blocker with a different fix.
8. **H175** `:818` — *"The receipt table is 2710, **unapplied**."* **False**,
   same. Additionally, the clause that follows — that only a log line records
   the key — is now true for a key the CLIENT chose rather than one the server
   invented.
9. **H260** `:1474` — *"suppressing nothing because 2720 is unapplied."*
   **False**, 2720 is applied and the controls are settable and enforced on the
   live feeds. W stands on the half that was always true: no anniversary model,
   no fatigue model.
10. **H201** `:823` — *"unenforced until 2721 lands."* **False**, 2721 landed.
11. **H13** `:799` — *"Test-only; … 2730 is unapplied."* **Both false.**
    `POST /memories/search` is a served route with a real client that a person
    can reach (`app/memory/search.tsx`), and 2730 is applied.

Also: **H21** `:355` and **H31** `:1220` list nine missing `Highlight` fields.
Four of the nine — `highlight_type`, `lifetime_class`, `lifecycle_state`,
`renderer_version` — are now columns on `public.highlights` (20260922 snapshot,
`/tables/highlights`, 22 columns), and `source_memory_ids` is satisfied by the
separate `highlight_sources` table. Absent from `highlights`: `ranking_score`,
`reason_codes`, `audience_policy_id`, `presentation_json`. The verdicts do not
move; the count in the reason does.

A near-miss worth recording: I first read **H266** as `N` from the body at
`:1485` (*"No AI presentation exists"*). The tool's last statement is `:4349`,
which is **W** and says the opposite. Reading the body would have taken a W row
backwards to N. This is exactly the failure the coordinator's correction
describes, caught by running the dump.

---

## 8. Commits

```
a4c10f3ed  §19 client operation ids and a conflict the client can see (H175, H178)
85920c0a9  §12 provenance: a Highlight can say what it is built from (H93)
f97c358df  Test: §12 provenance at the service boundary (H93)
04bf8ca48  Carry §4 lifetime class and §5 lifecycle state through the client mapper
```

Pushed to `origin lane/hm-client`. **No merge, no PR.**
