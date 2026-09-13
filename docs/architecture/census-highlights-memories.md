# Census — Highlights / Memories Development Architecture Spec v1

**Spec under census:** `docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt`
(byte-compared against the `.docx`: the `.txt` is a faithful extraction — the only diff is a
leading blank line and a trailing newline, so the two agree and either may be read.)


> ## RE-CENSUS HEADER — 2026-09-08, measured at HEAD `cdfff599`
>
> The body below is unedited and describes `ebe72b34`. **Its headline is stale.**
> Section **A** at the end of this file re-measures every requirement whose
> verdict moved, against current HEAD, using the same denominator and the same
> rule.
>
> | Field | Value |
> | --- | --- |
> | `generated_at` | 2026-09-08 |
> | `head_commit` | `1ff810e2` — RE-DECLARED **2026-09-13 by section C**, which built §16's eight Compass Memory accessors, §14's fusion boundary and §23's publish predicate, and therefore RE-MEASURED this document rather than only re-pointing it. The value it replaces is `254e1876`, section B's. `check:census-freshness` reads the FIRST `head_commit` row in a file, so an appended section cannot re-declare it and this row is the only place the change can be made. **`1ff810e2` IS ALSO PRE-SQUASH**, so the owner follow-up section B.1 records — re-declare at the squash when this branch lands — is unchanged and still owed. Section B's own note follows, preserved verbatim. RE-DECLARED **2026-09-13 by section B**, which re-measured every row in this document against that commit; the value it replaced was `42aeac38`, and section A's own account of why `42aeac38` replaced `cdfff5995c92f7adfb3ae7880496bc94002717e9` is preserved verbatim below. **`254e1876` IS PRE-SQUASH and will become unreachable when this branch lands** — the same `CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI` failure section A records one paragraph down. Whoever merges must re-declare it to the squash commit, and section B.1 names that as an owner follow-up. The original note follows. RE-DECLARED 2026-09-10 from `cdfff5995c92f7adfb3ae7880496bc94002717e9`, the working-tree commit this census was measured at. It was necessary because `cdfff599` is PRE-SQUASH — this repository squash-merges, so it is an ancestor of nothing, is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). Reproduced 2026-09-10 in a fresh clone of this branch: `git diff cdfff599..HEAD` aborts with `Invalid revision range`, and the check reported this census as unreadable rather than checking it. `42aeac38` is #476's squash, where this document's content reached `main`. **This is a RE-DECLARATION, not a re-measurement.** FOUR counted files changed between `cdfff599` and `42aeac38`: `artifacts/api-server/src/lib/memoryOutbox.ts`, `.../services/memoryProjections/derivativeRegistry.ts`, `.../derivativeRegistryRead.ts`, and `.../services/memoryRetrieval/searchMemories.ts`. The move is defensible only because each was re-verified mechanically on 2026-09-10 over `cdfff599..42aeac38`: `memoryOutbox.ts` adds 48 lines of which ZERO survive a filter for lines that are neither comment nor blank; `searchMemories.ts` changes one import path and nothing else; the other two are a split whose exported-symbol set is IDENTICAL at both commits (18 exports, same names and signatures, diffed) and whose retained half differs by zero non-comment lines — the moved `readRegisteredPayload` no longer delegates to `readRegistration` but inlines that function's body verbatim, table, columns, filters, error mapping and all, because importing back would have closed an ESM cycle. The full per-file argument is preserved under `retired` in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, where it had been written as an acknowledgement. **Changed by the Trips lane, not this one**, because CI could not run this check against this census at all until it was; nothing else in this document is touched, and reverting it costs only the check. |
> | `methodology_version` | 2 — **"How I decided what counts" is unchanged and the denominator is still 266.** Buckets unchanged (`BAC` / `BBW` / `NB` / `CV`), including rule 7 for prohibitions. Only verdicts moved, each citing a `file:line` opened at this commit. |
> | Scanned | `artifacts/api-server/src/lib/memoryCommandBus.ts` (760 lines), `src/lib/memoryOutbox.ts`, `src/lib/highlightPermissions.ts`, `src/services/memory/MemoryDomainService.ts`, `src/services/memoryProjections/` (6 files), `src/services/memoryRetrieval/searchMemories.ts`, `src/services/highlights/` (6 files), `src/routes/memories.ts`, `src/routes/highlights.ts`, migrations `2710`, `2711`, `2720`–`2724`, `2730`, and `src/lib/deletionDispositions.ts` |
> | Production state | From the repository's own committed artifacts, not a live query: `src/lib/capability/snapshots/20260908-production-schema.json` (watermark `20260908133347`) and `src/lib/capability/production-applied-migrations.json`. |
>
> ### Headline, side by side
>
> | Figure | Body (`ebe72b34`) | **Now (`cdfff599`)** |
> | --- | ---: | ---: |
> | Denominator | 266 | **266** |
> | BUILT-AND-CORRECT | 17 | **16** |
> | BUILT-BUT-WRONG | 59 | **123** |
> | NOT-BUILT | 188 | **125** |
> | CANNOT-VERIFY | 2 | **2** |
> | CONSTRUCTED% | 28.6 % | **52.3 %** (139 / 266 = 52.3 %) |
> | CORRECT%, raw | 6.4 % | **6.0 %** (16 / 266 = 6.0 %) |
> | CORRECT%, spec-attributable | 0.0 % | **0.0 %** |
>
> ### The three numbers, each said plainly
>
> **CONSTRUCTED nearly doubled. CORRECT went DOWN. Spec-attributable CORRECT is
> still zero.** Those are not in tension; together they are the whole finding.
>
> 1. **63 requirements moved `NB → BBW`** because a large, careful,
>    *explicitly spec-attributable* body of code landed: a command bus with
>    idempotency keys and a §5 lifecycle machine, a transactional outbox
>    contract, evidence normalization, episode detection, significance,
>    a memory graph, retrieval with namespace isolation, a projection registry,
>    a derivative registry, and five Highlights services. Unlike anything the
>    body found, these files **cite this specification by path and section in
>    their headers**.
> 2. **Not one of them satisfies a requirement end-to-end, because every
>    migration they need is written and NOT APPLIED.** `2710`, `2711`, `2720`,
>    `2721`, `2722`, `2723`, `2724` and `2730` appear in none of the 35 entries
>    of `production-applied-migrations.json`, and none of their tables appears in
>    the production schema snapshot. `memory_kernel_enabled` therefore has **no
>    row**, and `lib/featureFlags.isFlagEnabled` is fail-closed, so every write in
>    `routes/memories.ts` is the direct write it has always been. That is scored
>    strictly: **code built, storage unapplied ⇒ BBW, never BAC.**
> 3. **CORRECT fell by one because this pass found a false green in the body**
>    — H84, below.
>
> ### The false green: H84
>
> H84 ("Blocking and account deletion suppress future social resurfacing and
> unlink identity") was **BAC**, citing `lib/deletionDispositions.ts:152, 192,
> 352` as proof that deletion "reaches … every highlight table". Line 152 is
> genuine — `memories`, `memory_likes` and `memory_saves` are in
> **`ERASED_BY_CASCADE`** (`src/lib/deletionDispositions.ts:46`). Line 352 is not.
> `highlights`, `highlight_likes`, `highlight_reports` and `highlight_views` are
> in **`UNCLASSIFIED_BACKLOG`** (`:270`, entries `:366-369`) and `highlight_replies`
> is in `DENOMINATOR_CORRECTION_BACKLOG` (`:544`, entry `:569`). That file's own
> header says what those lists mean: *"UNCLASSIFIED_BACKLOG — NOT a decision …
> the data survives deletion and no one has said whether it should"* (`:35-38`).
> `AccountDeletionService.ts:100-104` says the same in its own words. **No
> highlight row is erased by account deletion.** H84 → **BBW**: the blocking half
> is still correct and fail-closed; the deletion half was never true. Emptying
> that backlog is owner decision **D6** and this census does not close it.
>
> The layover census made the identical miscitation from the identical file at
> L163 — see `census-layover.md` §9.
>

**Codebase censused:** branch `claude/portava-continuation-uqta94` at `ebe72b34`.
PRs **#470** (migration 2320) and **#461** (migration 2313) are **not merged into this branch**
and are therefore **not** counted as built. Both are read and reported separately below.

**Method note on section count.** The census brief said "79 numbered top-level sections". That is
wrong. The spec has **29** numbered top-level sections (§1–§29) plus Appendix A and Appendix B.
Both the `.txt` and the `.docx` agree. The denominator below is built from requirements, not
sections, so nothing turns on this — but the figure should be corrected wherever it is repeated.

---

## Headline numbers

| Figure | Value |
|---|---|
| **Denominator (testable requirements)** | **266** |
| BUILT-AND-CORRECT | **17** |
| BUILT-BUT-WRONG | **59** |
| NOT-BUILT | **188** |
| CANNOT-VERIFY | **2** |
| **CONSTRUCTED%** (BAC + BBW ÷ 266) | **28.6%** |
| **CORRECT%, raw** (BAC ÷ 266) | **6.4%** |
| **CORRECT%, spec-attributable** | **0.0%** (0 of 17) |

**The single most important number is the last one.** Every one of the 17 BUILT-AND-CORRECT
verdicts is satisfied by code written for a *different* spec — the Memories scrapbook (migration
`0067`), Passport, Media v2 (§33), the "Memory + Experience Intelligence Architecture" projection
family (migrations 2183–2214), or account-deletion hardening. Not one file cites this spec. The
spec entered the repository on **2026-09-07**; every file cited below predates it. **Nothing in
this repository has been built for the Highlights/Memories spec.**

---

## How I decided what counts as a testable requirement

The spec mixes narrative, diagrams, artifact lists and rules. I applied one rule, stated here so
another censor can reproduce the denominator:

1. **Each named artifact in a spec table or list is one requirement.** A storage table, a bounded
   service, an enum, a command, a domain event, a Compass tool, a projection, an observability
   metric, a delivery phase, a certification fixture, a named user control, a named policy
   function. These are independently checkable ("does `memory_relations` exist and do what §3.6
   says").
2. **Each bullet asserting a required property or prohibition is one requirement.** ("Automatic
   Memories default PRIVATE.")
3. **Vocabulary values inside an artifact are part of that artifact**, not separate requirements.
   The 7 values of `MemoryLifecycleState` are one requirement, not seven; the 10 candidate reason
   codes are one registry, not ten.
4. **Narrative, ASCII diagrams that only restate adjacent prose, worked examples and Appendix A are
   not requirements.** Appendix B's 9 migration filenames restate §3.6's tables and are not
   double-counted.
5. **Duplicates are counted once, at first occurrence.** §28 (18 developer rules) and §29 (14
   Definition-of-Done bullets) are almost entirely restatements of §1–§25; only **5** of §28's
   rules assert something not already counted, and **0** of §29's do. §27 (internal service
   interfaces) restates §2's services and §17's commands and contributes **0**.
6. **Non-goals (§1) are excluded** — "do not build an Instagram Stories clone" is a scope
   statement, not a checkable requirement. (It is nonetheless worth reading §12 below.)
7. **Prohibitions are graded on the surface where a violation would live.** If I read that surface
   and no violating path exists, the prohibition is BUILT-AND-CORRECT (usually incidental,
   attribution `—`). If I did not read a definitive surface, it is NOT-BUILT, not assumed-satisfied.

### Denominator by section

| § | Requirements | § | Requirements |
|---|---|---|---|
| 1 Mandate | 5 | 16 Compass contract | 15 |
| 2 Domain boundaries | 11 | 17 Command bus + events | 33 |
| 3 Data model (5 contracts + 16 tables) | 21 | 18 Projections + registry | 12 |
| 4 Enums + truth semantics | 12 | 19 Offline / multi-device | 6 |
| 5 State machines | 4 | 20 Media pipeline | 5 |
| 6 Evidence + eligibility | 4 | 21 Deletion / revocation | 8 |
| 7 Episode detection | 5 | 22 Migration | 4 |
| 8 Significance | 5 | 23 Authorization + RLS | 13 |
| 9 Entity resolution | 7 | 24 Observability | 13 |
| 10 Privacy + projection policy | 11 | 25 Replay / testing / certification | 30 |
| 11 Sensitive context | 7 | 26 Delivery phases | 8 |
| 12 Highlights architecture | 11 | 27 Service interfaces | 0 (restatement) |
| 13 Memory graph | 3 | 28 Developer invariants | 5 (13 are restatements) |
| 14 Executable memories | 3 | 29 Definition of Done | 0 (restatement) |
| 15 Retrieval | 5 | **Total** | **266** |

### Method warnings inherited

- **`from("table")` grep is incomplete.** The repo's own `src/scripts/checkWriterlessReads.ts`
  declares that dynamic `.from(expr)` makes writer attribution INCOMPLETE and that it errs toward
  silence. Every table-writer claim below was checked through **both** TypeScript `.from(...)` and
  SQL function bodies reached by `.rpc(...)`. `memory_events` and `memory_projections` have **no**
  TypeScript writer at all — they are written only inside `project_user_memory` /
  `record_intent_memory` (SQL), reached via `db.rpc("project_all_memory")` at
  `artifacts/api-server/src/lib/memoryProjectionScheduler.ts:51`. A grep-only census would call
  them unreferenced. They are not.
- **"A table exists" is not "the requirement is met."** A table nothing writes satisfies nothing.
  This is applied literally below: `memory_episodes` and `memory_evidence` (PR #470) are inert **by
  design** — RLS on with no policy, service_role-only grants, no reader, no writer, no route.
- **No database was queried.** Production facts come from the ground truth supplied with the brief.

---

## Resolving the "16 storage tables, 13 absent" claim

Commit `a155fa16` asserts the census "found 13 of the spec's 16 storage tables absent". Here is my
own count of §3.6, table by table.

| # | Spec table (§3.6) | Present in production? | Verdict |
|---|---|---|---|
| 1 | `memories` | **Yes** | Name collision. `docs/migrations/0067_memories.sql:7` — a user-authored media album (title/caption/visibility/allowed_user_ids, slides in `memory_items`). Has **none** of `occurred_at`, `memory_type`, `lifecycle_state`, `source_mode`, `significance_score`, `confidence_band`, `location_precision`, `current_version`. |
| 2 | `memory_episodes` | **No** | Exists only in unmerged PR #470 (`git show pr/470:artifacts/api-server/src/migrations/2320_memory_episode_provenance_spine.sql:102`), applied to portava-ci only. |
| 3 | `memory_evidence` | **No** | Same PR, `:227`. |
| 4 | `memory_media_links` | **Substitute only** | No table of this name. `media_attachments` (`artifacts/api-server/src/lib/mediaAssets.ts:346`, entity types at `:369` include `"memory"`) is a genuine M:N media↔entity link — but it is written **only** by `PassportMemoryService.ts:137` for `passport_memories`. The `memories` album's media is `memory_items` (1:N, a raw client-supplied `media_url`, no `media_assets` row). |
| 5 | `memory_entity_links` | **No** | `memories` carries scalar `trip_id`/`event_id`/`place_id`; `memory_tags` is people-only. |
| 6 | `memory_relations` | **No** | Zero occurrences in any `.sql` in the repo. |
| 7 | `memory_corrections` | **No** | Nearest is `memory_feedback.corrected_value` (`2213_memory_passport_controls.sql:72`), on derived preferences. |
| 8 | `memory_commands` | **No** | Zero occurrences. |
| 9 | `memory_event_outbox` | **No** | Zero occurrences. The only outbox in the repo is the trip-reminder two-phase outbox (`server/trips/projectionWorkers/tripReminderScheduler.ts:9`). |
| 10 | `highlights` | **Yes** | Name collision. `artifacts/api-server/src/migrations/0026_highlights.sql:8` — an ephemeral Stories-style media post. Has **none** of `source_memory_ids`, `highlight_type`, `lifetime_class`, `lifecycle_state`, `ranking_score`, `reason_codes`, `audience_policy_id`, `presentation_json`, `renderer_version`. |
| 11 | `highlight_sources` | **No** | `stories.saved_to_highlight_id` (`routes/stories.ts:633`) is a 1:1 back-pointer from a Story, not a link to Memories/Episodes. |
| 12 | `memory_visibility_policies` | **No** | Visibility is a scalar column on `memories`/`highlights`; there is no policy row. |
| 13 | `memory_derivative_registry` | **No** | Zero occurrences. |
| 14 | `memory_snapshots` | **No** | Zero occurrences. |
| 15 | `memory_resurfacing_preferences` | **No** | Nearest is `memory_feedback` (`2183_memory_projection_contract.sql:133`), different vocabulary, different domain. |
| 16 | `memory_import_batches` | **No** | Zero occurrences. |

### My verdict on the claim

**Substantially correct, off by one in the conservative direction, and understated in substance.**

- Tables **absent by name from production: 14 of 16.** The claim said 13. The reconstruction that
  yields 13 is counting `memories`, `highlights` and a `memory_media_links` substitute
  (`media_attachments`) as present. That is a defensible reading, and it is the one I would also
  accept if forced to a single number — so I do **not** call the claim wrong. I do call it imprecise:
  it never says which 3 it counted.
- The number that actually matters is different and worse. **Tables that both exist AND do what
  §3.6 says: zero.** `memories` and `highlights` are name collisions with divergent schemas — and
  migration `2183_memory_projection_contract.sql:24-30` says so out loud, refusing the name
  `memory_item` precisely because "`public.memory_items` already exists as the media-slide table of
  the user-facing 'Memories' scrapbook. Reusing that name would collide two unrelated concepts."
  The substitute for `memory_media_links` points at the wrong table.
- **Five tables carry "memory" in the name and none is an episode**, exactly as the ground truth
  states: `memories` (album), `memory_items` (slides), `passport_memories` (suggestion feed),
  `memory_events` (append-only point-action ledger, `2183:64`), `memory_projections` (standing
  belief, `2183:93`). A sixth, `compass_memories`, is a chat store. None of these six belongs to
  this spec; migrations 2183–2214 identify themselves as serving the **"Memory + Experience
  Intelligence Architecture"**, a different document.

---

## Agreement with CONSTRUCTED 26.4% / CORRECT 1.1%

- **CONSTRUCTED: I broadly agree.** I measure **28.6%** against a denominator of 266. Landing
  within ~2 points of an independently-derived figure is about as much agreement as two
  requirement enumerations can produce. Neither number is reproducible without publishing the
  requirement list; that is why mine is published in full below.
- **CORRECT: I disagree, in both directions.**
  - **Raw CORRECT is higher than claimed: 6.4%, not 1.1%.** The repo has more genuinely-correct
    memory-adjacent behaviour than 1.1% admits — fail-closed block filtering
    (`routes/memories.ts:263-279`), a real tag-consent model that refuses co-ownership
    (`routes/memories.ts:669-711`), a media-delete path that removes the storage object while the
    Memory survives (`routes/memories.ts:589-617`), a genuine private-by-default suggestion
    pipeline (`services/passport/PassportMemoryService.ts:73`, accepted at `:150`), and an
    account-deletion sweep that reaches every memory and highlight table
    (`lib/deletionDispositions.ts:152,192,352`). Calling that 1.1% undersells the repository.
  - **Spec-attributable CORRECT is lower than claimed: 0.0%, not 1.1%.** Every one of those 17 is
    pre-existing work for another spec. If the 1.1% was meant as "built for this spec", it should
    be zero.
- **The claim I would replace both with:** *nothing in this repository was built for the
  Highlights/Memories spec; roughly a quarter of its requirements have a namesake artifact, and
  none of those namesakes is the spec's object.*

---

## Requirement-by-requirement

Buckets: **BAC** = built and correct · **BBW** = built but wrong · **NB** = not built ·
**CV** = cannot verify. Attribution column: **pre** = pre-existing work for another spec that
happens to satisfy this one; **—** = incidentally satisfied, no artifact was built; **spec** = built
for this spec (there are none).

### §1 Architectural mandate (5)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H1 | Canonical Memory facts independent of viewer layout and AI narrative | NB | `memories` rows are read and serialized straight to the client (`routes/memories.ts:1108`); there is no fact layer beneath a projection | |
| H2 | Automatic Memories private-first; publishing always a separate projection decision | BBW | `routes/stories.ts:585-620` — "save to Highlight" hard-codes `visibility: "public"` regardless of the source Story's audience (close-friends, allow-lists). Publishing is not a decision; it is a side effect | pre |
| H3 | AI may summarize supported evidence but may not manufacture historical facts | NB | No AI path over Memories exists; no guard exists either | |
| H4 | Planned/saved/nearby never represented as "experienced" without occurrence evidence or user confirmation | **BAC** | `routes/geofence.ts:809-861` (a stamp requires an actual check-in, then only a *suggested* memory) and `routes/location.ts:392-432` (GPS city stamp → *suggested* memory). Suggestions are inert until explicit acceptance (`services/passport/PassportMemoryService.ts:150`). Matches §6's "GPS proximity: weak alone; typically candidate-level only" | pre |
| H5 | Historical truth and current-world truth are separate | NB | No mechanism encodes the boundary; §14's fusion path does not exist | |

### §2 Bounded services (11)

| id | Service | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H6 | MemoryDomainService | BBW | `routes/memories.ts` is a CRUD router: no lifecycle guard, no versioning, no merge/split, no audit | pre |
| H7 | MemoryEvidenceService | NB | | |
| H8 | EpisodeDetectionService | NB | | |
| H9 | MemoryEligibilityService | NB | | |
| H10 | MemoryPrivacyService | BBW | `routes/memories.ts:123` `canViewMemory` and `lib/highlightPermissions.ts:37` `canViewHighlight` are per-route read helpers; no audience/precision/resurfacing/personalization/publication policy service | pre |
| H11 | MemoryProjectionService | BBW | `2186_memory_projector_taxonomy.sql:32` `project_user_memory` is a real projector — of derived *preferences* from the Compass graph, not read models over Memories | pre |
| H12 | HighlightService | NB | `routes/highlights.ts` only; no build/rank/publish service | |
| H13 | MemorySearchService | NB | | |
| H14 | MemoryNarrativeService | NB | | |
| H15 | MemoryResurfacingService | BBW | `compass/MemoryRecapsService.ts` is a genuine resurfacing service with a fail-closed eligibility gate — over derived preferences and Passport artefacts, not Memories; ships behind the `memory_recaps` flag seeded **off** (`2214_memory_recaps.sql:57`) | pre |
| H16 | MemoryActionService | NB | | |

### §3.1–3.5 Canonical contracts (5)

| id | Contract | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H17 | `Memory` record | BBW | `docs/migrations/0067_memories.sql:7`. Missing `occurred_at`, `ended_at`, `occurred_timezone`, `memory_type`, `lifecycle_state`, `source_mode`, `significance_score`, `confidence_band`, `location_precision`, `current_version` — 10 of 17 fields | pre |
| H18 | `MemoryEpisode` | NB | Unmerged PR #470 only | |
| H19 | `MemoryEvidence` | NB | Unmerged PR #470 only | |
| H20 | `MemoryRelation` | NB | | |
| H21 | `Highlight` record | BBW | `0026_highlights.sql:8`. Missing `source_memory_ids`, `highlight_type`, `lifetime_class`, `lifecycle_state`, `ranking_score`, `reason_codes`, `audience_policy_id`, `presentation_json`, `renderer_version` — 9 of 13 fields | pre |

### §3.6 Storage tables (16)

Verdicts as tabulated in the 16-table section above: `memories` (H22) BBW, `memory_media_links`
(H25) BBW, `highlights` (H31) BBW; H23, H24, H26–H30, H32–H37 **NB** (13).

### §4 Enums and truth semantics (12)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H38 | `MemoryLifecycleState` | BBW | `0067_memories.sql:22` — `draft/published/archived/deleted/removed`. No `CANDIDATE`, `CONFIRMED`, `MERGED`, `REJECTED` | pre |
| H39 | `MemorySourceMode` | NB | No source-mode column anywhere | |
| H40 | `MemoryType` | NB | `memory_projections.memory_type` (`2183:99`) is `episodic/semantic/social/place/intent` — a different taxonomy for a different object | |
| H41 | `TruthLevel` | BBW | `passport_memories.verification_level` (`PassportMemoryService.ts:74`, values `unverified/gps/checkin/verified`) is a verification ladder, not `USER_ASSERTED/SYSTEM_OBSERVED/MUTUALLY_CONFIRMED/INFERRED/UNKNOWN` | pre |
| H42 | `ConfidenceBand` | NB | `memory_projections.confidence` is a real in [0,1]; no banding | |
| H43 | `VisibilityClass` | BBW | `0067_memories.sql:13` — `public/friends_only/trip_crew/circle_only/only_me/custom`. `friends_only` is **mutual follow** (`routes/memories.ts:155-166`), not the spec's `FOLLOWERS` | pre |
| H44 | `LocationPrecision` | BBW | A precise 6-rung ladder exists — `lib/mediaLocationVisibility.ts:41` `hidden/country/city/neighborhood/place/precise_private` — but it lives on `media_assets`, is not stored per Memory, and is not owner-selectable on a Memory | pre |
| H45 | `MemoryRelationType` | NB | | |
| H46 | `HighlightLifetime` | NB | `highlights` has only `expires_at`; the composer passes `expiresInHours` (`routes/highlights.ts:140`) | |
| H47 | Truth precedence ordering (correction > assertion > mutual > observation > inference > unknown) | NB | No precedence encoded | |
| H48 | Lower-confidence inference may never overwrite a user correction | BBW | Genuinely implemented — `2213_memory_passport_controls.sql:164-176`, a suppression matched on the durable subject key so it survives re-projection — but it guards `memory_projections`, not Memory facts. `routes/memories.ts` has no correction concept at all | pre |
| H49 | Negative constraints from corrections must be durable | BBW | Same artifact, same scope limit | pre |

### §5 State machines and lifecycle (4)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H50 | Memory lifecycle machine | BBW | `routes/memories.ts:244` accepts any of `draft/published/archived` on PATCH with no transition guard; `:672` writes `state:"deleted"` directly | pre |
| H51 | Highlight lifecycle machine | BBW | `lib/highlightPermissions.ts:18` derives active/expired from `expires_at`+`deleted_at`; no `DRAFT`, no `PINNED`, no `HIDDEN`, no machine | pre |
| H52 | Deletion lifecycle (`DELETION_REQUESTED → PUBLIC_REVOKED → DERIVATIVES_PURGED → RAW_EVIDENCE_PURGED → DELETED`) | NB | Delete is a single soft-delete write | |
| H53 | Shared-experience anchor + participant consent | NB | `memory_tags` grants no ownership and creates no shared object | |

### §6 Evidence normalization and eligibility (4)
H54 normalization pipeline · H55 eligibility gate · H56 rejection-reason registry ·
H57 evidence-source strength model — **all NOT-BUILT.** Nothing normalizes a signal into evidence;
`memory_events.source` (`2183:71`, `explicit/system/inferred/live`) is the nearest vocabulary and
belongs to the projection family.

### §7 Episode detection (5)
H58 deterministic replayable grouping · H59 boundary features · H60 midnight must not force a split ·
H61 versioned candidate reason-code registry · H62 dedup relationships — **all NOT-BUILT.** No
detector exists in this branch. PR #470 lays a `detection_reason` CHECK and `detector_version`
column but ships no detector.

### §8 Significance (5)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H63 | Significance scoring from the listed inputs | NB | | |
| H64 | Significance internal, never a public social score | NB | Requirement presupposes a score; none exists | |
| H65 | Media quality must not dominate significance | NB | Same | |
| H66 | Explicit user intent outranks inferred significance; never demote a user-created Memory | NB | Same | |
| H67 | AUTO_PRIVATE / SUGGESTED / NO_CANDIDATE thresholds | BBW | `passport_memories` has `suggested → active` on explicit acceptance (`PassportMemoryService.ts:150`) but no threshold policy and no AUTO_PRIVATE tier — everything automatic is a suggestion | pre |

### §9 Entity resolution and historical identity (7)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H68 | `MemoryPlaceRef` (canonical id + occurrence-time display context) | BBW | `0148_memories_location.sql` adds `canonical_location_id` + `place_id` + city/country/lat/lng. No `display_name_at_occurrence`, no `location_at_occurrence`, no `resolution_confidence`, no `unresolved_place_ref` | pre |
| H69 | Unknown is valid; do not fabricate a place ID | **BAC** | `routes/memories.ts:365-370` writes exactly what the client sent, nulls included; every place field is nullable (`0148_memories_location.sql`). Nothing invents an id | — |
| H70 | Place closure does not invalidate a historical visit | NB | | |
| H71 | Entity merges repoint canonical identity, preserving occurrence-time display text | NB | | |
| H72 | Entity splits trigger re-resolution from retained evidence | NB | | |
| H73 | User correction beats automatic entity resolution | NB | No automatic resolution to beat | |
| H74 | Do not infer identity from name similarity | NB | | |

### §10 Privacy, consent and projection policy (11)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H75 | 5 consent dimensions (STORE/RESURFACE/PERSONALIZE/SHARE/CONTRIBUTE_TO_AGGREGATE_INTEL) | NB | | |
| H76 | Location precision ladder | BBW | Ladder at `lib/mediaLocationVisibility.ts:41`; applied to Memory reads only as a **Hidden-Gem ceiling** (`routes/memories.ts:87-107`), never as an owner-selected precision | pre |
| H77 | Person visibility ladder (NAMED → PROFILE_LINKED → CREW_ONLY → ANONYMOUS_COUNT → HIDDEN) | BBW | `lib/publicIdentity.ts:1-18` implements 2 of the 5 rungs (name vs @handle, opt-in, fail-closed), used at `routes/memories.ts:325-333`. No CREW_ONLY, ANONYMOUS_COUNT or HIDDEN | pre |
| H78 | Automatic Memories default PRIVATE | **BAC** | `services/passport/PassportMemoryService.ts:73` — `visibility: "private", // suggested memories are always private initially` | pre |
| H79 | Public search queries only public derivatives, never private canonical storage plus post-query filtering | BBW | `routes/memories.ts:237-279` — the discovery feed reads canonical `memories` through the **service client** (RLS bypassed), applies `.limit()` **before** block filtering, then post-filters blocks in TypeScript. This is precisely the pattern §10 and §28.6 forbid | pre |
| H80 | Media visibility independent from Memory visibility | NB | `memory_items` has no visibility of its own; it inherits the memory's | |
| H81 | Publishing location must never exceed the owner's selected precision | NB | There is no owner-selected precision on a Memory; the only clamp is the gem ceiling | |
| H82 | Temporary operational location must not leak into durable public Highlights | NB | `routes/highlights.ts:141-148` persists `location_name`/`city`/`country` verbatim with no precision control and no TTL distinct from the media's | |
| H83 | Being tagged or referenced does not make another user a co-owner | **BAC** | `routes/memories.ts:669-711` — a tagged user may only approve/remove **their own** tag (`userId !== user.id → 403`); no edit, no visibility, no delete rights accrue. Owner-only checks at `:606-608`, `:665-670` | pre |
| H84 | Blocking and account deletion suppress future social resurfacing and unlink identity | **BAC** | Memories feed fails **closed** on a block-lookup error rather than serving an unfiltered feed (`routes/memories.ts:263-279`); highlights filter both directions (`routes/highlights.ts:872-880`, `:38-49`); deletion reaches `memories`/`memory_likes`/`memory_saves` (`lib/deletionDispositions.ts:152`), the derived family (`:192`) and every highlight table (`:352`), executed at `services/accountDeletion/AccountDeletionService.ts:964-975` | pre |
| H85 | Public sharing assumes copyability; screenshot prevention is not a privacy boundary | **BAC** | No screenshot-prevention code exists anywhere in `travel-buddy-standalone/src` or `app/` — no `ScreenCapture`, no `FLAG_SECURE`. The stance is respected by construction | — |

### §11 Sensitive context and resurfacing controls (7)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H86 | Deterministic, reviewable sensitive-context registry (hotels, residences, medical, embassies, nightlife, religious/intimate, keep-private-forever) | NB | A registry exists — `lib/protectedLocations.ts:81` (`private_residence/medical_facility/shelter/sensitive_government/policy_defined`, table `2217_protected_locations.sql` shipping deliberately empty) — but it is the **Map** spec's §24 gate and is wired only into `routes/mapProjection.ts` and `lib/locateFriendsSession.ts`. Neither `memories` nor `highlights` consults it | |
| H87 | `DO_NOT_RESURFACE` | BBW | `memory_feedback` kinds `hide`/`forget` (`2183:139`) suppress resurfacing — of projections, not Memories | pre |
| H88 | `DO_NOT_INCLUDE_IN_RECAPS` | BBW | `compass/MemoryRecapsService.ts` reuses the same suppression set; there is no recap-specific control | pre |
| H89 | `HIDE_PERSON_FROM_RESURFACING` | NB | | |
| H90 | `HIDE_TRIP` | NB | | |
| H91 | `KEEP_PRIVATE_FOREVER` | NB | | |
| H92 | `RETAIN_BUT_DO_NOT_PERSONALIZE` | NB | `memory_projections.state='hidden'` hides *and* de-personalizes; the two are not separable | |

### §12 Highlights architecture (11)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H93 | Highlights are disposable audience-specific projections over Memories/Episodes | BBW | `routes/highlights.ts:116-171` inserts an independent row from a client-supplied `mediaUrl`. A Highlight has no source Memory and cannot be rebuilt from one. This is a Stories product — §1's stated non-goal — wearing the spec's noun | pre |
| H94 | `LIVE` class | NB | | |
| H95 | `DAY` class | NB | Only a free `expiresInHours` knob (`routes/highlights.ts:140`) | |
| H96 | `TRIP` class | NB | `0026_highlights.sql:12` had a `trip_id`; it is absent from the live column set the routes select | |
| H97 | `SEASONAL` class | NB | | |
| H98 | `PERMANENT` class | NB | Unmerged PR #461 only — and its committed migration is broken (see below) | |
| H99 | Ranking (`manual_pin + recency + significance + current_relevance + audience_relevance + presentation_quality + diversity`) | NB | `routes/highlights.ts:893` orders by `created_at` ascending. No score exists | |
| H100 | Pinned/manual order outranks automatic ordering | NB | No pin exists in schema, route or client | |
| H101 | Diversity constraints across trip/person/venue/activity | NB | | |
| H102 | Actions: DO THIS / SAVE / ADD TO TRIP / VIEW PLACE / ASK / MEET | NB | The viewer offers like (`:532`), reply (`:661`), report (`:801`) — the engagement verbs of a Stories product, not the action verbs of an executable Highlight | |
| H103 | Highlights remain finite and contextual; not an endless feed | BBW | `routes/highlights.ts:887-894` has **no `.limit()` and no pagination** — it returns every unexpired highlight of every followed user. Finiteness rests entirely on the 24h expiry; for a high-follow account the response is unbounded | pre |

### §13 Memory graph and compression (3)
H104 compression hierarchy (SIGNAL→MOMENT→EPISODE→DAY→TRIP→SEASON→LIFE CHAPTER) ·
H105 Life Chapters as projections, not duplicated Memories · H106 relationship edge types —
**all NOT-BUILT.** The nearest artifact is `services/media/MediaProjectionService.ts:765`, a
category strip ("Hidden Gems") over media, which is neither a chapter nor a projection over a
Memory graph.

### §14 Executable memories (3)
H107 Do-again compiled through current-world/Temporal-Freedom engines · H108 the 8 actions ·
H109 historical/current fusion invariant — **all NOT-BUILT.** Grep for `doAgain`, `do_again`,
`takeMeBack`, `take_me_back` across the repo returns nothing outside test fixtures.

### §15 Retrieval (5)
H110 `searchMemories(...)` signature · H111 graph + deterministic index before semantic ·
H112 ranking dimensions · H113 hard namespace isolation (private / shared-crew / public) ·
H114 privacy changes revoke searchable derivatives and embeddings — **all NOT-BUILT.** There is no
Memory search of any kind, and no embedding of any kind anywhere in the repo (the only two hits for
"embedding" are a comment in `lib/portavaRank.ts:24` and an XML-escaping helper).

### §16 Compass contract (15)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H115–H122 | `getMemory`, `searchMemories`, `getSharedMemories`, `getPlaceHistory`, `getTripMemories`, `getMemoryEvidence`, `createMemoryDraft`, `suggestMemoryCorrection` | NB ×8 | `compass/CompassTools.ts:109-484` defines 11 tools: `get_user_profile`, `get_current_trip`, `search_places`, `search_events`, `get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`, `get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`. **None** is memory-facing | |
| H123–H128 | LLM boundary: may summarize supported evidence · may propose merge/split/correction · may ask a minimal clarifying question · may not invent states/participants/identity/attendance/outcomes · may not bypass privacy policy · may not use stale history as current truth | NB ×6 | No memory-facing LLM path exists to constrain; no boundary is encoded. (`2221_compass_ai_writing_default_off.sql` is the adjacent posture, for Compass prose generally) | |
| H129 | Compass must not mutate canonical Memory facts through prose | **BAC** | The tool set at `compass/CompassTools.ts:109` contains no Memory mutation; the only write-shaped tool is `add_to_trip` (`compass/CompassTools.ts:421`). `routes/compass.ts:2226` `forgetMemory` writes `compass_memories` (a chat store), not `memories` | — |

### §17 Command bus and domain events (33)

**Commands (17).** Eleven of the seventeen operations exist as ad-hoc REST writes with **no command
boundary, no idempotency key, no audit row and no outbox insert** — the requirement is the boundary,
not the verb, so each is BBW:

`CREATE_MEMORY` (`routes/memories.ts:340`) · `ARCHIVE_MEMORY` (`:244` + `:624`) ·
`DELETE_MEMORY` (`:642`, soft) · `CHANGE_VISIBILITY` (`:613`) · `ADD_MEDIA` (`:681`) ·
`REMOVE_MEDIA` (`:727`) · `ADD_PERSON` (`:392`) · `REMOVE_PERSON` (`:838` — and only the *tagged*
user may remove; the owner cannot) · `CHANGE_PLACE` (`:616`) ·
`PUBLISH_HIGHLIGHT` (`routes/stories.ts:609`, forced public) · `HIDE_HIGHLIGHT`
(`routes/highlights.ts:466`, a soft delete, not a reversible hide) — **11 BBW**.

`CONFIRM_MEMORY`, `MERGE_MEMORY`, `SPLIT_MEMORY`, `PIN_HIGHLIGHT`, `UNPIN_HIGHLIGHT`,
`SET_RESURFACING_POLICY` — **6 NB**.

**Domain events (14).** `memory.created/confirmed/corrected/merged/split/archived/deleted/
visibility_changed`, `highlight.created/published/expired/pinned/hidden` — **all 14 NB.** No event
is emitted by any Memory or Highlight write path.

**H(outbox)** transactional outbox: canonical mutation + outbox insert in one transaction — **NB.**
Zero occurrences of `memory_event_outbox`. **H(idempotent consumers)** — **NB**; there are no
consumers.

### §18 Projections and derived-artifact registry (12)

| Projection | Bucket | Evidence / divergence | Attr |
|---|---|---|---|
| MemoryTimelineProjection | BBW | `travel-buddy-standalone/src/lib/memoryTimeline.ts:1-13` — a pure **client-side** month grouping over `passport_memories`, declaring itself Passport §15. Not a server projection, not over Memories | pre |
| PassportMemoryProjection | BBW | `services/passport/PassportConsumerProjections.ts` projects Passport artefacts, not Memories | pre |
| ProfileHighlightProjection | BBW | `routes/highlights.ts:181` returns raw highlight rows filtered by viewer permission; no audience-specific projection, no field narrowing | pre |
| TripMemoryProjection | BBW | `routes/memories.ts:947` returns a raw list for a trip | pre |
| PlaceMemoryProjection | NB | | |
| PeopleMemoryProjection | NB | | |
| CompassMemoryProjection | BBW | `compass/ProjectedMemoryPrompt.ts:110-125` feeds Compass from `memory_rediscover`/`memory_retrieve` — derived preferences, not Memory facts | pre |
| PublicMemoryProjection | BBW | `routes/memories.ts:237` is a canonical read, not a derivative (see H79) | pre |
| SearchEmbedding | NB | No embeddings exist | |
| NarrativeDerivative | NB | | |
| MapTrailDerivative | BBW | `lib/mapProducers/memoryProducer.ts:182` emits viewer-scoped map objects from `memory_remembers_for_user` — derived preferences, not a spatial presentation of Memories | pre |
| Derivative registration (source Memory version, type, destination, generatedAt, revocation state) | NB | `memory_derivative_registry` absent; nothing records where a derivative went | |

### §19 Offline and multi-device (6)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H175 | Client operation ids + server idempotency on the sync command | NB | `Idempotency-Key` handling exists for `routes/intel.ts:149` and `routes/mapObservations.ts:926`; no memory route reads it | |
| H176 | Memory can exist before all media uploads complete | **BAC** | `routes/memories.ts:340-405` creates a Memory with no items; items are added independently at `:681` | — |
| H177 | A failed media upload does not invalidate already-saved Memory facts | **BAC** | Same separation: item insert failure returns `db_error` at `:719` and leaves the Memory intact | — |
| H178 | Concurrent edits resolve at command/field level, not blind row last-write-wins | NB | `routes/memories.ts:440-471` builds a partial patch but applies it unconditionally; no version, no `If-Match`, no conflict detection | |
| H179 | Late evidence may raise confidence but must not overwrite explicit edits | NB | No evidence and no confidence exist | |
| H180 | Cross-device uploads/notes converge on one Memory/Episode | NB | | |

### §20 Media pipeline (5)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H181 | Staged pipeline: ingest metadata → fingerprint → cheap association → thumbnail → expensive analysis | BBW | A staged pipeline exists for `post_media` (`2046_phash_dedup.sql`, moderation/processing status guarded at `2158_post_media_write_boundary.sql:41`). **Memory media bypasses all of it**: `routes/memories.ts:539-547` inserts a client-supplied `media_url` straight into `memory_items` with no `media_assets` row, no fingerprint, no moderation state | pre |
| H182 | Distinct original / viewer / card / tiny signed renditions | NB | `lib/mediaAssets.ts:151` carries `thumbnail_path`/`thumbnail_url` only — two tiers, not four | |
| H183 | Perceptual fingerprints detect duplicate imports without filename dependence | BBW | `2046_phash_dedup.sql` implements pHash — for `post_media`. `memory_items` has no `phash` column and never enters that path | pre |
| H184 | Video scenes as logical segments without duplicating originals | NB | `highlights.video_duration_seconds` is a length cap (`routes/highlights.ts:128-138`), not segmentation | |
| H185 | Face recognition must not be a dependency for People Memories | **BAC** | People on a Memory are `memory_tags` — an explicit social-graph primitive with consent (`routes/memories.ts:206-216`, `:838`). No face-recognition code exists in the repo | — |

### §21 Deletion, forgetting and revocation (8)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H186 | Archive: retain canonical, remove from normal browsing | **BAC** | `0067_memories.sql:22` permits `archived`; PATCH accepts it (`routes/memories.ts:244`); the feed filters `state='published'` (`:427`) so archived drops out of browsing while single-fetch by the owner still returns it (`:520` filters only `state != 'deleted'`) | pre |
| H187 | Do not resurface (retain + search privately, suppress proactive resurfacing) | NB | No such control on a Memory | |
| H188 | Do not personalize (retain, exclude from inference) | NB | | |
| H189 | Make private: revoke public derivatives and public indexing, retain the Memory | BBW | PATCH visibility works (`routes/memories.ts:444`) but revokes nothing — there are no derivatives or indexes to revoke, and no cache invalidation on the memories path (contrast `routes/highlights.ts:5`, which does invalidate the Compass cache) | pre |
| H190 | Delete Memory: revoke derivatives, remove indexes/embeddings, purge canonical/eligible evidence | BBW | `routes/memories.ts:503` writes `state:"deleted"` and stops. The media bytes stay publicly served — documented in the repo's own words at `services/accountDeletion/AccountDeletionService.ts:565-570` | pre |
| H191 | Delete media asset: remove asset and derivatives; the Memory survives | **BAC** | `routes/memories.ts:589-617` deletes the row first, then removes the storage object, and refuses any path outside the owner's `memories/{userId}/` prefix. The Memory is untouched | pre |
| H192 | Revocation propagates to public projection, search index, embedding, profile Highlight, Trip story, Passport reference, cached narrative and share links | NB | None of those destinations exists to propagate to | |
| H193 | Deletion observable, retryable, dead-lettered on repeated downstream failure | BBW | `AccountDeletionService` has named, reported steps (`:576`, `:973-975`) — but that is account deletion. Per-Memory deletion has no step, no report, no retry, no dead letter | pre |

### §22 Migration from existing Highlights/Memories (4)
H194 no big-bang; stable IDs/URLs · H195 legacy rows imported as `LEGACY_IMPORTED` with conservative
confidence · H196 dual-read shadow comparison then cutover · **all NOT-BUILT** — no migration to the
spec's model has been started. H197 "never fabricate trip/place/participant/visited during backfill"
— **CANNOT-VERIFY** (see below).

### §23 Authorization and RLS (13)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H198 | Owner-only access to canonical private Memory facts **by default** | BBW | RLS exists (`docs/migrations/0067_memories.sql:30-38`; `0026_highlights.sql:24-33`) — but **every** server read and write on both surfaces uses `getServiceClient()`, which bypasses RLS entirely (`routes/memories.ts:345`, `:420`; `routes/highlights.ts:858`). The effective default is the TypeScript helper `canViewMemory`, not the database | pre |
| H199 | Participant membership alone does not grant full Memory access | **BAC** | `routes/memories.ts:123-200` — a tag grants nothing; `trip_crew` requires both `visibility='trip_crew'` **and** live `trip_members` membership; a hidden viewer is denied under **every** visibility mode (`:139-142`, fixing audit MEM·M1) | pre |
| H200 | Public derivatives behind an explicit publication policy | NB | | |
| H201 | Exact location and private notes require tighter policies than public-safe summary | NB | Exact `location_lat/lng` are stored in the same row and gated only by the gem ceiling | |
| H202 | Service roles performing projections are scoped and audited | BBW | The service client is used as a blanket RLS bypass on every memory/highlight route; no per-surface scoping, no audit trail | pre |
| H203 | Search/index workers consume privacy-filtered event payloads, not raw rows | NB | No such workers | |
| H204 | Truth level and inference provenance are server-controlled; clients may assert but not forge "verified" | **CV** | `2150_passport_memories_write_boundary.sql` revokes `verification_level`, `source_type`, `source_id`, `suggestion_reason`, `plan_id`, `trip_id`, `place_id` from `anon`/`authenticated` — exactly the requirement, and it proves the hole by execution. But the file's own header reads "⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the owner's explicit approval". Whether production is protected is a live-state question | pre |
| H205 | `canReadMemory(userId, memoryId, surface)` | BBW | `routes/memories.ts:123` `canViewMemory(sc, memory, viewerId)` — **no `surface` parameter**, so one verdict serves the feed, the profile listing and the single fetch alike | pre |
| H206 | `canEditMemory(userId, memoryId)` | **BAC** | `routes/memories.ts:437-439` — owner-only, checked against a fresh read, before any patch is composed | pre |
| H207 | `canPublishMemory(userId, memoryId, audience)` | NB | Publishing is a `visibility` write with no audience predicate | |
| H208 | `canSeeExactLocation(userId, memoryId)` | BBW | `routes/memories.ts:87-107` `gemProtectMemoryRow` — owner bypass plus a fail-closed Hidden-Gem ceiling. It answers "is this coordinate on a protected gem", not "may this viewer see this Memory's exact location under the owner's policy" | pre |
| H209 | `canSeeParticipant(userId, memoryId, participantId)` | NB | Tag rows are returned to any permitted viewer | |
| H210 | `canUseForPersonalization(userId, memoryId)` | NB | | |

### §24 Observability and quality metrics (13)
The 12 named metrics — `candidate_confirm_rate`, `candidate_reject_rate`, `candidate_split_rate`,
`candidate_merge_rate`, `place_correction_rate`, `participant_correction_rate`,
`false_memory_rate`, `explicit_memory_without_candidate_rate`, `privacy_revocation_latency`,
`projection_lag`, `resurfacing_suppression_violations`, `do_again_conversion` — are **all
NOT-BUILT**. A repo-wide grep for every one of the twelve names across `.ts`, `.sql` and `.md`
returns **zero** hits.

H(log fields) — operational logs must carry `memoryId`, `commandId`, `eventId`, source version,
engine version, reason codes, projection name and failure class — **BBW**: `routes/memories.ts:300`
logs `memoryId` and a failure class; there is no command id, event id, engine version, reason code
or projection name to log.

### §25 Replay, testing and certification (30)

**12 canonical certification fixtures** (solo trip with explicit Remember · crew trip shared+private
· late media upload · incorrect GPS + place correction · merge-then-split · blocked participant
after a shared experience · public-to-private revocation · delete with embeddings and Highlight
derivatives · imported historical trip · no-photo Memory from voice note + completed plan ·
walk-past that must not become a visit · downloaded screenshot that must not become experienced
content) — **all 12 NOT-BUILT.** No fixture file exists for any of them.

**9 hard invariant tests:**

| Invariant | Bucket | Evidence |
|---|---|---|
| PRIVATE memory cannot appear in public search | NB | `test/memories.test.ts:292` asserts a stranger gets 404 on a single `only_me` fetch — the read path, not the search path. No test covers the discovery feed's privacy filter |
| Deleted memory cannot remain in Compass retrieval | NB | |
| Rejected candidate cannot become a Highlight | NB | No candidates, no projection |
| Planned activity without occurrence cannot earn a visit Memory/Stamp | NB | |
| Blocked person cannot be newly resurfaced through shared-memory recommendations | **BAC** | `test/memoriesBlockFailClosed.test.ts` — the block-lookup-failure path is asserted to fail closed rather than serve an unfiltered feed |
| Public location precision cannot exceed owner policy | NB | |
| User correction cannot be overwritten by weaker inference | BBW | `test/memoryPassportRemembers.test.ts` and `test/memoryLifecycle.test.ts` assert exactly this — for `memory_projections` |
| Historical memory cannot assert current venue availability | NB | |
| Projection consumers tolerate duplicate/out-of-order events | BBW | `test/memoryProjectionSchedulerTiming.test.ts:253` asserts the idempotent projector ordering — for the projection family, and there are no events |

**9 property/chaos scenarios** (duplicate upload · out-of-order evidence · projection worker outage ·
search-index delay · concurrent merge and edit · offline correction · partial media deletion ·
entity merge after Memory creation · timezone/date-line edges) — **all 9 NOT-BUILT.**

### §26 Delivery phases (8)

| Phase | Bucket | Evidence |
|---|---|---|
| 0 — Contracts (enums, schema, command bus, outbox, RLS, reason-code registry) | NB | 4 of 6 sub-artifacts absent entirely |
| 1 — Canonical Memory MVP (private Memories, media links, place/trip links, correction, delete) | BBW | Most of the shape exists (`routes/memories.ts`) but the default is `friends_only`, not private (`0067_memories.sql:13`), and there is no correction path |
| 2 — Episode candidates | NB | |
| 3 — Highlights (finite curated profile projection, pin/reorder/privacy) | BBW | Privacy exists (`lib/highlightPermissions.ts:37`); the projection, the curation, the pin and the reorder do not |
| 4 — Retrieval | NB | |
| 5 — Executable Memories | NB | |
| 6 — Resurfacing | NB | |
| 7 — Imports / Life Chapters | NB | |

### §28 Developer invariants not already counted (5)

| id | Rule | Bucket | Evidence | Attr |
|---|---|---|---|---|
| §28.3 | Never query a semantic substitute for an unknown canonical place/person and pretend it is the requested entity | NB | No semantic retrieval exists; no guard exists either | |
| §28.10 | Never route public-world intelligence directly from private Memory without consent/eligibility/anonymization | **BAC** | The only path from derived memory to a shared surface is `lib/mapProducers/memoryProducer.ts:182`, which calls `memory_remembers_for_user(p_user_id: viewerId)` — strictly the viewer's own memory, on the viewer's own map. Nothing feeds memory into world intelligence | — |
| §28.11 | Never swallow projection/schema failures into plausible-looking empty history without structured error state | **BAC** | `routes/memories.ts:263-279` — a block-lookup error returns `db_error`, explicitly rejecting `data ?? []` because that "yields an empty set → nothing filtered → blocked content leaks". `loadMemoryGemContext` (`:66-78`) records `determined:false` and coarsens rather than silently passing | pre |
| §28.16 | Always preserve original user voice and original-language text in summaries/translations | NB | No summarization of Memories exists | |
| §28.17 | Always provide a deterministic fallback renderer when AI presentation fails | NB | No AI presentation exists; `renderer_version` is absent from `highlights` | |

---

## CANNOT-VERIFY

Two requirements, plus four standing caveats that shape but do not change the verdicts above.

**Requirements genuinely in this bucket:**

1. **H204 — truth levels and inference provenance are server-controlled (§23).** The code is
   correct and I read it: `2150_passport_memories_write_boundary.sql` revokes `verification_level`,
   `source_type`, `source_id`, `suggestion_reason` and the system association columns from `anon`
   and `authenticated`, and the header proves the hole by execution against portava-ci. But that
   header also says the migration is **staged for portava-ci only and must not be applied to
   production without the owner's approval**. Whether a production client can still self-verify a
   memory is a live-state question I was told not to resolve by query.
2. **H197 — "never fabricate trip IDs, place IDs, participant links or visited outcomes during
   backfill" (§22).** No backfill code exists in the branch, so I cannot inspect the mechanism;
   confirming that no fabricated provenance is already sitting in production requires reading
   production rows.

**Standing caveats (recorded, not bucketed):**

- **Flag state in production is unknown.** `memory_projection` (`2183`), `memory_recaps`
  (`2214_memory_recaps.sql:57`, seeded `false`) and `passport_memories_enabled` (read at
  `routes/geofence.ts:845`, `routes/location.ts:419`) all gate live behaviour. Every verdict above
  is graded on the code path, which is flag-independent. Whether `memory_events` /
  `memory_projections` currently receive writes in production turns on `memory_projection` and I
  did not query.
- **Writer attribution is incomplete by the repo's own standard.** `src/scripts/checkWriterlessReads.ts`
  declares that dynamic `.from(expr)` access defeats static attribution and that it errs toward
  silence. I checked both TypeScript and SQL-function writers, but I inherit that caveat: a table I
  call writerless may have a writer I could not see statically.
- **The 24h highlight expiry sweeper's live cadence** (whether `expires_at` is actually enforced by
  a running job rather than only by read-time filters) needs a running app.
- **§26 exit criteria** ("certified", "shadow metrics acceptable", "no private leakage certified")
  each need a live certification run. I graded each phase on its *scope*, not its exit criterion.

---

## Unmerged work, read and reported

### PR #470 — `2320_memory_episode_provenance_spine.sql`
The only artifact in the repository's history that is genuinely aimed at this spec's §3.2/§3.3.
It creates `public.memory_episodes` (`:102`) and `public.memory_evidence` (`:227`) with a lifecycle
matching §5 (`candidate/confirmed/active/archived/merged/rejected/deleted`, `:167`), a CHECK that
makes it structurally impossible to leave `candidate` without both a significance score and a basis
(`:189-191`), an append-only guarantee on evidence enforced at the grant *and* the trigger
(`:457-461`), and a `retention_class` FOREIGN KEY to `memory_policy` rather than a second copy
(`:178`). It is also **inert by construction**: RLS on with no policy, service_role-only grants,
no reader, no writer, no route (postconditions at `:440-452`).

For this census that means: even if merged, both tables would sit in exactly the state the brief
warns about — *a table nothing writes satisfies nothing*. They are counted **NOT-BUILT** here
because they are not in the branch; if merged as-is they would move to BUILT-BUT-WRONG at best,
since §3.2/§3.3 require an episode and evidence that something produces and something reads.

### PR #461 — `2313_highlights_permanent.sql`
Makes `highlights.expires_at` nullable so a Highlight can be PERMANENT (§3.5's `lifetime_class`
PERMANENT, §12's class table), and rewrites the SELECT policies to admit the NULL arm — with a
postcondition that fails the migration if any policy still requires `expires_at > now()` without
admitting NULL (`:200-209`). Good work, and it targets a real §12 gap.

**I independently confirm the committed file is broken.** It writes `public.in_accepted_circle(...)`
(`:117`) and `public.is_blocked(...)` (`:139`). Migration `2182_close_authz_rpc_oracle.sql:95-97`
moved both of those functions out of `public` and into the `authz` schema
(`ALTER FUNCTION public.is_blocked(uuid, uuid) SET SCHEMA authz;` and the same for
`in_accepted_circle`). Only `viewer_is_blocked` — which 2182 deliberately left alone — is still in
`public`, and 2313 uses that one correctly at `:111`. So two of the three predicate references in
the rewritten policies will not resolve on any database where 2182 has been applied.

Separately worth flagging for whoever fixes 2313: `routes/highlights.ts:893` filters
`.gt("expires_at", now)`, which is exactly the bare `> now()` that 2313's own column comment
(`:76-77`) warns "hides every permanent Highlight". The migration's postcondition guards the RLS
policies but cannot see the application query.

---

## What I would fix first, if the point is to make the spec true rather than to score it

1. **`highlights` is a Stories table wearing this spec's noun.** §1 lists "building an Instagram
   Stories clone" as a non-goal, and §12 defines Highlights as *projections over Memories or
   Episodes*. `routes/highlights.ts:116` creates a highlight from a raw `mediaUrl` with no source.
   Until a Highlight has a source Memory, §12, §18 and half of §21 have nothing to attach to.
2. **The discovery feed is the exact anti-pattern §10 and §28.6 name.** `routes/memories.ts:237-279`
   reads canonical storage through a service client, limits before filtering, and post-filters in
   TypeScript. It is also a correctness bug independent of the spec: the `.limit(n)` runs before the
   block filter, so a page shrinks by however many blocked owners it contained.
3. **`save to Highlight` silently escalates audience to public** (`routes/stories.ts:609`). That
   violates §1 ("publishing is always a separate projection decision") and §10 ("publishing must
   never exceed the owner's selected precision") in a single insert.
4. **Memory media bypasses the media pipeline entirely.** `memory_items` takes a client-supplied
   URL with no `media_assets` row, no pHash, no moderation state (`routes/memories.ts:539-547`),
   while `post_media` has all three. §20 assumes one pipeline.

---

## A. Re-census — 2026-09-08, HEAD `cdfff599`

Paths relative to `artifacts/api-server/src/`. Same denominator (266), same
counting rule, same four buckets. Rows not restated here keep the verdict the
body gave them.

### A.1 What landed, verified rather than taken on trust

| Claim | Verified? | Where |
| --- | --- | --- |
| A command boundary with idempotency keys, per-attempt audit, transactional outbox | **In code, yes. In production, no.** | `lib/memoryCommandBus.ts:281` (11 command types), `:434` `IDEMPOTENCY_KEY_HEADER`, `:440` envelope reader, `:470` `executeMemoryCommand`; `lib/memoryOutbox.ts:67-79` (§17's fourteen event names verbatim); `services/memory/MemoryDomainService.ts:121` `auditCommand`, `:338` `dispatchMemoryCommand`. The kernel tables and `public.memory_kernel_execute` are migrations **2710 / 2711, NOT applied**. |
| The flag is seeded FALSE | **Stronger than that — the row does not exist.** | 2710 seeds `memory_kernel_enabled`; 2710 is unapplied, so the production flag set (`lib/capability/snapshots/20260908-production-schema.json`) contains no such key, and `isFlagEnabled` is fail-closed. Every memory write in production is the legacy direct write, audited only by a log line marked `durable:false` (`MemoryDomainService.ts:360-370`). |
| Seven routes cross the boundary | **Yes** | `routes/memories.ts:476#CREATE_MEMORY` (CREATE), `:1051` (PATCH → ARCHIVE / CONFIRM / CHANGE_VISIBILITY / CHANGE_PLACE / UPDATE via `commandTypeForPatch` in `MemoryDomainService.ts`), `routes/memories.ts:981#DELETE_MEMORY` (DELETE), `:1052#ADD_MEDIA` (ADD_MEDIA), `:1142#REMOVE_MEDIA` (REMOVE_MEDIA), `:1291#ADD_PERSON` (ADD_PERSON / REMOVE_PERSON) |
| MERGE / SPLIT / PIN / UNPIN / PUBLISH_HIGHLIGHT / HIDE_HIGHLIGHT / SET_RESURFACING_POLICY are **not** declared | **Yes, and the code says why** | `lib/memoryCommandBus.ts:306-313` — `MEMORY_COMMAND_TYPES_NOT_DECLARED`, each with its reason. They stay NOT-BUILT. |
| `memoryProjections/**` — registry, evidence, episodes, significance, graph | **Yes, and reachable from nothing** | `evidence.ts:246, 435`; `episodeDetection.ts:244`; `significance.ts:162`; `memoryGraph.ts:246`; `projectionRegistry.ts:501`; `derivativeRegistry.ts:287`. **No route or lib outside `src/test/` imports any of them** — grepped across `src/routes/`, `src/lib/`, `src/services/` and `src/scripts/` at this commit. |
| `memoryRetrieval/**` | **Yes, test-only** | `searchMemories.ts:169`, namespace table at `:49`. Same reachability finding. |
| `highlights/**` — ranking, lifecycle, projection policy, resurfacing, revocation | **Three of five are wired** | Wired: `highlightResurfacing` (`routes/highlights.ts:18`), `highlightProjectionPolicy` (`:23`), `highlightRevocation` (`:24`, executed `:945`). **Not wired:** `highlightRanking.ts` and `highlightLifecycle.ts` — test-only. |
| `highlightPermissions.ts` reconciled to one rule | **Yes, and it is live** | `lib/highlightPermissions.ts:1-55` records the fork it closed: `canEngageHighlight` had **zero callers** while five routes re-derived the rule inline and disagreed with it on self-like and self-reply. The routes' behaviour was kept — widening is a product decision — and every route now calls `canViewHighlight` / `canEngageHighlight` (`routes/highlights.ts:6-13`). No migration is involved, so this one **is** in production. |
| `highlights.archived_at` wired as a reversible archive | **Yes, and it is live** | `routes/highlights.ts:52` (projected), `:995` archive, `:1026` unarchive, `:1063` `GET /highlights/archived`, and `.is("archived_at", null)` on the three list reads (`:575`, `:739`, and the following-feed). **`archived_at` exists on `public.highlights` in production** (schema snapshot), so this is the one Highlights change in this range that a deployed database can actually hold. |
| 2710, 2711, 2720–2724, 2730 written and NOT applied | **Yes** | None appears among the 35 entries in `lib/capability/production-applied-migrations.json`; none of their tables (`memory_domain_events`, `memory_event_outbox`, `highlight_resurfacing_preferences`, `highlight_projection_policies`, `highlight_sources`, `highlight_revocation_log`, `memory_derivative_registry`) appears in the production schema snapshot. `routes/highlights.ts:73-75` and `highlightProjectionPolicy.ts:228` say so in their own words. |

### A.2 The scoring rule applied here, stated once

**A migration written but not applied means the storage does not exist.** Code
that degrades honestly when its table is absent is BUILT; the requirement it
serves is not satisfied. Every such row below is **BBW** with the reason "code
built, storage unapplied (migration NNNN)", never BAC. Applied uniformly, that
is what keeps CORRECT at 6.0 % while CONSTRUCTED moves 24 points.

**A second rule, applied for the same reason:** a module that no route, lib or
script imports outside `src/test/` is BUILT and is BBW. It is not BAC, because
a guarantee that has never had an opportunity to hold has not held. This is why
**H64** ("significance internal, never a public social score") and **H65**
("media quality must not dominate significance") are **BBW** and not BAC even
though `redactSignificanceForAudience` (`significance.ts:291`) and
`MEDIA_QUALITY_MAX_CONTRIBUTION` (`:86`) are exactly the concrete artifacts rule
7 asks for: the score they govern is not reachable from any route, so nothing
has yet been protected.

### A.3 Verdict changes — table rows

| id | Was | Now | Evidence at `cdfff599` | Attr |
|---|---|---|---|---|
| H84 | BAC | **BBW** | **A false green, corrected.** Blocking half stands (`routes/memories.ts:263-279`, `routes/highlights.ts:872-880`). Deletion half is false: `highlights`, `highlight_likes`, `highlight_reports`, `highlight_views` are in `UNCLASSIFIED_BACKLOG` (`lib/deletionDispositions.ts:366-369`), `highlight_replies` in `DENOMINATOR_CORRECTION_BACKLOG` (`:569`); `AccountDeletionService.ts:100-104` confirms. `memories` / `memory_likes` / `memory_saves` remain genuinely cascaded (`:152`). | pre |
| H7 | NB | **BBW** | MemoryEvidenceService: `services/memoryProjections/evidence.ts` — normalization (`:246`), dedup (`:332`), precedence merge (`:364`), eligibility (`:435`), versioned (`:34`, `:36`). No route imports it; `memory_evidence` does not exist. | spec |
| H8 | NB | **BBW** | EpisodeDetectionService: `episodeDetection.ts:244` `detectEpisodes`, deterministic (sorted output, digest ids), `EPISODE_DETECTOR_VERSION` (`:32`). No inputs exist — `memory_evidence` and `memory_episodes` are still absent. | spec |
| H9 | NB | **BBW** | MemoryEligibilityService: `evidence.ts:435` `evaluateEligibility` with a closed rejection-reason set (`:391`). Test-only. | spec |
| H12 | NB | **BBW** | HighlightService: `services/highlights/` — ranking (`highlightRanking.ts:278`), lifecycle (`highlightLifecycle.ts:256`), projection policy, resurfacing, revocation. Three are wired into `routes/highlights.ts`; the two that would build and rank a Highlight are not. | spec |
| H13 | NB | **BBW** | MemorySearchService: `services/memoryRetrieval/searchMemories.ts:169`. Test-only; the projections it reads have no registry rows because 2730 is unapplied. | spec |
| H42 | NB | **BBW** | `ConfidenceBand` is declared with the spec's exact four members (`evidence.ts:59`) and computed (`confidenceBandOf`, `:562`). No column stores it; nothing consumes it. | spec |
| H45 | NB | **BBW** | `MemoryRelationType` (`memoryGraph.ts:54, 58`) and a validated `MemoryEdge` (`:64, 73`). `memory_relations` still does not exist. | spec |
| H46 | NB | **BBW** | `HIGHLIGHT_LIFETIME_CLASSES` and §12's defaults table verbatim (`highlightLifecycle.ts:61, 73`). `highlights.lifetime_class` does not exist (2723 unapplied). | spec |
| H47 | NB | **BBW** | Truth precedence is encoded as an ordering, not prose: `precedenceRank` (`evidence.ts:81`) with `mergeByPrecedence` (`:364`). Governs no stored fact. | spec |
| H63 | NB | **BBW** | `scoreSignificance` (`significance.ts:162`) returns the score **with every contribution that produced it** — input code, weight, delta, cap, overriding rule — under `SIGNIFICANCE_POLICY_VERSION` (`:34`). Reachable from nothing. | spec |
| H64 | NB | **BBW** | `SIGNIFICANCE_FIELDS` + `redactSignificanceForAudience` (`significance.ts:285, 291`) strip the score for an audience. Scored BBW, not BAC, per A.2: nothing publishes the score, so the strip has never run in anger. | spec |
| H65 | NB | **BBW** | `MEDIA_QUALITY_MAX_CONTRIBUTION` (`significance.ts:86`) caps media quality at its own weight. Same limit as H64. | spec |
| H66 | NB | **BBW** | Explicit intent is a hard rule inside `scoreSignificance` rather than a weight (`significance.ts:162` and the contribution list it returns). Same limit. | spec |
| H75 | NB | **BBW** | `MEMORY_CONSENT_DIMENSIONS` (`highlightProjectionPolicy.ts:63`) is the spec's five, with `consentFromRow` / `mayProject` (`:87, 101`) treating `unknown` as withheld. `highlight_projection_policies` is 2721, **unapplied**, so `readProjectionPolicies` returns `absent` and nothing is enforced (`:228`). | spec |
| H81 | NB | **BBW** | `clampLocationToPrecision` (`highlightProjectionPolicy.ts:165`) and `resolveLocationDisclosure` (`:205`), wired into the feeds (`routes/highlights.ts:23`, applied at `:128`). Unenforced today for exactly the reason the file states: no policy table. | spec |
| H82 | NB | **BBW** | Same clamp, and `strictestPrecision` (`:134`) means a policy can only tighten. Same unapplied storage. | spec |
| H86 | NB | **BBW** | `SENSITIVE_CONTEXT_CATEGORIES` (`highlightResurfacing.ts:66`) plus `SENSITIVE_CATEGORY_REGISTRY_MAPPING` (`:93`) binding them to the existing `lib/protectedLocations.ts` registry — which is the connection the body found missing. The mapping is declared; no read on either surface consults it yet. | spec |
| H89 | NB | **BBW** | `HIDE_PERSON_FROM_RESURFACING` is a declared control (`highlightResurfacing.ts:129`) and is applied on the proactive feeds by owner id (`routes/highlights.ts:112`). Storage is 2720, **unapplied**: `applyResurfacingControls` logs "§11 resurfacing controls are NOT DEPLOYED — feed served without them" (`:96-102`) and suppresses nothing. | spec |
| H90 | NB | **BBW** | `HIDE_TRIP` declared (`highlightResurfacing.ts:129`) with its surface effects (`:157`). Same unapplied storage; no trip-keyed subject reaches the feed filter. | spec |
| H91 | NB | **BBW** | `KEEP_PRIVATE_FOREVER` declared and in `FEED_SUPPRESSING_CONTROLS` (`routes/highlights.ts:79`). Same unapplied storage. | spec |
| H99 | NB | **BBW** | `HIGHLIGHT_RANKING_FACTORS` (`highlightRanking.ts:61`) is §12's seven verbatim and `rankHighlights` (`:278`) computes them. No `ranking_score` column (2723) and no route calls it — `routes/highlights.ts` still orders by `created_at`. | spec |
| H100 | NB | **BBW** | `manual_pin` is the first ranking factor and outranks the rest by construction. No pin column, no pin route, no pin in the client. | spec |
| H101 | NB | **BBW** | `DIVERSITY_DIMENSIONS` (`highlightRanking.ts:74`) is trip/person/venue/activity, applied inside `rankHighlights`. Unreachable. | spec |
| H175 | NB | **BBW** | `Idempotency-Key` is now read on the memory command routes (`lib/memoryCommandBus.ts:434, 440`; `routes/memories.ts:304`) and carried into every dispatch. The receipt table is 2710, **unapplied**, so with the kernel off a replayed key produces a second write and only a log line records the key (`MemoryDomainService.ts:360-370`). | spec |
| H187 | NB | **BBW** | `DO_NOT_RESURFACE` is declared, its surface effects are enumerated against §21's table (`highlightResurfacing.ts:157`), and it is applied to both proactive feeds. Storage unapplied (2720). Still no such control on a **Memory** — this is the Highlights surface only. | spec |
| H188 | NB | **BBW** | `RETAIN_BUT_DO_NOT_PERSONALIZE` is separated from `DO_NOT_RESURFACE` — the body's complaint that the two were inseparable no longer holds in the vocabulary (`highlightResurfacing.ts:144-157`). Storage unapplied. | spec |
| H192 | NB | **BBW** | `REVOCATION_DESTINATIONS` (`highlightRevocation.ts:168`) is §21's eight verbatim and `executeRevocation` (`:305`) is wired into `DELETE /highlights/:id` (`routes/highlights.ts:945`). **One of the eight is actually reached** — `cached_narrative`, and the outcome text says frankly that even that is guaranteed only for the in-process L1 cache. The rest report `not_applicable` or `not_implemented`, which the type distinguishes from success (`:180-188`). | spec |
| H200 | NB | **BBW** | The publication policy exists as an artifact (`highlightProjectionPolicy.ts:333` `PROJECTION_POLICY_COLUMNS`, `:364` `readProjectionPolicies`) and is consulted on the feeds. Its table is 2721, **unapplied**, so there is no policy to be behind. | spec |
| H201 | NB | **BBW** | The precision ladder is now applied on a durable public surface — Highlight `location_name` / `city` / `country` are rewritten to the owner's rung before serving (`routes/highlights.ts:128` `applyLocationPrecision`, `highlightProjectionPolicy.ts:165`). It does not reach a Memory's `location_lat` / `location_lng`, and it is unenforced until 2721 lands. | spec |
| H209 | NB | **BBW** | `PERSON_VISIBILITY_LADDER` is §10's five rungs (`highlightProjectionPolicy.ts:261`) and `discloseParticipant` (`:307`) answers per viewer. Not wired to `memory_tags`; no per-participant policy is stored. | spec |
| H210 | NB | **BBW** | `canUseForPersonalization` exists in substance: `CONTROL_EFFECTS` names `personalization` as a suppressible surface distinct from resurfacing and recap (`highlightResurfacing.ts:144-157`), so the question is answerable. Storage unapplied; no personalization path consults it. | spec |

### A.4 Verdict changes counted in prose

These sections count requirements in prose rather than in a row the tool can
read; the body does the same, and the counts below follow its own enumeration.

| Section | Requirement(s) | Was | Now | Evidence |
| --- | --- | --- | --- | --- |
| §6 (4) | H54 normalization · H55 eligibility gate · H56 rejection-reason registry · H57 evidence-source strength | NB ×4 | **BBW ×4** | `evidence.ts:246` (normalize, with a closed rejection set at `:192`), `:435` (eligibility, reasons at `:391`), `:114` `EVIDENCE_SOURCE_STRENGTH` per source type. Test-only; no `memory_evidence` table. |
| §7 (5) | H58 deterministic grouping · H59 boundary features · H60 midnight must not split · H61 versioned reason codes · H62 dedup relations | NB ×5 | **BBW ×5** | `episodeDetection.ts:244` (no clock, no I/O, sorted output, digest ids), `:46` `BOUNDARY_FEATURES`, the midnight rule implemented rather than commented, `:71` `EPISODE_REASON_CODES` under `:32` `EPISODE_DETECTOR_VERSION`, `:375` `relateEpisodes`. No detector inputs exist. |
| §13 (3) | H104 compression hierarchy · H105 Life Chapters as projections · H106 edge types | NB ×3 | **BBW ×3** | `memoryGraph.ts:41` `COMPRESSION_LEVELS`, `:246` `buildCompressionHierarchy`, `:227` `buildLifeChapters` (ids, counts and a derived label only — no caption or media is copied upward, which is the §28.8 rule), `:58` `MEMORY_RELATION_TYPES`. Test-only. |
| §15 (5) | H110 signature · H111 deterministic before semantic · H112 ranking dimensions · H113 namespace isolation · H114 revocation of derivatives | NB ×5 | **BBW ×5** | `searchMemories.ts:169`, `:49` `NAMESPACE_PROJECTIONS` (checked on the way IN), `:65` `RANKING_WEIGHTS`, `:141` a lexical scorer used only after the deterministic pass, `derivativeRegistry.ts:450` `revokeDerivativesForMemory`. Test-only, and the registry table is 2730, unapplied. |
| §17 (33) | `CONFIRM_MEMORY` | NB | **BBW** | Declared (`memoryCommandBus.ts:282`), mapped to `memory.confirmed` (`:318`), and issued by the PATCH route for `state: "published"` (`MemoryDomainService.ts:166`). No durable receipt (2710). |
| §17 | `memory.created` · `.confirmed` · `.corrected` · `.archived` · `.deleted` · `.visibility_changed` | NB ×6 | **BBW ×6** | Declared verbatim (`memoryOutbox.ts:67-74`) and mapped from every declared command (`memoryCommandBus.ts:317-335`). **None is emitted**: the emit is inside `memory_kernel_execute`, migration 2711, unapplied. `memory.merged` / `.split` and the five `highlight.*` events stay NB. |
| §17 | transactional outbox | NB | **BBW** | `lib/memoryOutbox.ts` is the payload and ordering contract; the atomic write is 2710/2711's SQL function. Unapplied, so no outbox row has ever been written. "Idempotent consumers" stays NB — there are none. |
| §18 (12) | PlaceMemoryProjection · PeopleMemoryProjection | NB ×2 | **BBW ×2** | Both are defined and marked `availability: "BUILDABLE"` (`projectionRegistry.ts:339, 364`) with §18's own audience vocabulary (`:56`). Nothing builds them. |
| §18 | Derivative registration (source version, type, destination, generatedAt, revocation state) | NB | **BBW** | `derivativeRegistry.ts:252` `RegistrationRow`, `:287` `rebuildProjection`, `:395` `projectionStaleness`, `:450` revoke. Table is `memory_derivative_registry`, migration 2730, **unapplied**. |
| §26 (8) | Phase 0 Contracts · Phase 2 Episode candidates · Phase 4 Retrieval · Phase 6 Resurfacing | NB ×4 | **BBW ×4** | Each phase's code artifacts now exist and are cited above; each phase's storage is an unapplied migration. Phases 5 and 7 stay NB. |

### A.5 What did NOT move, and why

| Requirement | Stays | Why |
| --- | --- | --- |
| H94–H98 (LIVE / DAY / TRIP / SEASONAL / PERMANENT) | **NB** | The classes are declared, and `representableLifetimeClasses` (`highlightLifecycle.ts:106`) answers, for a database without `highlights.lifetime_class`, that **all five are unrepresentable** — "migration 2723 not applied", in the function's own words. Declaring a vocabulary a database cannot hold is not building the class. |
| H23, H24, H26–H30, H32–H37 (13 storage tables) | **NB** | A written migration is not a table. `memory_domain_events`, `memory_event_outbox`, `memory_derivative_registry`, `highlight_sources`, `highlight_revocation_log`, `highlight_resurfacing_preferences` and `highlight_projection_policies` are all in unapplied migrations and none appears in the production schema snapshot. `memory_relations`, `memory_corrections`, `memory_entity_links` are not written at all. |
| H115–H128 (Compass memory tools and LLM boundary) | **NB ×14** | `compass/CompassTools.ts` is unchanged — re-read at this commit, no memory-facing tool, and no memory-facing LLM path exists to constrain. |
| §24's twelve named metrics | **NB ×12** | Re-grepped: none of the twelve names occurs in `.ts`, `.sql` or `.md`. `readMemoryCommandRejectedTotal` (`memoryCommandBus.ts:412`) is a counter, but it is not one of them. |
| §25's 12 fixtures, 9 invariants, 9 chaos scenarios | **unchanged** | Ten new memory/highlight suites landed, but they test the new modules, not the spec's named fixtures. I declined to re-map them onto §25's list: doing so would be scoring a resemblance. |
| H79 (public search must query a derivative, never canonical + post-filter) | **BBW** | `routes/memories.ts:237-279` is untouched by this range: still the service client over canonical `memories`, still `.limit()` before block filtering. `PublicMemoryProjection` exists in the registry and nothing routes through it. This is the single largest gap between the code that landed and the code that serves traffic. |
| H93 (Highlights are projections over Memories) | **BBW** | `highlight_sources` — the link that would give a Highlight a source Memory — is migration 2722, written, **unapplied**, and has no TypeScript writer. `POST /highlights` still inserts a client-supplied `mediaUrl`. |
| H103 (Highlights remain finite) | **BBW** | A bound now exists (`routes/highlights.ts:419-420`, `FOLLOWING_FEED_DEFAULT_LIMIT`) but only behind `highlights_feed_bounded_enabled` (migration 2339), which is **not in the applied list**, so the flag has no row and `isFlagEnabled` fails closed. The following-feed is unbounded in production. |
| H204 | **CV** | Still cannot-verify, and for a sharper reason than the body had. `2150_passport_memories_write_boundary.sql` is not among the 35 entries in `production-applied-migrations.json` — but that file's own header says it is *"a record of what WE applied, not proof of everything that is applied … a staleness tripwire, not an inventory"*. Absence there is not proof of absence in production. Resolving H204 needs a live query, which this pass did not make. |
| H197 | **CV** | No backfill code exists in the branch. Unchanged. |
| H2 (automatic Memories private-first) | **BBW** | `routes/stories.ts` "save to Highlight" is outside this range and still hard-codes `visibility: "public"`. |
| H50 (Memory lifecycle machine) | **BBW** | Genuinely improved and **live**: `assertLifecycleTransition` (`memoryCommandBus.ts:253`) runs on every PATCH regardless of the kernel flag (`MemoryDomainService.ts:240`), so an illegal transition is now refused in production. It stays BBW because the stored vocabulary is still `0067`'s five and none of `CANDIDATE`, `CONFIRMED`, `MERGED`, `REJECTED` can be written. |
| H51 (Highlight lifecycle machine) | **BBW** | Also improved and live: `archived_at` is a real reversible archive on a column production has, and `isHighlightActive` distinguishes it from the terminal `deleted_at` (`lib/highlightPermissions.ts:95`). `DRAFT`, `PINNED` and `HIDDEN` remain unstorable (2723). |
| H198 (owner-only by default) | **BBW** | Every memory and highlight read still runs on `getServiceClient()`; the effective default is still the TypeScript helper. What changed is that there is now exactly **one** such helper instead of five inline copies (`lib/highlightPermissions.ts:1-55`) — a real reduction in the number of places the default can drift, and not a move to the database. |

### A.6 Attribution — CONSTRUCTED is now spec-attributable; CORRECT still is not

The body's central claim was *"not one file cites this spec"*. That is no longer
true. `lib/memoryCommandBus.ts:4-16`, `lib/memoryOutbox.ts:4-14`,
`services/memory/MemoryDomainService.ts:5`,
`services/memoryProjections/{evidence,episodeDetection,significance,memoryGraph,projectionRegistry,derivativeRegistry}.ts`,
`services/memoryRetrieval/searchMemories.ts:4-14`,
`services/highlights/{highlightLifecycle,highlightRanking,highlightRevocation,highlightProjectionPolicy,highlightResurfacing}.ts`
and `lib/highlightPermissions.ts:4-14` each open by naming
`Portava_Highlights_Memories_Development_Architecture_Spec_v1` and the sections
they implement, and several cite this census by requirement id.

**63 of the 123 BBW verdicts are spec-attributable.** **0 of the 16 BAC
verdicts are.** That is the honest summary of this range: the specification
finally has code written for it, and none of that code has yet made a single
requirement true end-to-end, because the eight migrations it rests on have not
been applied.

### A.7 Owner decisions this pass surfaces

1. **Apply 2710 + 2711, or stop calling the command bus a boundary.** Until they
   land, `memory_kernel_enabled` has no row, every write is the unaudited direct
   write, and §17 cannot leave BBW no matter how good `memoryCommandBus.ts` is.
2. **Apply 2720 + 2721.** The §10/§11 controls are wired into the live feeds and
   suppress nothing; `routes/highlights.ts:96-102` logs that on every request.
   A user's "never show me this again" is currently a no-op the server announces
   to its own logs.
3. **Apply 2730** before any derivative is built, since it is the cleanup graph
   deletion would need.
4. **D6 for highlights.** `highlights`, `highlight_likes`, `highlight_reports`,
   `highlight_views` and `highlight_replies` all survive account deletion (H84).
   That is the D6 backlog, it is an owner decision, and this census does not
   close it — it only stops reporting it as closed.
5. **H79 is not a migration problem.** The public discovery feed reads canonical
   `memories` through the service client and post-filters blocks. Nothing in this
   range touched it, and `PublicMemoryProjection` exists precisely to replace it.

---

## B. The prose gap closed, and §25 built — 2026-09-13, measured at HEAD `254e1876`

This pass does two things. Neither is a re-scoping: the denominator is still **266**,
the counting rule in "How I decided what counts" is unchanged, and the four buckets are
unchanged.

1. **It gives every requirement a row.** Before this pass `check:census-integrity` could
   read **112** of this document's 266 requirements. The other **154** were counted in
   paragraphs — "all 12 NOT-BUILT", "11 BBW", "NB ×14" — which is a legitimate way to
   count and an impossible one to parse. Section **B.5** below is those 154 as
   `| id | requirement | verdict | evidence |` rows, each verdict re-derived by opening
   the file it cites at this commit. Parsed rows are now **266 of 266** and the prose gap
   is **zero**.
2. **It builds §25.** All thirty of §25's requirements — twelve canonical certification
   fixtures, nine hard invariant tests, nine property/chaos scenarios — were NOT-BUILT.
   They are built, wired to `check:memory-certification`, and they found a real defect in
   `dedupeEvidence` on their first run.

**One thing was edited outside this section, and it is disclosed rather than buried.** The
`head_commit` value in the re-census header at the top of this file was changed from
`42aeac38` to `254e1876`. `check:census-freshness` reads the FIRST `head_commit` row in a
file, so an appended section cannot re-declare it; and leaving it at `42aeac38` reported
this census as STALE, because `services/memoryProjections/evidence.ts` is in its declared
scope and this pass changed it. Section A's own text is preserved word for word inside
that row. No verdict, heading or number in the body or in section A was altered.

### The honest arithmetic, in three steps

| Step | BAC | BBW | NB | CV | Parsed rows | CONSTRUCTED% | CORRECT% |
|---|---:|---:|---:|---:|---:|---:|---:|
| What the tool could read before this pass | 13 | 65 | 32 | 2 | 112 | 29.3 % | 4.9 % |
| Section A's own last stated headline (154 of these counted in prose) | 16 | 123 | 125 | 2 | — | 52.3 % | 6.0 % |
| Conversion to rows ONLY, before anything was built | 17 | 124 | 123 | 2 | 266 | 53.0 % | 6.4 % |
| Conversion **plus** the §25 build (this section's result) | 38 | 129 | 97 | 2 | 266 | 62.8 % | 14.3 % |

**Did converting prose to rows move the percentage up or down? Neither, materially — and
that is the finding.** Against section A's own headline, conversion alone moved
CONSTRUCTED from 52.3 % to **53.0 %** and CORRECT from 6.0 % to **6.4 %**. Both moves come
from a single row, **H205**, which section A graded against code that has since changed,
plus rounding. Section A's prose enumeration was substantially accurate; what it was not
was *checkable*, and 154 requirements that no tool can read is a defect whatever the
numbers behind it turn out to be.

Against the **tool's** reading the jump looks enormous — 29.3 % → 53.0 % constructed,
4.9 % → 6.4 % correct — but nothing was constructed to produce it. That number moved
because the tallier had been scoring 154 requirements as absent for the sole reason that
it could not read the paragraph they lived in. Anyone quoting "29.3 % constructed" was
quoting a parser limitation, not a measurement of the repository. Anyone who now quotes
53.0 % as progress is quoting the same thing with the sign reversed.

**The 8.3 points of CORRECT that the build added are real, and 21 of the 22 new BAC rows
are §25 requirements this pass wrote.** That is the whole of it. Nothing else in this
document moved to BAC, no migration was written or applied, no flag was created, and not
one of the seven engines §25 now certifies became reachable from a route.

### B.1 What was built, and where

**Everything below is on a branch. Built on branch is not merged; merged is not deployed;
deployed is not flag-enabled; flag-enabled is not production-realized.** No migration was
written in this pass and none was applied. Production project `ajrurzioarfkagpuxfnb` was
not touched, queried or altered.

#### The §25 certification suite

| Artifact | Where | What it is |
|---|---|---|
| Twelve canonical fixtures | `artifacts/api-server/src/services/memoryCertification/fixtures.ts:42#CERTIFICATION_FIXTURE_IDS` | §25's twelve sentences (`docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:643-655`), verbatim and in the spec's order, each a deterministic world of canonical rows and raw §6 signals. `memoryCertificationFixtures.test.ts` reads those twelve sentences OUT OF THE SPEC FILE and compares them to the fixtures' `spec_text`, so a renamed or dropped fixture fails rather than being noticed by a reader who happens to have both open. |
| Their expectations | `artifacts/api-server/src/services/memoryCertification/fixtures.ts:528#FIXTURE_EXPECTATIONS` | Per fixture: the §6 verdict, the §7 episode count, and the exact `PublicMemoryProjection` membership. **Every number was argued from the spec before the runner was executed once** — from §6's gate order, §6's `proves_occurrence_alone` column and §7's 180-minute floor. An expectation copied out of a run asserts only that nothing changed. |
| Paired controls | same file | Four refusal fixtures carry a one-field variation that must FLIP the verdict — the screenshot re-declared as a camera capture, the import re-declared as a capture, the crew overlap with a capture added, the pass-by alone. A gate that refuses everything fails all four. |
| Nine hard invariants | `artifacts/api-server/src/services/memoryCertification/invariants.ts:79#INVARIANT_IDS` | §25's nine, each asserted against the real engines, each recording the surface it was proved on and whether any route reaches it. |
| Three statuses, not two | `artifacts/api-server/src/services/memoryCertification/invariants.ts:92#InvariantStatus` | `HELD` / `VIOLATED` / **`NO_SURFACE`**. The third exists so an invariant with nothing in this repository to be true of can never be reported as a pass. It is the single most important line in the module. |
| Nine chaos scenarios | `artifacts/api-server/src/services/memoryCertification/chaos.ts:64#CHAOS_SCENARIO_IDS` | Duplicate upload · out-of-order evidence · projection worker outage · search-index delay · concurrent merge and edit · offline correction · partial media deletion · entity merge after creation · timezone and date-line edges. |
| Four statuses | `artifacts/api-server/src/services/memoryCertification/chaos.ts:77#ChaosStatus` | `TOLERATED` / `BROKEN` / **`PARTIAL`** / `NO_SURFACE`. `PARTIAL` exists because two scenarios have one certifiable half and one absent half, and both "pass" and "skip" would be false. |
| The deterministic world | `artifacts/api-server/src/services/memoryCertification/world.ts:97#CertificationWorld` and `:228#certificationClient` | No clock, no randomness, no network. `certificationClient` implements the narrow `ClientLike` slice `derivativeRegistry.ts` declares, resolving with `{ data, error }` exactly as supabase-js does, so the REAL `deriveProjection`, `rebuildProjection`, `projectionStaleness`, `revokeDerivativesForMemory` and `searchMemories` run against it. |
| The report | `artifacts/api-server/src/services/memoryCertification/runCertification.ts:216#runCertification`, rendered at `:256#formatCertificationReport` | Byte-identical across runs, carrying the six engine versions §25 says a replay must be attributed to. A test asserts the rendering contains no timestamp and no duration, because a report that cannot be diffed is not a replay. |
| The wiring | `artifacts/api-server/src/scripts/checkMemoryCertification.ts:42#async`, `artifacts/api-server/package.json:52#check:memory-certification`, `artifacts/api-server/scripts/run-all-checks.sh:169#run_check`, `artifacts/api-server/src/scripts/guardRegistry.ts:563#checker` | It runs in `check:all`. `run-all-checks.sh` goes from 25 passed to **26**; the five exit-2 checks are unchanged (they need live credentials this pass must not supply). |

#### A real defect the suite found, and the production fix

`DUPLICATE_UPLOAD` came up **BROKEN on its first run, before anything was changed to make
it pass**:

```
H245  BROKEN     DUPLICATE_UPLOAD
      the survivor depended on delivery order
```

`dedupeEvidence` sorted candidates by `(fingerprint, source_id)` and kept the first at
equal precedence. A re-delivered upload shares BOTH — the fingerprint buckets observation
time to the minute deliberately, so "the same claim re-delivered with a slightly different
capture timestamp is one claim, not two" — and the two copies differ only in `observed_at`.
So the surviving record, and therefore the timestamp §7 draws episode boundaries from, was
whichever copy the caller passed first. Two replays of one history could produce different
episodes: precisely what §25 exists to prevent.

The fix is in the production module:
`artifacts/api-server/src/services/memoryProjections/evidence.ts:366#a.observed_at.localeCompare(b.observed_at)`
extends the pre-sort into a total order over the fields that distinguish two records at
equal precedence, earliest observation winning. The existing order-independence test could
not see the bug — its two records differ in PRECEDENCE, which is decided before the
tie-break ever runs.

#### Red-first: every behavioural claim, and the mutation that made it fail

Each mutation was applied to **production** code, measured, and reverted. None is a change
to a test, and none is a change to a constant an assertion reads back.

| # | Mutation (production file) | Measured result | Reverted |
|---|---|---|---|
| 1 | `projectionRegistry.ts` `PublicMemoryProjection.build`: dropped `&& m.visibility === "public"` | 4 fixtures DIVERGED (H224, H225, H232, H233 — only_me and private rows in the public derivative), H236 VIOLATED, `check:memory-certification` exit 1 with 5 findings | yes, green |
| 2 | `evidence.ts` MEDIA_NOT_CAPTURED: dropped `prov === "screenshot"` | H235 DIVERGED — "eligibility passed but the spec-derived expectation was refuse (MEDIA_NOT_CAPTURED)" | yes, green |
| 3 | `searchMemories.ts` `NAMESPACE_PROJECTIONS`: added `MemoryTimelineProjection` to `PUBLIC` | H236 VIOLATED — "PUBLIC namespace did not refuse MemoryTimelineProjection"; the invariants suite went 14 pass / 0 fail → 10 pass / 4 fail | yes, green |
| 4 | `highlightProjectionPolicy.ts` `clampLocationToPrecision` case `CITY`: returned `row.location_name` | H241 VIOLATED — "CITY discloses location_name but the finer rung NEIGHBORHOOD does not"; invariants suite 11 pass / 3 fail | yes, green |
| 5 | `projectionRegistry.ts` `CompassMemoryProjection.build`: renamed `confidence_note` out of the whitelist | H243 VIOLATED, quoting the offending row with `"confidence_note":null` | yes, green |
| 6 | `episodeDetection.ts`: made the midnight crossing act rather than record | H253 BROKEN — "midnight forced a split: 2 episodes from a 30-minute gap" | yes, green |
| 7 | `derivativeRegistry.ts` `rebuildProjection`: disabled the REVOKED guard | H244 VIOLATED — "a rebuild arriving after a revocation resurrected the derivative" — while H247 stayed TOLERATED, which is the discrimination the two scenarios exist to provide | yes, green |
| 8 | `evidence.ts` `dedupeEvidence` pre-sort: reverted to `(fingerprint, source_id)`, i.e. the tree as it was | H245 BROKEN, exit 1, chaos suite 4 subtests red | restored, green |

**P24 — what would turn each green claim red.** Mutation 1 or 2 reappearing turns the
fixture rows red. Mutation 3 turns H236 red. Mutation 4 turns H241 red — and that one is
on a live route path. Mutation 5 turns H243 red. Mutation 6 turns H253 red. Mutation 7
turns H244 red. Mutation 8 turns H245 red. Beyond the mutations: **adding a thirteenth
fixture, renaming one, or editing §25 in the spec turns the fixture-list test red**,
because it reads the spec file rather than restating it; **making the report carry a
timestamp turns the replayability test red**; and **an invariant that quietly stops being
evaluated turns the status assertions red**, because this suite asserts the exact status
of all nine, `NO_SURFACE` included, rather than only "nothing violated".

#### Owner follow-up this pass opens

**`254e1876` is a pre-squash commit.** This repository squash-merges, so when this branch
lands the hash this census declares will be an ancestor of nothing and
`check:census-freshness` will report the document unreadable rather than checking it —
the `CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI` failure section A already records once. Whoever
merges must re-declare `head_commit` to the squash commit. This is not avoidable from
inside the branch; the squash hash does not exist yet.

### B.2 Row moves

Rows that already existed as parseable rows and whose verdict or evidence this pass
changed. The 154 rows that did not exist before are not "moves" and are in B.5.

| id | was | now | why |
|---|---|---|---|
| H205 | BBW | **BAC** | §23's `canReadMemory(userId, memoryId, surface)`. Section A's body says "**no `surface` parameter**, so one verdict serves the feed, the profile listing and the single fetch alike". That is no longer the code. `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:82#MemoryReadSurface` declares `MemoryReadSurface = "single" \| "profile" \| "trip" \| "public_feed"` (section C added a fifth, `"compass"`); `:90#canReadMemory` takes it; and `:106#public_feed` is the branch that makes it load-bearing — the public surface admits `visibility = 'public'` **before any relationship is consulted**, so a `custom` Memory whose allow-list contains the viewer is readable when addressed and absent from the global feed. All six call sites pass a surface. **CEILING, and it is why this is not a clean green:** the helper is module-private, and two other surfaces re-derive the rule instead of calling it — `routes/contentStamps.ts:451` and `routes/wellKnownShare.ts:523` both say in their own comments that they mirror it. One verdict now serves one route file, not the repository. |

Two more rows keep their verdict but were graded against code that has since changed, so
their **evidence is corrected here**. Neither is a move and neither changes a number.

- **H79** (public search must query a derivative, never canonical plus post-filtering) stays
  **BBW**, but not for section A.5's reason. A.5 says the feed is "still the service client
  over canonical `memories`, still `.limit()` before block filtering". The second half is no
  longer true: at `artifacts/api-server/src/routes/memories.ts:547#router.get` every privacy
  predicate — `state`, `visibility`, `hidden_user_ids`, the block set — now runs INSIDE the
  query and `LIMIT` applies to the already-filtered set, and a §18 `memory_public_feed`
  derivative path exists behind `memory_public_feed_projection_enabled`. What keeps it BBW is
  what A.5's first half says: the flag's migration is not in
  `production-applied-migrations.json`, so the served path is still a canonical read through
  the service client, not the derivative §10 asks for. The row is unchanged; the sentence
  under it was wrong.
- **H2** (automatic Memories private-first; publishing always a separate projection decision)
  stays **BBW**, but the body's evidence — `routes/stories.ts` "hard-codes `visibility:
  "public"` regardless of the source Story's audience" — is out of date. At
  `artifacts/api-server/src/routes/stories.ts:890#const` `resolveHighlightVisibilityForStory`
  refuses to promote any Story whose audience a Highlight cannot represent faithfully, with a
  409 and a stable reason, and writes nothing. The audience escalation is closed. What keeps
  H2 BBW is H93: a Highlight is still an independent row built from a client-supplied
  `mediaUrl`, so publishing is a separate ACTION but not a separate PROJECTION.

**No row in another lane's census moved.** This pass changed
`services/memoryProjections/evidence.ts`, five new files under
`services/memoryCertification/`, `src/scripts/checkMemoryCertification.ts`,
`guardRegistry.ts`, `package.json` and `run-all-checks.sh`. None of those appears in the
declared scope of `census-trips.md`, `census-sensing.md`, `census-telegraph.md` or
`census-layover.md` in `src/scripts/checkCensusFreshness.ts`, and none of them is cited by
those documents. `guardRegistry.ts` and `run-all-checks.sh` gained one entry each and lost
nothing.

### B.3 The ceiling

**What §25 being BUILT does and does not mean.**

1. **The harness drives the TypeScript layer, and nothing else.** `certificationClient` is
   an in-memory object graph, not a Postgres emulator. It enforces no RLS, no grant, no
   CHECK, no trigger. A certification pass is evidence about the engines, and it is
   evidence about nothing that lives in the database. Every unapplied migration —
   `2710`, `2711`, `2720`–`2724`, `2730` — is outside what it can see, and the module
   header says so.
2. **Seven of the nine invariants hold on code no route imports.** Only **H240** and
   **H241** sit on modules a route imports: `artifacts/api-server/src/routes/highlights.ts:24#import`
   pulls in the revocation service and `artifacts/api-server/src/routes/highlights.ts:128#function`
   is the §10 clamp applied to the feeds. The other seven are proved against `evidence.ts`,
   `projectionRegistry.ts`, `derivativeRegistry.ts` and `searchMemories.ts`, which
   `src/routes/`, `src/lib/` and `src/services/` still do not import. Every one of those
   outcomes carries a `CEILING:` clause naming that, and the invariants suite ASSERTS the
   clause is present — a guarantee that has never had an opportunity to hold has not held.
3. **The certification script does not make those engines reachable.** A check script is
   not a serving path. `H63`, `H64`, `H65`, `H110`–`H114` and the rest stay BBW for exactly
   the reason section A.2 gives, and importing them from `src/scripts/` does not change it.
4. **Even H241, which is on a live path, is a no-op in production.** `resolveLocationDisclosure`
   is called on the feeds, but `highlight_projection_policies` is migration `2721`,
   unapplied, so the read returns `absent`, the function reports `applied: false` with that
   reason, and no rung is ever clamped. The invariant is that the clamp cannot widen. It
   cannot; it also never runs.
5. **One invariant has no surface at all and is scored NOT-BUILT.** H238 ("rejected
   candidate cannot become a Highlight"): the rejection half is real and asserted, but
   nothing in this repository turns a candidate into a Highlight — `highlight_sources` is
   migration `2722`, unapplied, with no TypeScript writer, and `POST /highlights` inserts a
   client-supplied `mediaUrl`. The runner reports `NO_SURFACE`, the suite asserts that
   exact status at
   `artifacts/api-server/src/test/memoryCertificationInvariants.test.ts:117#reports`, and
   this census scores it **NB**. It is the one §25 row this pass did not move, and it is
   left visible on purpose.
6. **Two chaos scenarios are half-built and say so.** H249's edit half is certified against
   live code (`assertLifecycleTransition` runs on every PATCH regardless of the kernel
   flag) and its merge half does not exist; H252's re-resolution half is certified and its
   occurrence-time-display-text half cannot be, because `memories` has no
   `display_name_at_occurrence` column to preserve. Both are **BBW**, not BAC.
7. **The fixtures certify the engines; they do not certify the product.** A fixture that
   passes proves the engine behaves as §6/§7/§18 say. It proves nothing about
   `GET /memories`, `POST /highlights` or any other thing a user touches, except where a
   separate registered suite covers that surface — which is true for exactly two rows,
   H236 (`memoriesPublicFeedPrivacy.test.ts:234#describe`) and H240
   (`memoriesBlockFailClosed.test.ts:109#describe`).
8. **`check:all` is not CI-complete here.** Five checks in `run-all-checks.sh` exit 2 for
   want of live database credentials this pass must not supply:
   `check:write-path-columns`, `check:missing-live-columns`,
   `check:authorization-contract`, `check:media-objects`, `check:rank-events-surfaces`.
   They were exit-2 before this pass and are exit-2 after it.

### B.4 Prose → rows: which paragraph became which ids, and how the numbering was derived

Fourteen places in this document counted requirements in a paragraph or in a table whose
first column is not a requirement id. This is the map. **Nothing was renumbered**: the ids
below are the continuation of the body's own sequence, and they are forced. Two thirds of
them the body already names in its prose — H22–H37, H54–H62, H104–H114 and the ranges
`H115–H122` / `H123–H128` all appear there in so many words, they simply appear in
sentences rather than in rows. The rest (H130–H174 and H211–H266) the body never writes
down, and they are derived rather than invented: the "Denominator by section" table fixes
how many requirements each section carries, the body's ids run to H210, and applying the
section counts in order leaves exactly one possible id for every remaining requirement.
The allocation is reproducible by anyone with this document and the spec, and it lands on
266 exactly.

| Where the count lived | Shape it was in | Ids | Verdicts assigned in B.5 |
|---|---|---|---|
| §3.6 "Storage tables (16)" | one sentence: "Verdicts as tabulated in the 16-table section above" | H22–H37 | 3 BBW, 13 NB |
| §6 "Evidence normalization and eligibility (4)" | a paragraph naming H54–H57, revised by A.4 | H54–H57 | 4 BBW |
| §7 "Episode detection (5)" | a paragraph naming H58–H62, revised by A.4 | H58–H62 | 5 BBW |
| §13 "Memory graph and compression (3)" | a paragraph naming H104–H106, revised by A.4 | H104–H106 | 3 BBW |
| §14 "Executable memories (3)" | a paragraph naming H107–H109 | H107–H109 | 3 NB |
| §15 "Retrieval (5)" | a paragraph naming H110–H114, revised by A.4 | H110–H114 | 5 BBW |
| §16 Compass contract | a table whose id cells read `H115–H122` and `H123–H128` — ranges, not ids | H115–H128 | 14 NB |
| §17 "Command bus and domain events (33)" | three paragraphs listing commands and events inline | H130–H162 | 20 BBW, 13 NB |
| §18 "Projections and derived-artifact registry (12)" | a table keyed by projection NAME, with no id column | H163–H174 | 10 BBW, 2 NB |
| §22 "Migration (4)" | a paragraph; H197 alone already had a row | H194–H196 | 3 NB |
| §24 "Observability (13)" | a paragraph listing twelve metric names, plus an `H(log fields)` pseudo-id | H211–H223 | 1 BBW, 12 NB |
| §25 "Replay, testing and certification (30)" | two paragraphs and one table with an `Invariant` column instead of an id column | H224–H253 | 22 BAC, 7 BBW, 1 NB |
| §26 "Delivery phases (8)" | a table keyed by phase name | H254–H261 | 7 BBW, 1 NB |
| §28 "Developer invariants (5)" | a table whose id cells read `§28.3`, `§28.10`, … | H262–H266 | 2 BAC, 3 NB |

**Totals for the 154: 24 BAC · 65 BBW · 65 NB · 0 CV.**

Three notes on the allocation, so nobody has to reverse-engineer it:

- **§16 gets 15 ids (H115–H129), not 14.** H129 already had a row. The 14 new ones are the
  eight Compass memory tools and the six LLM-boundary rules.
- **§17's 33 is the body's own count and it is one more than the spec's names.** §17 lists
  seventeen commands and **thirteen** domain events; the body's "Domain events (14)" is an
  off-by-one. To keep the denominator at 266 without re-scoping, the section's final
  sentence — *"Use an outbox pattern: canonical mutation and event-outbox insert occur in
  one database transaction. Consumers must be idempotent and may rebuild disposable
  projections asynchronously"* (`docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:511`)
  — is read as the three checkable requirements it plainly contains: **H160** the atomic
  outbox write, **H161** idempotent consumers, **H162** asynchronous rebuild of disposable
  projections. 17 + 13 + 3 = 33. The body's own pseudo-ids `H(outbox)` and
  `H(idempotent consumers)` are H160 and H161.
- **A written migration is not a table, and that rule is applied to §3.6 unchanged.**
  Section A.5 states it and this pass keeps it: `memory_event_outbox`,
  `memory_derivative_registry`, `highlight_sources` and the rest are NB even though each
  has a written migration, because §3.6's requirement IS the storage. This is the opposite
  of A.2's rule for CODE, and deliberately so: code that degrades honestly when its table
  is absent is built; a table that does not exist is not.

### B.5 The 154 rows

#### §3.6 Storage tables (H22–H37)

Checked against `artifacts/api-server/src/lib/capability/snapshots/20260908-production-schema.json`
(442 tables, watermark `20260908133347`) and against every `CREATE TABLE` in
`artifacts/api-server/src/migrations/`. Fourteen of the sixteen names are absent from
production; the two that are present are name collisions with divergent schemas.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H22 | `memories` — canonical durable user Memories | BBW | Present, and a different object. `docs/migrations/0067_memories.sql:7#CREATE` has `title/caption/visibility/allowed_user_ids/hidden_user_ids/trip_id/event_id/place_id/starts_at/ends_at/state`. It has none of §3.1's `occurred_at`, `ended_at`, `occurred_timezone`, `memory_type`, `lifecycle_state`, `source_mode`, `significance_score`, `confidence_band`, `location_precision`, `current_version` |
| H23 | `memory_episodes` — detected or confirmed episodes | NB | No `CREATE TABLE` for it anywhere in `artifacts/api-server/src/migrations/`; absent from the production snapshot. The only version is unmerged PR #470 |
| H24 | `memory_evidence` — assertion-level provenance and confidence | NB | Same: no migration in this tree, absent from the snapshot |
| H25 | `memory_media_links` — many-to-many links to media assets | BBW | No table of this name. `media_attachments` is a genuine M:N media↔entity link and its entity-type union includes `"memory"` (`artifacts/api-server/src/lib/mediaAssets.ts:718#ATTACHMENT_ENTITY_TYPES`, the member at `:721`), but the only writer that passes that type is `artifacts/api-server/src/services/passport/PassportMemoryService.ts:140#entityType`, which links a `passport_memories` suggestion. A Memory's media is `memory_items`, a 1:N table of client-supplied URLs |
| H26 | `memory_entity_links` — people/place/trip/event relations | NB | Zero occurrences. `memories` carries scalar `trip_id`/`event_id`/`place_id`; `memory_tags` is people-only |
| H27 | `memory_relations` — Memory-to-Memory graph edges | NB | Zero occurrences in any `.sql` in the tree. `artifacts/api-server/src/lib/memoryCommandBus.ts:306#MEMORY_COMMAND_TYPES_NOT_DECLARED` names its absence as the reason MERGE_MEMORY is not a command |
| H28 | `memory_corrections` — authoritative user corrections and negative constraints | NB | Zero occurrences |
| H29 | `memory_commands` — command receipt / idempotency ledger | NB | Written as `memory_command_receipts` at `artifacts/api-server/src/migrations/2710_memory_command_kernel_tables.sql:213#CREATE`, which is **not applied**: 2710 is absent from `production-applied-migrations.json` and no such table is in the schema snapshot. A written migration is not a table |
| H30 | `memory_event_outbox` — transactional domain-event outbox | NB | Written at `artifacts/api-server/src/migrations/2710_memory_command_kernel_tables.sql:191#CREATE`, unapplied, absent from the snapshot |
| H31 | `highlights` — canonical Highlight projection definitions | BBW | Present, and a different object. `artifacts/api-server/src/migrations/0026_highlights.sql:8#CREATE` is a 24-hour Stories row: `media_url/caption/visibility/expires_at/deleted_at`. None of §3.5's `source_memory_ids`, `highlight_type`, `lifetime_class`, `lifecycle_state`, `ranking_score`, `reason_codes`, `audience_policy_id`, `presentation_json`, `renderer_version` |
| H32 | `highlight_sources` — links Highlights to Memories/Episodes | NB | Written at `artifacts/api-server/src/migrations/2722_highlight_sources.sql:61#CREATE`, unapplied, and with no TypeScript writer. This is the link that would make a Highlight a projection over a Memory |
| H33 | `memory_visibility_policies` — audience and location precision policy | NB | No table of this name. `highlight_projection_policies` (`artifacts/api-server/src/migrations/2721_highlight_projection_policies.sql:83#CREATE`) is a Highlight-scoped substitute and is unapplied |
| H34 | `memory_derivative_registry` — search embeddings, projections, derivatives | NB | Written at `artifacts/api-server/src/migrations/2730_memory_derivative_registry.sql:77#CREATE`, unapplied, absent from the snapshot |
| H35 | `memory_snapshots` — versioned fact/evidence snapshots for replay | NB | Zero occurrences. §25's replay is implemented in this pass as a deterministic in-memory harness, which is not storage |
| H36 | `memory_resurfacing_preferences` — do-not-resurface and related controls | NB | No table of this name. `highlight_resurfacing_preferences` (`artifacts/api-server/src/migrations/2720_highlight_resurfacing_preferences.sql:77#CREATE`) is a Highlight-scoped substitute and is unapplied |
| H37 | `memory_import_batches` — explicit historical import/backfill jobs | NB | Zero occurrences; no backfill code of any kind exists |

#### §6 Evidence normalization and eligibility (H54–H57)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H54 | Normalization pipeline: raw signal → normalized source and time | BBW | `artifacts/api-server/src/services/memoryProjections/evidence.ts:246#normalizeEvidence` refuses rather than repairs — an unparseable or future `observed_at` is a rejection, not `now` — normalizes to UTC, clamps producer confidence to the source ceiling and emits a minute-bucketed fingerprint. Reachable from no route, and `memory_evidence` (H24) does not exist to hold the output |
| H55 | Eligibility gate before candidate generation | BBW | `artifacts/api-server/src/services/memoryProjections/evidence.ts:466#evaluateEligibility`, with a fixed check order so two runs return the same reason. Certified end to end by §25 this pass; still test-and-script-only |
| H56 | Rejection-reason registry | BBW | `artifacts/api-server/src/services/memoryProjections/evidence.ts:422#ELIGIBILITY_REJECTION_REASONS` is §6's closed set in the spec's order; the normalizer carries its own at `:192`. Nothing stores a reason because nothing stores a candidate |
| H57 | Evidence-source strength model | BBW | `artifacts/api-server/src/services/memoryProjections/evidence.ts:114#EVIDENCE_SOURCE_STRENGTH` gives every source a truth level, a confidence ceiling, `proves_occurrence_alone` and §6's caveat text. It is the field the pass-by and planned-only refusals turn on. Unreachable from any route |

#### §7 Episode detection (H58–H62)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H58 | Deterministic, replayable grouping | BBW | `artifacts/api-server/src/services/memoryProjections/episodeDetection.ts:244#detectEpisodes` sorts its input before deciding anything, reads no clock and emits digest ids. §25's `OUT_OF_ORDER_EVIDENCE` scenario now proves three delivery orders produce byte-identical results. No detector input exists: `memory_evidence` is absent |
| H59 | Boundary features | BBW | `artifacts/api-server/src/services/memoryProjections/episodeDetection.ts:46#BOUNDARY_FEATURES`, each with a threshold in `DEFAULT_THRESHOLDS` and each recorded per boundary with the gap and distance that produced it |
| H60 | Midnight must not force a split | BBW | Implemented rather than commented: `artifacts/api-server/src/services/memoryProjections/episodeDetection.ts:233#crossesMidnightUtc` computes the crossing, records it on the boundary, and no branch reads it. §25's `TIMEZONE_AND_DATE_LINE_EDGES` proves a 30-minute gap across UTC midnight groups identically to the same gap at midday, and mutation 6 above turned it red |
| H61 | Versioned candidate reason-code registry | BBW | `artifacts/api-server/src/services/memoryProjections/episodeDetection.ts:71#EPISODE_REASON_CODES` under `:32#EPISODE_DETECTOR_VERSION`. No candidate is stored, so no reason code is ever persisted |
| H62 | Dedup relationships between episodes | BBW | `artifacts/api-server/src/services/memoryProjections/episodeDetection.ts:375#relateEpisodes` returns SAME_EPISODE / POSSIBLE_DUPLICATE / RELATED / CONTAINS. `memory_relations` (H27) does not exist to record one |

#### §13 Memory graph and compression (H104–H106)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H104 | Compression hierarchy SIGNAL→MOMENT→EPISODE→DAY→TRIP→SEASON→LIFE CHAPTER | BBW | `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:41#COMPRESSION_LEVELS` and `:246#buildCompressionHierarchy`. Test-only; nothing stores a level |
| H105 | Life Chapters are projections, not duplicated Memories | BBW | `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:227#buildLifeChapters` emits ids, counts and a derived label — no caption and no media is copied upward, which is the §28.8 rule. Unreachable |
| H106 | Relationship edge types | BBW | `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:58#MEMORY_RELATION_TYPES` is §4's nine, with a validated edge shape at `:64`. No `memory_relations` table |

#### §14 Executable memories (H107–H109)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H107 | Do-again compiled through current-world / Temporal-Freedom engines | NB | A repository-wide grep for `doAgain`, `do_again`, `takeMeBack` and `take_me_back` across `artifacts/` and `travel-buddy-standalone/` in `.ts`, `.tsx` and `.sql` returns nothing at all — not a fixture, not a comment |
| H108 | The eight executable actions | NB | Same grep. `add_to_trip` (`artifacts/api-server/src/compass/CompassTools.ts:421#add_to_trip`) adds a PLACE to a trip and knows nothing about a Memory |
| H109 | Historical / current fusion invariant | NB | No fusion path exists. The nearest artifact is the honesty note §25 now certifies (H243), which asserts the opposite direction: a historical fact must not be read as current |

#### §15 Retrieval (H110–H114)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H110 | `searchMemories(...)` signature | BBW | `artifacts/api-server/src/services/memoryRetrieval/searchMemories.ts:169#searchMemories` takes §15's parameter set and returns a discriminated result. No route imports the module |
| H111 | Graph and deterministic index before semantic | BBW | Deterministic filters decide membership and `semanticQuery` may only reorder what they selected; the default scorer is token overlap and no model is called. Unreachable |
| H112 | Ranking dimensions | BBW | `artifacts/api-server/src/services/memoryRetrieval/searchMemories.ts:65#RANKING_WEIGHTS` is §15's seven, with `privacy_eligibility` as a gate rather than a weight |
| H113 | Hard namespace isolation (private / shared-crew / public) | BBW | `artifacts/api-server/src/services/memoryRetrieval/searchMemories.ts:49#NAMESPACE_PROJECTIONS` is checked on the way IN, and §25's H236 invariant now proves a PUBLIC request for an owner-private projection is refused before any read happens. Still unreachable from a route, which is why this is BBW and H236 is not |
| H114 | Privacy changes revoke searchable derivatives and embeddings | BBW | `artifacts/api-server/src/services/memoryProjections/derivativeRegistry.ts:464#revokeDerivativesForMemory` walks the cleanup graph and empties the payload; reading a revoked derivative refuses with `derivative_revoked` rather than an empty page. The registry table is 2730, unapplied, and there are no embeddings anywhere in the repository to revoke |

#### §16 Compass contract (H115–H128)

`artifacts/api-server/src/compass/CompassTools.ts:113#get_user_profile` opens a list of **eleven** tools —
`get_user_profile`, `get_current_trip`, `search_places`, `search_events`,
`get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`,
`get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`. Not one is
memory-facing, so there is no memory-facing LLM path for §16's six boundary rules to
constrain either.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H115 | `getMemory` | NB | Not in the eleven tools at `artifacts/api-server/src/compass/CompassTools.ts:113#get_user_profile` |
| H116 | `searchMemories` (Compass tool) | NB | Same. `services/memoryRetrieval/searchMemories.ts` exists and Compass cannot reach it |
| H117 | `getSharedMemories` | NB | Same |
| H118 | `getPlaceHistory` | NB | Same. `PlaceMemoryProjection` exists in the registry with `visit_index`; no tool reads it |
| H119 | `getTripMemories` | NB | Same |
| H120 | `getMemoryEvidence` | NB | Same, and there is no evidence store to read |
| H121 | `createMemoryDraft` | NB | Same. The tool set contains no Memory mutation at all |
| H122 | `suggestMemoryCorrection` | NB | Same |
| H123 | LLM may summarize supported evidence | NB | No memory-facing LLM path exists to permit or constrain |
| H124 | LLM may propose merge / split / correction | NB | Same, and MERGE_MEMORY / SPLIT_MEMORY are undeclared commands (`artifacts/api-server/src/lib/memoryCommandBus.ts:306#MEMORY_COMMAND_TYPES_NOT_DECLARED`) |
| H125 | LLM may ask a minimal clarifying question | NB | Same |
| H126 | LLM may not invent states, participants, identity, attendance or outcomes | NB | Prohibition graded on the surface where a violation would live (rule 7). That surface does not exist, so this is NOT-BUILT rather than assumed-satisfied |
| H127 | LLM may not bypass privacy policy | NB | Same |
| H128 | LLM may not use stale history as current truth | NB | Same. The one artifact pointing this way is `CompassMemoryProjection`'s `confidence_note`, which no Compass tool reads (H243) |

#### §17 Command bus and domain events (H130–H162)

Eleven of §17's seventeen commands are declared at
`artifacts/api-server/src/lib/memoryCommandBus.ts:281#MEMORY_COMMAND_TYPES` and dispatched
through `artifacts/api-server/src/services/memory/MemoryDomainService.ts:354#dispatchMemoryCommand`;
the other six are listed with their reasons at `:306#MEMORY_COMMAND_TYPES_NOT_DECLARED`.
**Every declared command is BBW for one shared reason** and it is not repeated in each row:
the durable receipt, the audit row and the event emit all live in `memory_kernel_execute`,
migrations 2710 and 2711, which are **not applied** — the postcondition at
`artifacts/api-server/src/migrations/2711_memory_kernel_execute.sql:554#IF` even asserts the
flag is still false — so `memory_kernel_enabled` has no row, `isFlagEnabled` is fail-closed,
and each write is the legacy direct write with a log line marked `durable:false`
(`artifacts/api-server/src/services/memory/MemoryDomainService.ts:121#auditCommand`).

| id | requirement | verdict | evidence |
|---|---|---|---|
| H130 | `CREATE_MEMORY` crosses a command boundary | BBW | Declared; `POST /memories` dispatches it. No durable receipt (2710 unapplied) |
| H131 | `CONFIRM_MEMORY` | BBW | Declared and mapped to `memory.confirmed`; the PATCH route issues it for `state: "published"` |
| H132 | `ARCHIVE_MEMORY` | BBW | Declared; the lifecycle guard at `artifacts/api-server/src/lib/memoryCommandBus.ts:253#assertLifecycleTransition` runs on it in production regardless of the kernel flag |
| H133 | `DELETE_MEMORY` | BBW | Declared; a soft delete. §21's five-step deletion lifecycle does not exist |
| H134 | `MERGE_MEMORY` | NB | Explicitly not declared: "no memory_relations table (§3.4) and no version chain to merge into" (`artifacts/api-server/src/lib/memoryCommandBus.ts:306#MEMORY_COMMAND_TYPES_NOT_DECLARED`) |
| H135 | `SPLIT_MEMORY` | NB | Same list, same file: "nothing to split a Memory's evidence between" |
| H136 | `ADD_MEDIA` | BBW | Declared and dispatched by `POST /memories/:id/items` |
| H137 | `REMOVE_MEDIA` | BBW | Declared; the storage delete stays outside the command deliberately |
| H138 | `ADD_PERSON` | BBW | Declared; authorized as consent — the tagged person only — at `artifacts/api-server/src/services/memory/MemoryDomainService.ts:295#authorizeParticipantCommand` |
| H139 | `REMOVE_PERSON` | BBW | Declared; owner **or** the tagged person, same function. The body's complaint that the owner could not remove a tag no longer holds |
| H140 | `CHANGE_PLACE` | BBW | Declared, and selected by `commandTypeForPatch` precisely so a place edit is countable — the §24 metric `place_correction_rate` that would count it does not exist (H215) |
| H141 | `CHANGE_VISIBILITY` | BBW | Declared and mapped to `memory.visibility_changed` |
| H142 | `PIN_HIGHLIGHT` | NB | Not declared ("routes/highlights.ts is owned by another lane"), no pin column in production, no pin route, no pin in the client. `artifacts/api-server/src/migrations/2723_highlight_class_lifecycle_and_pin.sql:7#pinned_at` would add one and is unapplied |
| H143 | `UNPIN_HIGHLIGHT` | NB | Same |
| H144 | `PUBLISH_HIGHLIGHT` | BBW | An ad-hoc REST write with no command boundary, no idempotency key, no audit row and no outbox insert: `artifacts/api-server/src/routes/stories.ts:890#const` decides the audience and the insert follows. It is genuinely better than the body describes — the audience can no longer be widened — but the requirement is the boundary, not the verb |
| H145 | `HIDE_HIGHLIGHT` | BBW | A reversible archive now exists on a column production has (`highlights.archived_at`, projected at `artifacts/api-server/src/routes/highlights.ts:52#archived_at`, and the three list reads filter it), so the body's "a soft delete, not a reversible hide" is out of date. Still no command boundary |
| H146 | `SET_RESURFACING_POLICY` | NB | Not declared: "no resurfacing-policy storage exists". `highlight_resurfacing_preferences` is 2720, unapplied |
| H147 | `memory.created` | BBW | Declared verbatim at `artifacts/api-server/src/lib/memoryOutbox.ts:114#MEMORY_EVENT_TYPES` and mapped from CREATE_MEMORY. **Never emitted**: the emit is inside 2711 |
| H148 | `memory.confirmed` | BBW | Declared and mapped from CONFIRM_MEMORY. Never emitted |
| H149 | `memory.corrected` | BBW | Declared and mapped from ADD_MEDIA / REMOVE_MEDIA / ADD_PERSON / REMOVE_PERSON / CHANGE_PLACE / UPDATE_MEMORY. Never emitted |
| H150 | `memory.merged` | NB | The name is in the union and no command maps to it, because MERGE_MEMORY is not declared. A name nothing can emit is a vocabulary entry, not an event |
| H151 | `memory.split` | NB | Same |
| H152 | `memory.archived` | BBW | Declared and mapped from ARCHIVE_MEMORY. Never emitted |
| H153 | `memory.deleted` | BBW | Declared and mapped from DELETE_MEMORY. Never emitted |
| H154 | `memory.visibility_changed` | BBW | Declared and mapped from CHANGE_VISIBILITY. Never emitted |
| H155 | `highlight.created` | NB | In the union; no command maps to it and no Highlight write path emits anything |
| H156 | `highlight.published` | NB | Same |
| H157 | `highlight.expired` | NB | Same, and expiry is a read-time filter rather than an event |
| H158 | `highlight.pinned` | NB | Same, and there is no pin |
| H159 | `highlight.hidden` | NB | Same |
| H160 | Transactional outbox: canonical mutation and outbox insert in one transaction | BBW | `artifacts/api-server/src/lib/memoryOutbox.ts:146#MEMORY_OUTBOX_TABLE` fixes the payload and ordering contract and the module documents four measured properties of the applied-to-CI schema. The atomic write itself is 2710/2711 SQL, unapplied, so no outbox row has ever been written in production |
| H161 | Consumers must be idempotent | NB | There are no consumers. `memoryOutbox.ts` records that `published_at`, `attempts` and `last_error` are columns no code writes |
| H162 | Consumers may rebuild disposable projections asynchronously | BBW | The rebuild exists and is idempotent — `artifacts/api-server/src/services/memoryProjections/derivativeRegistry.ts:287#rebuildProjection`, proved replay-safe by §25's H244 — but nothing consumes an event to call it |

#### §18 Projections and derived-artifact registry (H163–H174)

All eleven of §18's names are defined in one registry,
`artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:501#PROJECTION_DEFINITIONS`,
each with an audience, a destination, a builder version and a field whitelist that is what
actually enforces disclosure. `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:159#function`
is the shared owner filter: it drops `deleted` and `removed`. **No route, lib or service
outside `src/test/` and `src/services/memoryCertification/` imports the registry**, so every
row below is BBW or NB, never BAC.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H163 | MemoryTimelineProjection — owner private timeline | BBW | Defined in the registry and unreachable. What ships is `travel-buddy-standalone/src/lib/memoryTimeline.ts:2#memoryTimeline`, a pure CLIENT-side month grouping over `passport_memories` that declares itself Passport §15 — not a server projection and not over Memories |
| H164 | PassportMemoryProjection | BBW | Defined in the registry. The shipped artifact is `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:19#Discovery`, which projects Passport artefacts to four consumers, not Memories |
| H165 | ProfileHighlightProjection — audience-specific profile | BBW | Defined, with a viewer-aware filter and a seven-field whitelist. `routes/highlights.ts` still returns raw highlight rows filtered by viewer permission; no audience-specific narrowing |
| H166 | TripMemoryProjection — trip recap | BBW | Defined and scoped by `trip_id`. `GET /trips/:tripId/memory` returns a raw list |
| H167 | PlaceMemoryProjection — owner's history at a place | BBW | Defined, and it computes `visit_index`. §25's `ENTITY_MERGE_AFTER_MEMORY_CREATION` now exercises it across a canonical-place merge. Unreachable |
| H168 | PeopleMemoryProjection — shared-history view | BBW | Defined, and it requires an APPROVED tag: a pending or removed tag is not a shared experience. Unreachable |
| H169 | CompassMemoryProjection — minimal authorized retrieval facts | BBW | Defined at `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:392#id`, structure and identity only, every row carrying a historical qualifier. No Compass tool reads it |
| H170 | PublicMemoryProjection — public social/search surfaces | BBW | Defined at `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:415#id` with an eight-field whitelist that cannot carry a coordinate or a significance figure. A second, different public derivative exists as the `memory_public_feed` RPC behind `memory_public_feed_projection_enabled`, whose migration is not in the applied list — so the feed serves canonical rows (H79) |
| H171 | SearchEmbedding — namespace-scoped retrieval | NB | Declared `NOT_CONFIGURED` at `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:443#id` with the honest reason that no embedding backend exists, and its builder returns `[]`. Declaring a projection a database cannot hold is not building it — the same rule A.5 applies to H94–H98 |
| H172 | NarrativeDerivative — optional AI summary | NB | Declared `NOT_CONFIGURED` at `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:457#id`; builder returns `[]`; no narrator is wired |
| H173 | MapTrailDerivative — spatial presentation | BBW | Defined in the registry with an owner-only exact coordinate and a coarsened one for everyone else. The shipped artifact is `artifacts/api-server/src/lib/mapProducers/memoryProducer.ts:13#memory_remembers_for_user`, which emits viewer-scoped map objects from derived preferences, not from Memories |
| H174 | Every derivative registered with source Memory version, type, destination, generatedAt and revocation state | BBW | `artifacts/api-server/src/services/memoryProjections/derivativeRegistry.ts:252#RegistrationRow` is exactly those fields plus the per-memory version vector staleness needs; `:409#projectionStaleness` and `:464#revokeDerivativesForMemory` are the cleanup graph. The table is 2730, unapplied |

#### §22 Migration from existing Highlights / Memories (H194–H196)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H194 | No big-bang; stable IDs and URLs across the migration | NB | No migration to the spec's model has been started, so there is nothing to keep stable across one. The canonical tables are still `0067`'s and `0026`'s |
| H195 | Legacy rows imported as `LEGACY_IMPORTED` with conservative confidence | NB | A repository-wide grep for `LEGACY_IMPORTED` and for `source_mode` across `.ts` and `.sql` returns nothing. §4's `MemorySourceMode` has no column (H39) |
| H196 | Dual-read shadow comparison, then cutover | NB | No shadow read exists on any memory surface. The nearest thing in the tree is the two-path public feed, which is a flag choosing one path, not a comparison of two |

#### §24 Observability and quality metrics (H211–H223)

**Every one of the twelve names was grepped across the whole worktree, excluding
`node_modules` and `.git`.** Ten of the twelve occur in exactly two files — this census and
`docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt` — and nowhere
in any source file. The other two occur in COMMENTS only: `place_correction_rate` at
`artifacts/api-server/src/services/memory/MemoryDomainService.ts:148#place_correction_rate`
and again at `artifacts/api-server/src/routes/memories.ts:902#place_correction_rate`, both
explaining why CHANGE_PLACE is a distinct command; and `projection_lag` at
`artifacts/api-server/src/lib/memoryOutbox.ts:233#projection_lag`, plus the different token
`projection_lag_seconds` in a comment at
`artifacts/api-server/src/server/trips/outboxWorker.ts:41#projection_lag_seconds`, which
belongs to the Trips map worker and is not this metric. Nothing counts, records, exports or
alerts on any of the twelve.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H211 | `candidate_confirm_rate` | NB | Occurs only in this census and the spec; no source file mentions it. There is no candidate to confirm |
| H212 | `candidate_reject_rate` | NB | Occurs only in this census and the spec. `evaluateEligibility` produces a rejection reason and nothing counts one |
| H213 | `candidate_split_rate` | NB | Occurs only in this census and the spec; SPLIT_MEMORY is an undeclared command |
| H214 | `candidate_merge_rate` | NB | Occurs only in this census and the spec; MERGE_MEMORY is an undeclared command |
| H215 | `place_correction_rate` | NB | Named in two comments — `artifacts/api-server/src/services/memory/MemoryDomainService.ts:148#place_correction_rate` and `artifacts/api-server/src/routes/memories.ts:902#place_correction_rate` — both saying the command exists so the metric COULD be counted. No counter is incremented anywhere |
| H216 | `participant_correction_rate` | NB | Occurs only in this census and the spec. ADD_PERSON / REMOVE_PERSON are dispatched and counted by nothing |
| H217 | `false_memory_rate` | NB | Occurs only in this census and the spec. It is corrected-over-surfaced inferred assertions, and neither quantity is stored anywhere |
| H218 | `explicit_memory_without_candidate_rate` | NB | Occurs only in this census and the spec |
| H219 | `privacy_revocation_latency` | NB | Occurs only in this census and the spec. `executeRevocation` produces a per-destination report and no timing at all (`artifacts/api-server/src/services/highlights/highlightRevocation.ts:168#REVOCATION_DESTINATIONS`) |
| H220 | `projection_lag` | NB | Named in one comment, `artifacts/api-server/src/lib/memoryOutbox.ts:233#projection_lag`. `projectionStaleness` answers FRESH / STALE / REVOKED / NOT_REGISTERED and emits no lag figure. The `projection_lag_seconds` in `artifacts/api-server/src/server/trips/outboxWorker.ts:41#projection_lag_seconds` is the Trips map worker's, not this one |
| H221 | `resurfacing_suppression_violations` ("must be zero") | NB | Occurs only in this census and the spec. Nothing counts a violation, and with 2720 unapplied the suppression set is `absent`, so a violation could not be DETECTED if it happened — the metric §24 says must be zero is one nothing could observe being non-zero |
| H222 | `do_again_conversion` | NB | Occurs only in this census and the spec, and there is no do-again to convert (H107) |
| H223 | Operational logs carry memoryId, commandId, eventId, source version, engine version, reason codes, projection name, failure class | BBW | `artifacts/api-server/src/services/memory/MemoryDomainService.ts:121#auditCommand` emits `memoryId`, `commandId`, `eventId`, `reason` and `engineVersion` (`:131#engineVersion`), and deliberately nothing from the Memory's body. **Three of the eight are missing**: source version, projection name and failure class. `eventId` is always null while the kernel is off |

#### §25 Replay, testing and certification (H224–H253)

The verdicts below apply one rule, stated once. **A fixture and a chaos scenario are TEST
artifacts: §25 asks for them to exist, be deterministic and be exercised, so one that does
all three is BAC.** An invariant asserts a SYSTEM property, so it is BAC only when the
property is proved on a path production serves — either the module is imported by a route,
or a separate registered suite covers the live surface — BBW when it holds only on code no
route imports, and NB when there is no surface at all. Applying that rule and no other
gives 22 BAC, 7 BBW, 1 NB.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H224 | Fixture: solo Trip with photos and explicit Remember | **BAC** | `artifacts/api-server/src/services/memoryCertification/fixtures.ts:42#CERTIFICATION_FIXTURE_IDS` entry 1. Certified: 3 signals normalize, eligible with no reason, 1 episode, 1 public row. Mutation 1 turned it red |
| H225 | Fixture: crew Trip with shared and private assets | **BAC** | Entry 2. Certified: eligible, 1 episode, and — the half that matters — **zero** public rows, because `trip_crew` and `only_me` reach no public derivative. Paired control (crew overlap alone) correctly refused. Mutation 1 turned it red |
| H226 | Fixture: late media upload after Trip ends | **BAC** | Entry 3. `observed_at` is the capture instant during the trip, not the upload six days later; certified eligible, 1 episode, 1 public row whose `occurred_at` follows `starts_at` rather than `created_at` |
| H227 | Fixture: incorrect GPS and explicit place correction | **BAC** | Entry 4. Certified: eligible, **3** episodes (475- and 840-minute gaps against §7's 180-minute floor), 1 public row. The correction carries a deliberately low confidence so H242 tests precedence and not score |
| H228 | Fixture: merge two Memories then split differently | **BAC** | Entry 5. Certified: two captures 39 minutes and 100 metres apart group as ONE episode under §7's thresholds, which is exactly the world a merge/split test needs. The commands to merge and split it do not exist, and H249 says so |
| H229 | Fixture: blocked participant after shared experience | **BAC** | Entry 6. Certified: CREW_OVERLAP alone is refused with `INSUFFICIENT_OCCURRENCE_EVIDENCE` — being near someone is not a Memory — while the paired control (overlap plus a capture) is eligible. The Memory that does exist stays public: §10 forbids new resurfacing, not history |
| H230 | Fixture: public-to-private revocation | **BAC** | Entry 7 certifies the derivative half, and the LIVE half was already covered before this pass by `artifacts/api-server/src/test/memoriesPublicFeedPrivacy.test.ts:328#describe`, a §25-labelled fixture over the real `GET /memories` route. Both halves now run in CI |
| H231 | Fixture: Memory deletion with embeddings and Highlight derivatives | **BAC** | Entry 8. Certified: the cleanup graph revokes exactly the registration carrying the deleted Memory and leaves the survivor's alone. **There are no embeddings in this repository to purge** — the fixture's name promises more than the tree can hold, and the H237 outcome says so |
| H232 | Fixture: imported historical trip with weak metadata | **BAC** | Entry 9. Certified: a scan with `imported_without_capture` provenance is refused with `MEDIA_NOT_CAPTURED`, and the same scan re-declared as a camera capture is eligible. That is §22's "never fabricate a visit during backfill", made executable |
| H233 | Fixture: no-photo Memory from voice note + completed plan | **BAC** | Entry 10. Certified eligible with zero media: a completed TRIP_OUTCOME and an EXPLICIT_REMEMBER both prove occurrence alone. The case a media-shaped pipeline drops |
| H234 | Fixture: walk-past venue that must not become a visit | **BAC** | Entry 11. Certified: the day as a whole is eligible (a ticketed visit), 2 episodes, and the paired control — the 90-second proximity ALONE — is refused with `PASS_BY_NOT_VISIT` |
| H235 | Fixture: downloaded screenshot that must not become experienced content | **BAC** | Entry 12. Certified refused with `MEDIA_NOT_CAPTURED`; the same image re-declared as a camera capture is eligible, so the gate reads provenance rather than counting media. Mutation 2 turned it red |
| H236 | Invariant: PRIVATE memory cannot appear in public search | **BAC** | Two surfaces, both in CI. The derivative path: HELD, `PublicMemoryProjection` emits only the published-and-public row (only_me, custom-with-allow-list, draft and deleted all absent) and the PUBLIC namespace refuses an owner-private projection on the way in. The LIVE path: `artifacts/api-server/src/test/memoriesPublicFeedPrivacy.test.ts:234#describe` asserts the same property on the real `GET /memories`, including that a `custom` Memory whose allow-list contains the viewer stays out of the global feed. Mutations 1 and 3 each turned it red |
| H237 | Invariant: deleted memory cannot remain in Compass retrieval | BBW | HELD on the only Compass-facing memory artifact that exists: the deleted Memory leaves `CompassMemoryProjection`, its registration is revoked with an emptied payload, and reading the revoked derivative refuses with `derivative_revoked` rather than returning an empty page. **BBW because the named surface does not exist** — `artifacts/api-server/src/compass/CompassTools.ts:113#get_user_profile` declares no memory tool |
| H238 | Invariant: rejected candidate cannot become a Highlight | NB | `NO_SURFACE`. The rejection half is real and asserted; the second half has nothing to assert against, because nothing turns a candidate into a Highlight — `highlight_sources` is 2722, unapplied, with no writer, and `POST /highlights` inserts a client-supplied `mediaUrl`. The suite asserts this exact status at `artifacts/api-server/src/test/memoryCertificationInvariants.test.ts:117#reports` so it can never drift into looking like a pass |
| H239 | Invariant: planned activity without occurrence cannot earn a visit Memory/Stamp | BBW | HELD: PLANNED+SAVED alone is refused with `PLANNED_OR_SAVED_ONLY` and the same set plus one OCCURRED record is eligible, so the refusal is the intent rule and not a blanket deny. BBW because it is proved on `evidence.ts`, which no route imports; the live stamp path enforces the rule by requiring a real check-in (H4) and is not covered by this test |
| H240 | Invariant: blocked person cannot be newly resurfaced through shared-memory recommendations | **BAC** | HELD on a module a route imports, and the live half was already covered: `HIDE_PERSON_FROM_RESURFACING` suppresses exactly its subject across proactive resurfacing and recap, does not leak to another participant, and an UNREADABLE preference set suppresses rather than serving. `artifacts/api-server/src/test/memoriesBlockFailClosed.test.ts:109#describe` covers the live feed's fail-closed block filter. **Ceiling: 2720 is unapplied, so in production the set is `absent` and suppresses nothing** |
| H241 | Invariant: public location precision cannot exceed owner policy | **BAC** | HELD over the whole ladder: the disclosed field set is monotone toward HIDDEN, HIDDEN discloses nothing, `strictestPrecision` can only tighten, and both an unreadable policy row and an unparseable one clamp to HIDDEN. The module is imported by `artifacts/api-server/src/routes/highlights.ts:128#function`. Mutation 4 turned it red. **Ceiling: 2721 is unapplied, so no rung is ever stored and the clamp never runs** |
| H242 | Invariant: user correction cannot be overwritten by weaker inference | BBW | HELD: a USER_CORRECTION at confidence 0.5 beat a CAMERA_CAPTURE observed the NEXT DAY at 0.7, and the refusal was reported in `refused` rather than applied silently. So the ordering is precedence, not recency and not score. BBW because `evidence.ts` is imported by no route and `memory_corrections` does not exist |
| H243 | Invariant: historical memory cannot assert current venue availability | BBW | HELD on two levels: every `CompassMemoryProjection` row carries a `confidence_note` naming it a historical record, and the field whitelist contains no availability, status or hours field that could be misread. Mutation 5 turned it red. BBW because no Compass tool reads the projection |
| H244 | Invariant: projection consumers must tolerate duplicate / out-of-order events | BBW | HELD: a replayed rebuild produced byte-identical rows, the same source version and exactly one registration; a rebuild arriving AFTER a revocation reported `was_revoked` and did not resurrect the payload. Mutation 7 turned it red. BBW because there is no consumer — `memory_event_outbox` is 2710, unapplied, and nothing acks `published_at` |
| H245 | Chaos: duplicate upload | **BAC** | The scenario that found the defect. Re-delivered captures with the same `source_id` and a timestamp 20 seconds later collapse onto the original fingerprints, and the surviving set is identical under reversed delivery order. It came up BROKEN first; the fix is `artifacts/api-server/src/services/memoryProjections/evidence.ts:366#a.observed_at.localeCompare(b.observed_at)` |
| H246 | Chaos: out-of-order evidence | **BAC** | Three delivery orders of the same records produce byte-identical results, including the episode count and every boundary explanation. The fixture is not inert: the detector finds a real boundary in it |
| H247 | Chaos: projection worker outage | **BAC** | With the registry answering 57014 and canonical storage healthy, the read refuses with `derivative_unavailable` and `retryable`, and the rebuild refuses with `registry_unavailable`. Neither returns an empty result set — §28.11's rule, executable |
| H248 | Chaos: search-index delay | **BAC** | Canonical moves and the registered derivative does not: `projectionStaleness` reports STALE and NAMES the changed memory id, while the derivative keeps serving its registered payload. The scenario asserts the served payload is still the OLD one, so a version that rebuilt eagerly would fail rather than silently pass |
| H249 | Chaos: concurrent merge and edit | BBW | `PARTIAL`. Edit half certified against LIVE code: `assertLifecycleTransition` admits published↔archived in either interleaving and refuses both transitions out of the terminal `deleted`, so no losing race can resurrect a deleted Memory. Merge half has no surface, quoting the bus's own reason |
| H250 | Chaos: offline correction | **BAC** | A correction observed on the 11th and delivered after a 12th-of-the-month inference wins in BOTH arrival orders, at lower confidence than the inference. Connectivity does not decide truth |
| H251 | Chaos: partial media deletion | **BAC** | One of two assets removed: the Memory stays in the public derivative with its title and `occurred_at` unchanged and `media_count` 2 → 1. §28.1 — a media asset is not the Memory — survives partial deletion |
| H252 | Chaos: entity merge after Memory creation | BBW | `PARTIAL`. Re-resolution certified: repointing `canonical_location_id` makes the place derivative STALE and a rebuild under the survivor id finds the Memory again with `visit_index` recomputed. **The other half cannot be certified at all**: §9 requires the occurrence-time display text to survive a merge and `memories` has no `display_name_at_occurrence` column (H68) — there is nothing for the merge to preserve or lose |
| H253 | Chaos: timezone and date-line edges | **BAC** | A 30-minute gap across UTC midnight produces ONE episode, identical to the same gap at midday; the crossing is recorded on the boundary as `crosses_midnight: true` with `split: false`; and the observation keeps its IANA zone alongside a UTC instant. Mutation 6 turned it red |

#### §26 Delivery phases (H254–H261)

Graded on each phase's SCOPE, not on its exit criterion — every exit criterion in §26
("certified", "shadow metrics acceptable", "no private leakage certified") needs a live
run this pass did not make. §25 being built changes what "certified" could now mean for
phases 0–4, and nothing about whether the phases themselves are done.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H254 | Phase 0 — contracts: enums, schema, command bus, outbox, RLS, reason-code registry | BBW | Four of the six exist in code: the command bus, the outbox contract, and both reason-code registries. The schema is eight unapplied migrations and the RLS that goes with them is unapplied too |
| H255 | Phase 1 — canonical Memory MVP: private Memories, media links, place/trip links, correction, delete | BBW | Most of the shape ships in `routes/memories.ts`, but the default visibility is `friends_only`, not private (`docs/migrations/0067_memories.sql:7#CREATE`), and there is still no correction path — `memory_corrections` does not exist (H28) |
| H256 | Phase 2 — episode candidates: eligibility, deterministic grouping, candidate inbox, merge/split | BBW | Eligibility and grouping exist and are now certified (H55, H58). There is no candidate inbox and no merge or split |
| H257 | Phase 3 — Highlights: finite curated profile projection, pin/reorder/privacy | BBW | Privacy exists and is live; the archive is real. The projection, the curation, the pin and the reorder do not — 2723 is unapplied |
| H258 | Phase 4 — retrieval: temporal/spatial/social search and Compass read tools | BBW | `searchMemories` exists with all three filter families (H110–H113). **Zero of the Compass read tools exist** (H115–H122) |
| H259 | Phase 5 — executable Memories: Do Again, Add to Trip, Take Me Back | NB | Nothing. The repository-wide grep in H107 returns no hit of any kind |
| H260 | Phase 6 — resurfacing: contextual return-to-place, anniversaries, user suppression/fatigue | BBW | The suppression vocabulary and its surface effects exist and are applied on the live proactive feeds (`artifacts/api-server/src/services/highlights/highlightResurfacing.ts:129#RESURFACING_CONTROLS`), suppressing nothing because 2720 is unapplied. No anniversary and no fatigue model |
| H261 | Phase 7 — imports / Life Chapters: explicit historical backfill, cross-trip projections | BBW | **Moved from section A.4's NB, and here is why.** The phase has two halves. The backfill half is zero code (H195, H37). The cross-trip half is real: `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:227#buildLifeChapters` builds chapters across a memory set without copying captions or media upward. Grading that NB would be inconsistent with grading phases 0, 2, 4 and 6 BBW on code that is equally unreachable |

#### §28 Developer invariants not already counted (H262–H266)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H262 | §28.3 — never query a semantic substitute for an unknown canonical place or person and pretend it is the requested entity | NB | Graded on the surface where a violation would live (rule 7). No semantic retrieval over Memories exists — the only scorer is deterministic token overlap and it may not add a row — and no guard exists either, so this is NOT-BUILT rather than assumed-satisfied |
| H263 | §28.10 — never route public-world intelligence directly from private Memory without consent, eligibility and anonymization | **BAC** | The only path from derived memory to any shared surface is `artifacts/api-server/src/lib/mapProducers/memoryProducer.ts:13#memory_remembers_for_user`, and the RPC is called with the VIEWER's own id — strictly the viewer's own memory on the viewer's own map. Nothing feeds memory into world intelligence. Re-read at this commit |
| H264 | §28.11 — never swallow projection or schema failures into plausible-looking empty history without a structured error state | **BAC** | `artifacts/api-server/src/routes/memories.ts:600#req.log.error` returns `db_error` on a block-lookup failure rather than serving an unfiltered feed, and `loadMemoryGemContext` records `determined: false` and coarsens rather than passing silently. §25's `PROJECTION_WORKER_OUTAGE` (H247) now makes the same rule executable one layer down: an unreadable registry refuses with a named reason instead of returning zero rows |
| H265 | §28.16 — always preserve original user voice and original-language text in summaries and translations | NB | No summarization of Memories exists to preserve anything through. `NarrativeDerivative` is `NOT_CONFIGURED` (H172) |
| H266 | §28.17 — always provide a deterministic fallback renderer when AI presentation fails | NB | No AI presentation exists. `renderer_version` appears only in the header comment of the unapplied `artifacts/api-server/src/migrations/2723_highlight_class_lifecycle_and_pin.sql:8#renderer_version` and in a comment in `services/highlights/highlightLifecycle.ts` |

### B.6 The recomputed headline

Recomputed by `pnpm -s check:census-integrity` after this section was committed, not
carried forward from any earlier headline. **Parsed rows are 266 against a denominator of
266, so the prose gap is zero and the check now enforces that these four numbers sum to the
denominator** — the exemption that let a headline drift no longer applies to this document.

| Figure | Value |
|---|---|
| Denominator (testable requirements) | **266** |
| BUILT-AND-CORRECT | **38** |
| BUILT-BUT-WRONG | **129** |
| NOT-BUILT | **97** |
| CANNOT-VERIFY | **2** |
| Requirements counted where the tool cannot read | **0** |
| CONSTRUCTED% (BAC + BBW) | **62.8%** (167 / 266) |
| CORRECT%, raw (BAC) | **14.3%** (38 / 266) |
| CORRECT%, spec-attributable | **8.6%** (23 of the 38: H205 plus the 22 §25 rows) |

**Where the movement came from, said plainly.** Against section A's stated 16 / 123 / 125 / 2:

- **+1 BAC and −1 BBW** from converting prose to rows and re-deriving: H205, which section A
  graded against code that has since gained the `surface` parameter §23 asks for.
- **+21 BAC, +5 BBW, −26 NB** from the §25 build in this pass.
- **+1 BBW, −1 NB** from H261, a re-derivation this section argues for in its row.

Nothing else moved. **CONSTRUCTED is 62.8 % and this remains a repository in which almost
nothing serves a user**: 129 of the 167 constructed requirements are BUILT-BUT-WRONG, eight
migrations the code depends on are written and unapplied, and of the 38 correct rows 22 are
tests this pass wrote about engines that no route imports. The single number worth watching
is not CORRECT — it is that **`memory_kernel_enabled` still has no row in production**, so
every Memory write a user makes today is the same unaudited direct write it was before any
of this was built.

---

## B.7 The integration re-read — seven counted files moved under this document

**This section changes no verdict and moves no row.** It exists because a census
measured on a branch and then merged onto a mainline that has moved is a census whose
evidence has moved, and the only honest response is to go and look. `check:census-freshness`
named exactly which files to look at; this is what was found.

**What happened mechanically.** Section B was measured at `254e1876`, on a worktree branched
from `014a25d5`. It was merged into `claude/sweet-fermat-fmx7up` at `d4be8e952` — 141 commits
further on. `head_commit` stays `254e1876`, which is legitimate under the checker's stated
rule ("ANCESTOR-OF-HEAD, not ancestor-of-main") because the merge commit makes it one, and
`live-db.yml:392#fetch-depth` clones deep enough for CI to resolve it. **It is still
pre-squash**, so the owner follow-up B.1 already records — re-declare at the squash when this
lands — is unchanged and still owed.

`check:census-freshness` reported **seven** counted files changed between `254e1876` and the
merged tree. Every one is mainline work by the Trips, Telegraph and Sensing lanes; this lane
edited none of them. Each was read, not skimmed:

| file | what changed on the mainline | does it move a verdict here? |
|---|---|---|
| `artifacts/api-server/src/compass/CompassTools.ts` | +739/−23 — twenty-two new tools | **No — but it falsifies a sentence.** See below. |
| `artifacts/api-server/src/routes/compass.ts` | +26/−2, all inside `GET /compass/recommendations` | No. The line this census cites is `forgetMemory`, untouched; only its line number moved. |
| `artifacts/api-server/src/routes/location.ts` | +61/−3, above the city-stamp block | No. The GPS-stamp→suggested-memory path is byte-identical; it sits 58 lines lower. |
| `artifacts/api-server/src/lib/memoryCommandBus.ts` | +3/−3 | No. Three comments renaming `lib/tripKernel.ts` to `domain/trips/commands/tripKernel.ts` after §61 moved it. Zero executable lines. |
| `artifacts/api-server/src/lib/locateFriendsSession.ts` | +1/−1 | No. One comment, same §61 rename. |
| `artifacts/api-server/src/server/trips/outboxWorker.ts` | +79/−0 | No. It is a NEW file (§61 split the loop from the pass), and it is only ever cited here to say the `projection_lag_seconds` in it belongs to Trips and **not** to this lane — H220 stays NB. |
| `artifacts/api-server/src/server/trips/projectionWorkers/tripReminderScheduler.ts` | +401/−0 | No. Also a §61 move. Cited once, to say the only outbox in the repo is the trip-reminder one — still true. |

### The one sentence the merge falsified

Section B's §16 paragraph said `CompassTools.ts` "opens a list of **eleven** tools" and named
them. **That was true at `254e1876` and is false on the merged tree.** The literal array at
`artifacts/api-server/src/compass/CompassTools.ts:109#COMPASS_TOOL_DEFINITIONS` now holds
**twenty-five** entries and spreads eight more at `:467#TELEGRAPH_COMPASS_TOOL_DEFINITIONS`,
so the real figure is **thirty-three**. The twenty-two added since section B measured are
`get_freedom_windows`, `get_route_chain`, `get_today_state`, `get_crew_state`,
`get_live_conditions`, `get_commitments`, `get_saved_ideas`, `get_opportunities`,
`simulate_plan`, `create_proposal`, `get_rescue_plan`, `replan_day`, `find_meeting_point`,
`explain_trip_decision`, and the eight `telegraph_*` accessors declared at
`artifacts/api-server/src/compass/TelegraphConversationTools.ts:520#telegraph_get_conversation_context`.

**The verdicts do not move, and here is the mechanical reason rather than an assurance.**
H115–H122 (NB ×8), H123–H128 (NB ×6), H129 (BAC) and H237's BBW note all rest on one claim:
no Compass tool is memory-facing. Re-tested on the merged tree two ways —

- `grep -cE 'name: "[a-z_]*(memor|highlight|storie)'` over both tool files returns **0** and
  **0**: not one of the thirty-three tool names contains `memory`, `highlight` or `story`.
- `grep -E '\.from\("(memories|memory_*|highlights|stories|highlight_*)"'` over both files
  returns **nothing**: no tool implementation reads or writes a Memory or Highlight table.

So §16's eight named accessors are still absent and Compass still cannot mutate a Memory.

**One clause in H129 is now stale and is corrected here rather than in place.** It said the
only write-shaped tool is `add_to_trip`. Several are now write-shaped — `create_proposal`,
`replan_day` and `telegraph_create_plan_draft` among them. H129 **stays BAC** because its
requirement is about Memory facts specifically, and the second grep above is the proof that
none of them reaches one.

### Citations repointed (pointers, not judgements)

Ten citations named lines that the mainline moved. Repointing a pointer is not re-grading a
row, and the wording each one supports was re-read at the new line before it was changed.

| citation | was | now | why |
|---|---|---|---|
| the eleven-tool list (×3 rows) | `CompassTools.ts:87#name` | `CompassTools.ts:113#get_user_profile` | `:83` had drifted onto a comment. **It was passing `check:doc-citations` anyway**, because the anchor was the single token `name` and line 83 reads "…the Telegraph spec names." A one-word anchor is a substring lottery; the replacement anchors on the tool name itself. |
| `add_to_trip` | `CompassTools.ts:172#name` | `CompassTools.ts:421#add_to_trip` | Same defect, worse outcome: `:157` is now `get_place_details`, and `#name` matched it happily. |
| the tool array (§16 rows) | `CompassTools.ts:66-225` | `CompassTools.ts:109-484` | The array's real extent on the merged tree. |
| H129's tool set | `CompassTools.ts:66` | `CompassTools.ts:109` | Same. |
| H129's write-shaped tool | `:158` | `CompassTools.ts:421` | Bare `:158` also named no file; now fully qualified. |
| H129's `forgetMemory` | `routes/compass.ts:2150` | `routes/compass.ts:2226` | +76 lines above it; the call is unchanged. |
| H4's GPS city stamp | `routes/location.ts:334-374` | `routes/location.ts:392-432` | +58 lines above it; the block is unchanged. |
| the `passport_memories_enabled` gate | `routes/location.ts:357` | `routes/location.ts:419` | The mechanical +58 lands on `});`, which is what `:357` had been pointing at too. A sentence about a flag read should not point at a closing paren, so this one goes to the line that names the flag. |
| H4's check-in stamp | `routes/geofence.ts:634-676` | `routes/geofence.ts:809-861` | **Not the merge's doing — this was wrong before it.** `geofence.ts` is byte-identical between `254e1876` and the merged tree, and `:634-676` names the plan-geofence *reveal* handler, not the check-in stamp. The block H4 actually grades — the flag, `createStamp` at `verificationLevel: checkin`, then `createSuggestedMemory` — is `:809-861`. Found by re-reading a neighbour of a citation the merge did move; H4 stays **BAC** because the code it describes is exactly what is at the corrected lines. |
| the same gate in geofence | `routes/geofence.ts:658` | `routes/geofence.ts:845` | Same pre-existing error: `:658` is a route banner comment; `:845` is the `.eq("flag", "passport_memories_enabled")` itself. |

**What this section would have looked like if it had gone the other way (P24).** If any of the
twenty-two new tools had named a Memory, H115–H122 would have had to move off NB and H129 off
BAC, and this would be a re-measurement, not a re-read. The two greps are what decides it, and
they are written above so the next reader can re-run them rather than trust this paragraph.

**The headline in B.6 is unchanged: 62.8 % constructed, 14.3 % correct, 266 rows.** Nothing in
this section constructed anything. `memory_kernel_enabled` still has no row in production.

---

## C. §16's Compass accessors, §14's fusion boundary and §23's publish predicate — 2026-09-13, measured at HEAD `1ff810e2`

**The honest framing first, because the number is the least interesting thing in this section.**

This document has the lowest CORRECT% in the repository, and the reason has never been that
nobody wrote code for it. It is that almost everything written for it sits behind eight
migrations nobody has applied. Section B built §25's certification suite and said plainly that
21 of its 22 new correct rows were *tests about engines no route imports*. This section is
different in exactly one respect and the difference is worth stating precisely rather than
celebrating: **the code below is imported by two live routes, and neither of them needs a
migration or a flag that is off.** `POST /memories` and `PATCH /memories/:id` are ungated and
serve today; the eight §16 accessors are in the array `POST /compass/ask` hands the model on
every turn, behind `COMPASS_ENABLED`, which the committed production snapshot records as
`true` (`artifacts/api-server/src/lib/capability/snapshots/20260908-production-schema.json:5856#COMPASS_ENABLED`).

**And the sentence that governs this census is still true, unchanged, and this section does not
touch it.** `memory_kernel_enabled` still has no row in production. Every Memory write a user
makes today is the same unaudited direct write it was before any of this was built. Nothing
below emits a §17 domain event, nothing below is a projection, and nothing below reads a table
that does not already exist. **78 requirements remain NOT-BUILT and 134 remain BUILT-BUT-WRONG.**
What moved is one corner of §16, §14 and §23; what did not move is the entire kernel.

The denominator is still **266**, the counting rule in "How I decided what counts" is unchanged,
and the four buckets are unchanged.

**One thing was edited outside this section, and it is disclosed rather than buried**, on the
same grounds section B disclosed it: the `head_commit` value in the re-census header at the top
of this file was changed from `254e1876` to `1ff810e2`. `check:census-freshness` reads the FIRST
`head_commit` row in a file, so an appended section cannot re-declare it. `1ff810e2` is this
branch's commit and is an ancestor of its head. It is **pre-squash**, so the owner follow-up
section B records — re-declare at the squash when this lands — is unchanged and still owed.

### C.1 What was built, and where

| Artifact | Where | What it is |
|---|---|---|
| §23's ladder, no longer module-private | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:90#canReadMemory` | Moved out of `routes/memories.ts` comment for comment. Nothing in the ladder changed. `routes/memories.ts:177#memoryReadPolicy.js` imports it back, so the repository has one copy where it had one private one. |
| A fifth read surface | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:82#MemoryReadSurface` | `"compass"` joins single, profile, trip and public_feed. It runs the ADDRESSED ladder, not the feed rule, because a Memory shared with this viewer is a Memory this viewer may be told about. |
| One gate the eight cannot half-perform | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:276#canCompassReadMemory` | The ladder AND the bidirectional block check in one call. `routes/memories.ts` calls `isBlocked` separately at four read sites, which is fine three lines apart and is not fine across eight accessors. |
| §23's audience predicate | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:360#canPublishMemory` | Refuses the three combinations `canReadMemory` denies to every non-owner. Reasons and user-facing messages at `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:339#PUBLISH_REFUSAL_MESSAGE`. Wired at `artifacts/api-server/src/routes/memories.ts:421#canPublishMemory` (POST) and `:869#canPublishMemory` (PATCH, on the MERGED row). |
| §14's invariant as a datum, not a habit | `artifacts/api-server/src/services/memory/historicalTruth.ts:88#establishes_current_status` | Every Memory fact leaves the tools carrying `establishes_current_status: false`. A consumer cannot drop the caveat without dropping a field. |
| §14's refusal | `artifacts/api-server/src/services/memory/historicalTruth.ts:194#currentWorldReading` | A current-world claim built from a `historical` or `ai_inference` source class is REFUSED and comes back unavailable. The admitted set is two names at `:67#CURRENT_WORLD_SOURCE_CLASSES`. |
| §14's fusion, which is a juxtaposition | `artifacts/api-server/src/services/memory/historicalTruth.ts:224#fuseHistoricalWithCurrent` | Returns both halves with `merged: false` and sets `may_state_current_status` from the CURRENT half alone. There is no code path in the module that produces one merged claim. |
| §16's eight accessors | `artifacts/api-server/src/compass/MemoryCompassTools.ts:102#MEMORY_TOOL_SPEC_NAMES` | The spec's eight names, in the spec's order, mapped to tool names. Definitions at `:743#MEMORY_COMPASS_TOOL_DEFINITIONS`, dispatcher at `:907#executeMemoryCompassTool`. |
| No coordinate is selectable | `artifacts/api-server/src/compass/MemoryCompassTools.ts:133#MEMORY_FACT_COLUMNS` | `location_lat` and `location_lng` are not in the select list at all, so `sanitizeToolResult` is defence in depth rather than the defence. |
| Attendance is only an APPROVED tag | `artifacts/api-server/src/compass/MemoryCompassTools.ts:440#unconfirmed_participation` | A `pending` memory_tag is the OWNER's assertion about somebody who has not confirmed it, and it comes back under a key that says so. A `removed` tag is not reported at all. |
| The accessor that has to say "there is none" | `artifacts/api-server/src/compass/MemoryCompassTools.ts:567#evidence_store` | `getMemoryEvidence` answers `evidence_store: "absent"` first, then lists the artifacts attached to the Memory with a caveat that they are not §6-normalized evidence. |
| The minimum clarifying question | `artifacts/api-server/src/compass/MemoryCompassTools.ts:656#clarifyingQuestion` | Three material facts, ONE question, in a fixed priority order. A draft missing all three produces one question, not an interrogation. |
| Two write-shaped tools that write nothing | `artifacts/api-server/src/compass/MemoryCompassTools.ts:616#toolMemoryCreateDraft` and `:686#toolMemorySuggestCorrection` | Both return a proposal with `requires_confirmation` and a `confirm_via` naming the existing authenticated route, which re-authorizes. Field allow-lists at `:595#DRAFTABLE_FIELDS` and `:599#CORRECTABLE_FIELDS`, both deliberately SHORTER than `patchMemorySchema`: audience lists, visibility and lifecycle state cannot be proposed by prose. |
| The wiring | `artifacts/api-server/src/compass/CompassTools.ts:483#MEMORY_COMPASS_TOOL_DEFINITIONS` (spread) and `:1922#MEMORY_COMPASS_TOOL_NAMES.has` (dispatch) | One import, one spread, one branch, one prompt block — the shape Telegraph's §18.3 block already established in this file. |
| The §16 boundary as prompt text | `artifacts/api-server/src/compass/MemoryCompassTools.ts:898#MEMORY_COMPASS_PROMPT_RULES` | Listed LAST on purpose. It is the weakest of the three layers, and it exists only for §16's "may" clauses, which cannot be expressed as a refusal. |
| The suites | `artifacts/api-server/src/test/memoryCompassTools.test.ts:300#bypass` (35 tests) and `artifacts/api-server/src/test/memoryPublishPolicy.test.ts:195#refuses` (18 tests) | Both registered in `package.json`'s `test` script. |

**The two greps section B.7 wrote are the ones that decide §16, so here they are re-run rather
than described.** B.7 recorded `grep -cE 'name: "[a-z_]*(memor|highlight|storie)'` over the tool
files returning **0** and **0**, and a grep for a tool implementation reading a Memory table
returning nothing. On this commit the first returns **8** and the second returns the eight
accessors. A test asserts the first mechanically, in the definition list rather than by shelling
out: `artifacts/api-server/src/test/memoryCompassTools.test.ts:245#offered`.

### C.2 Reachability, stated as a chain with its weak links named

`POST /compass/ask` → `COMPASS_TOOL_DEFINITIONS` handed to the model
(`artifacts/api-server/src/routes/compass.ts:1260#COMPASS_TOOL_DEFINITIONS`) → the model emits a
tool call → `executeCompassTool` dispatches by name → `executeMemoryCompassTool`.

Three things that chain depends on, each said rather than assumed:

1. **`COMPASS_ENABLED`.** Read fail-closed at
   `artifacts/api-server/src/routes/compass.ts:1333#isCompassEnabled`. The committed production
   snapshot records it `true`. That is a repository artifact, not a live query — production was
   not touched.
2. **An OpenAI credential.** `artifacts/api-server/src/lib/openai.ts:4#apiKey` reads
   `AI_INTEGRATIONS_OPENAI_API_KEY` from the environment and falls back to the literal
   `"not-configured"`. **This repository cannot tell you whether production has that key.** If it
   does not, every Compass tool in the file — the eleven that were there and the eight added
   here — is unreachable, and so is every Trips and Telegraph accessor beside them.
3. **The model choosing to call one.** `tool_choice: "auto"`. An accessor gpt-5-mini never picks
   serves nobody, and nothing in this repository measures how often it picks one.

Point 3 is the one that makes these rows arguable, and it is arguable in the same direction for
every Compass tool this repository has ever counted — including **H129**, which this document
has held at BUILT-AND-CORRECT since the body on the strength of what is and is not in the tool
array. This section applies the same standard it inherited rather than a new one for its own
work. `canPublishMemory` is not subject to any of the three: `POST /memories` and
`PATCH /memories/:id` are ungated REST routes that serve on every deployment.

### C.3 Row moves

| id | was | now | why |
|---|---|---|---|
| H115 | NB | **C** | `getMemory(memoryId)` is `memory_get`, dispatched at `artifacts/api-server/src/compass/MemoryCompassTools.ts:320#toolMemoryGet`. Authorized through `canCompassReadMemory`; "does not exist", "cannot be read" and "not permitted" return the SAME refusal, so the tool is not an existence oracle for other people's Memory ids. |
| H116 | NB | **C** | `searchMemories(query)` is `memory_search` (`artifacts/api-server/src/compass/MemoryCompassTools.ts:344#toolMemorySearch`), over the viewer's own history. **CEILING in the row: this is NOT §15's retrieval.** It is deterministic token overlap over canonical rows; `services/memoryRetrieval/searchMemories.ts` reads registered derivatives out of `memory_derivative_registry`, migration 2730, unapplied. H110-H114 are unmoved and the tool result says so in a `ceiling` field. |
| H117 | NB | **C** | `getSharedMemories(personId)` is `memory_get_shared`, at `artifacts/api-server/src/compass/MemoryCompassTools.ts:383#toolMemoryGetShared`. |
| H118 | NB | **C** | `getPlaceHistory(placeId)` is `memory_get_place_history`, at `artifacts/api-server/src/compass/MemoryCompassTools.ts:448#toolMemoryGetPlaceHistory`. It is also the only place §14's fusion runs on real data. |
| H119 | NB | **C** | `getTripMemories(tripId)` is `memory_get_trip_memories`, at `artifacts/api-server/src/compass/MemoryCompassTools.ts:506#toolMemoryGetTripMemories`. Accepted-crew membership is checked FIRST and fail-closed, then every row individually. |
| H120 | NB | **W** | `getMemoryEvidence(memoryId)` exists at `artifacts/api-server/src/compass/MemoryCompassTools.ts:546#toolMemoryGetEvidence` and its honest answer is that §3.6's `memory_evidence` table does not exist in this repository at all (H24). An accessor over an absent store is BUILT and is not CORRECT. |
| H121 | NB | **C** | `createMemoryDraft(input)` is `memory_create_draft`. It writes nothing, resolves every named participant to a real handle or refuses the whole draft, and returns `confirm_via: "POST /memories"`. |
| H122 | NB | **C** | `suggestMemoryCorrection(memoryId, patch)` is `memory_suggest_correction`. Owner-only, allow-listed fields, current values returned beside the proposal, `confirm_via: "PATCH /memories/:id"`, writes nothing. |
| H123 | NB | **W** | "May summarize supported evidence." The surface now exists and the permission is stated in `MEMORY_COMPASS_PROMPT_RULES`. What does not exist is SUPPORTED EVIDENCE: there is no §6 normalization, no confidence and no provenance to summarize, only canonical row fields. Half a permission. |
| H124 | NB | **W** | "May propose a merge/split/correction." One of the three is built. MERGE_MEMORY and SPLIT_MEMORY are undeclared commands for the reason `lib/memoryCommandBus.ts` gives — there is no `memory_relations` table (H27) and nothing to split evidence between. |
| H125 | NB | **C** | "May ask the minimum clarifying question when a material fact is uncertain." MINIMUM taken literally: at most one question, fixed priority, WHEN before WHERE before WHAT, because §7 draws episode boundaries from time. |
| H126 | NB | **W** | "May not invent states, participants, identity, attendance or outcomes." Three of the five are MECHANICAL — participants and attendance (only an APPROVED tag), identity (an exact handle or a refusal), and the past-tense claim sentence is built by the app from columns rather than composed by the model. Emotional states, preference and outcomes are prompt text only, and prompt text is advisory. BUILT, not correct. |
| H127 | NB | **C** | "May not bypass privacy/visibility policy." Every one of the eight reads through `canCompassReadMemory`, which fails closed in both limbs. Proved by removing each limb in turn and watching a specific test go red — see C.4, mutations 1, 2 and 3. |
| H128 | NB | **C** | "May not use stale historical facts as current operational truth." Every fact carries `truth_class: "historical"` and `establishes_current_status: false`; the only current claim any tool can carry comes from a fresh reading, and a reading offered with a historical source class is refused. |
| H109 | NB | **C** | §14's fusion invariant. `fuseHistoricalWithCurrent` never merges and never derives `may_state_current_status` from the historical half. **CEILING: §14's other two legs are absent** — there is no current-user-context leg and no Temporal Freedom Engine leg, so nothing compiles into an executable plan. H107 and H108 stay NB and this row is the invariant only. |
| H5 | NB | **W** | "Historical truth and current-world truth are separate." The boundary is now encoded and route-reachable, but on ONE consumer. `routes/memories.ts` still serializes Memory rows with no truth class on them, so the separation is a property of the Compass surface rather than of the Memory domain. Moving this to C would claim the domain has it. It does not. |
| H70 | NB | **C** | "Place closure does not invalidate a historical visit." `fuseHistoricalWithCurrent` returns the historical half untouched whatever the current half says, and `memory_get_place_history` computes the visits independently of the live reading. **CEILING: the only "closure" this repository can observe is `openNow: false` from the live venue source. There is no permanent-closure signal anywhere in the tree**, so what is proved is that the mechanism cannot rewrite history, not that a real closure event has ever arrived. |
| H74 | NB | **C** | "Do not infer identity from name similarity." Participants resolve by exact handle through PostgREST `ilike` with no wildcard, or the draft is refused; there is no display-name fallback and no fuzzy match. The test fixture was CORRECTED during this pass to model that — its `ilike` originally did substring matching, which is LOOSER than production, and a fake looser than production cannot fail a test about identity. |
| H207 | NB | **C** | §23 `canPublishMemory(userId, memoryId, audience)`. Built and wired to both write paths. It refuses exactly the three audiences the read ladder delivers to nobody, and a property test asserts that correspondence in BOTH directions rather than asserting a list. |

**Two rows whose evidence this section corrects without moving them.**

- **H205** stays **BAC**. Its row cites `MemoryReadSurface` as four surfaces; this pass added a
  fifth, `"compass"`, and moved the declaration to
  `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:82#MemoryReadSurface`. Its three
  citations are repointed there. **Half of its stated CEILING is closed and half is not:** the
  helper is no longer module-private and §16's accessors call it rather than transcribing it, but
  `routes/contentStamps.ts` and `routes/wellKnownShare.ts` still re-derive the rule in their own
  words. One verdict now serves two files and two more still mirror it.
- **H2** stays **BBW**, and the brief that commissioned this pass described it as a live defect —
  `routes/stories.ts` hard-coding `visibility: "public"` on save-to-Highlight. **That description
  is stale and section B.2 already recorded it as stale.** Re-read at this commit:
  `artifacts/api-server/src/routes/stories.ts:890#resolveHighlightVisibilityForStory` refuses to
  promote any Story whose audience a Highlight cannot represent, with a 409 and a stable reason,
  and `artifacts/api-server/src/routes/stories.ts:918#decision.visibility` writes `decision.visibility`
  rather than a literal. `src/test/storyHighlightVisibility.test.ts` covers the close-friends and
  custom-audience cases already. **Nothing was built for H2 in this pass because there was
  nothing left to build there**, and writing a second test for a defect that is already closed
  and already tested would have been work that looked like progress.

### C.4 Red-first: 23 mutations, and the one that went red for the wrong reason

Every mutation was applied to **production** code, the suite measured, the file restored from a
byte-for-byte backup and `cmp`-verified. None is a change to a test or to a constant an
assertion reads back.

| # | Mutation (production file) | What went red |
|---|---|---|
| 1 | `memoryReadPolicy.canCompassReadMemory`: drop the block limb | "refuses a blocked viewer a PUBLIC Memory" and "fails CLOSED when the blocks table cannot be read" |
| 2 | `memoryReadPolicy.isBlocked`: an unreadable blocks table reads as not-blocked | "fails CLOSED when the blocks table cannot be read" |
| 3 | `canReadMemory`: give the compass surface the public-feed rule | 3 tests, including the allow-listed `custom` Memory becoming unreadable and the owner-only correction gate |
| 4 | `memory_get_shared`: count a PENDING tag as attendance | "separates approved participation from tagged-but-unconfirmed" |
| 5 | `currentWorldReading`: accept any source class as a reading of the world now | "REFUSES a current-world claim built from a historical or inferred source" |
| 6 | `fuseHistoricalWithCurrent`: let a recent historical fact license a current claim | "fusion is a juxtaposition" |
| 7 | rename `fusion_note` back to `note` — the key the Compass sanitizer deletes | 2 tests, including "the sanitizer does not eat the §14 caveat" |
| 8 | `memory_create_draft`: silently drop a handle that does not resolve | "a draft naming a handle that does not exist is REFUSED, not silently trimmed" |
| 9 | `ownHistoryIds`: an unreadable memory_tags reads as "tagged in nothing" | "refuses rather than answering from a partial history" |
| 10 | `memory_get_trip_memories`: drop the accepted-crew gate | "refuses trip Memories to a non-member" |
| 11 | `toMemoryFact`: spread the raw row instead of picking fields | "never emits a coordinate, an owner id or an audience list" |
| 12 | `CORRECTABLE_FIELDS`: let prose propose an audience change | "a correction proposes the patch beside the current value and refuses audience changes" |
| 13 | `memory_get`: distinguish "no such Memory" from "not permitted" | "gives the SAME refusal for a Memory that does not exist" |
| 14 | `memory_create_draft`: ask every missing question at once | "asks the MINIMUM clarifying question" |
| 15 | `canPublishMemory`: admit a crew audience with no trip | the property test, and the POST route test |
| 16 | `canPublishMemory`: admit a custom audience with an empty allow-list | 3 tests across the property suite and both routes |
| 17b | `canPublishMemory`: ALSO refuse circle_only, an audience that IS deliverable | 3 tests, including "an empty social graph does NOT refuse friends_only or circle_only" |
| 17c | `canPublishMemory`: refuse friends_only when the owner has no followers | the same 3, from the other side |
| 18 | `canPublishMemory`: read an unreadable trip_members as "you are not on the trip" | "fails CLOSED on an unreadable trip_members, and does NOT call it 'you are not on the trip'" |
| 19 | `POST /memories`: drop the §23 publish gate | both POST route tests |
| 20 | `PATCH /memories/:id`: judge the audience on `d.visibility` alone | "refuses emptying an allow-list even though visibility is not in the patch" |
| 21 | participant lookup: make it friendlier with a substring match | "a handle that merely RESEMBLES a real one does not resolve" |
| 22 | the same substring match in `memory_get_shared` | "getSharedMemories does not resolve a near-miss handle either" |
| 23 | fusion: let a current-world closure amend the historical claim | "a live 'closed' reading leaves the historical claim byte-identical" |

**Mutation 17 went red the first time for the wrong reason, and that is recorded rather than
quietly fixed.** Its anchor was the string `if (vis === "custom") {`, which occurs TWICE in
`memoryReadPolicy.ts` — once in `canReadMemory` and once in `canPublishMemory` — and
`String.replace` takes the first. The harness therefore mutated the READ ladder into a
`ReferenceError`, and the one test that failed did so because the code crashed, not because the
property was violated. **A red that comes from a crash proves nothing about the property.** It
was redone with a unique anchor (17b) and a second variant added from the opposite direction
(17c); both produced three clean failures with no crash. The general lesson is in the harness
now: it refuses any mutation whose anchor does not occur exactly once.

**P24 — what would turn each green claim red.** Every row in C.3 marked C has at least one
mutation above whose red is its evidence; the mapping is the mutation description. Beyond the
mutations: **removing either accessor file from `package.json`'s `test` script** would make all
53 assertions stop running, which `check:test-registration` catches; **the three conditions in
C.2 failing in production** would make every §16 row vacuous without a single test going red,
and nothing in this repository can detect that from inside; and **applying migration 2730 and
wiring §15's derivative retrieval** would make H116's ceiling paragraph false, which is the good
direction and would need this row re-read.

### C.5 The ceiling

1. **Nothing here is a §17 command.** The eight accessors do not write, so they do not cross the
   command boundary, so they emit no domain event — correctly, because there is nothing to emit.
   `canPublishMemory` is a PREDICATE consulted before the existing write; the write it guards is
   still `dispatchMemoryCommand`'s legacy path, because `memory_kernel_execute` is migration
   2711 and unapplied. **No row in §17 moves and none should.**
2. **`memory_search` is not §15.** It is a bounded scan of canonical rows with in-process
   filtering. H110-H114 stay NB. The tool says so in its own result rather than leaving a reader
   to infer it.
3. **`getMemoryEvidence` has nothing to read.** §3.6's `memory_evidence` has no migration in this
   tree at all — not written-and-unapplied, absent. H24 is unmoved and H120 is BBW because of it.
4. **The §10 location ladder is not applied on this surface.** No coordinate is selected, which
   makes the three FINER rungs structurally unreachable, and the two COARSER ones (`country`,
   `hidden`) are not enforced because `memories.location_precision` is migration 2338 and
   production does not have the column. This is the same posture `routes/memories.ts` already
   holds for the same reason; it is not a new gap and it is not closed.
5. **The prompt layer is advisory and is the weakest third of H126.** Emotional states,
   preference and historical outcomes are constrained by a sentence in a system prompt. That is
   why H126 is BBW and not BAC, and it should not be moved without a mechanism.
6. **H205's ceiling is half open.** `routes/contentStamps.ts` and `routes/wellKnownShare.ts` were
   not changed and still re-derive §23's ladder in their own words.
7. **Eight body citations in this document are stale and were NOT invented anew.** Eight
   unanchored `routes/memories.ts:NNN` citations in the `ebe72b34` body (H50, H69, H77, H176,
   H186, H198, the §17 prose block and the §24 one) point at line numbers that stopped matching
   long before this pass — verified by reading those lines at the PREVIOUS commit, where they
   already named unrelated code. They pass `check:doc-citations` because they carry no anchor,
   which is precisely the blind spot that check's own header describes. This section did not
   shift them, because shifting a number that was already wrong produces a different wrong
   number with more confidence attached to it.

### C.6 The recomputed headline

Recomputed by `pnpm -s check:census-integrity` after this section was committed, not carried
forward. Parsed rows are 266 against a denominator of 266, so the check enforces that these four
numbers sum to the denominator.

> **266 requirements. 52 BUILT-AND-CORRECT, 134 BUILT-BUT-WRONG, 78 NOT-BUILT, 2 CANNOT-VERIFY
> — 69.9 % constructed, 19.5 % correct.** Against section B's 38 / 129 / 97 / 2 that is
> **+14 correct, +5 wrong, −19 not-built**, and every one of the nineteen is a §16, §14, §9 or
> §23 requirement built in this pass. **It is still true that `memory_kernel_enabled` has no row
> in production and that every Memory write a user makes today is an unaudited direct write.**

| Figure | Value |
|---|---|
| Denominator (testable requirements) | **266** |
| BUILT-AND-CORRECT | **52** |
| BUILT-BUT-WRONG | **134** |
| NOT-BUILT | **78** |
| CANNOT-VERIFY | **2** |
| Requirements counted where the tool cannot read | **0** |
| CONSTRUCTED% (BAC + BBW) | **69.9%** (186 / 266) |
| CORRECT%, raw (BAC) | **19.5%** (52 / 266) |
| CORRECT%, spec-attributable | **13.9%** (37 of the 52: section B's 23, plus this pass's 14) |

**Where the movement came from, said plainly.** Fourteen rows moved NB to C and five moved NB to
W. Eleven of the fourteen are §16 accessors and LLM-boundary rules that now have a surface to
bind to; three are §14/§9 invariants with a mechanism; one is §23's publish predicate, and that
one is the only row in this section whose subject is reached by an ordinary authenticated REST
request rather than by a language model deciding to call a function.

**What did not move, and it is the larger number.** 78 requirements are still NOT-BUILT and 134
are still BUILT-BUT-WRONG. Of the 78, the largest clusters are §3.6's storage (10 tables with no
applied migration), §17's events (nothing emits any of the fourteen), §24's metrics (12 figures
nothing counts), and §11's resurfacing controls. Of the 134, the overwhelming majority are BBW
for one reason and it is the same reason it has been since section A: **the migration is written
and not applied.**

### C.7 What this pass did NOT build, and why

- **§11's user controls over resurfacing (H89-H92) and the sensitive-context registry (H86).**
  H86's registry table `protected_locations` ships deliberately EMPTY, so wiring it into the
  Memory surface would produce a gate that has never once fired. The census rule for that is ⌀
  and the honest move is not to claim it: a C verdict over a path nothing reaches is vacuous, and
  manufacturing one here would be the exact failure this document exists to catch. H89-H92 need
  `highlight_resurfacing_preferences`, migration 2720, unapplied.
- **§3.4's memory-relations graph (H27, H134, H135, H150, H151).** It needs a table. Migrations
  are the owner's.
- **§19's concurrent-edit resolution (H178).** `PATCH /memories/:id` still applies a partial
  patch unconditionally with no version and no conflict detection. An optional `If-Match` could
  be added without a migration, but OPTIONAL means the default stays blind last-write-wins, which
  would be BBW at best and would put a conflict-detection claim on a route that does not perform
  it by default. **Whether the default should become strict is a client-contract decision and is
  surfaced as an owner decision below rather than taken here.**
- **§14's executable actions (H107, H108) and Do Again.** The fusion boundary is built; the
  Temporal Freedom Engine leg it would compile through is not, and a "Do Again" that replays a
  stale plan is precisely what §14 forbids.

### C.8 Owner decisions this section surfaces

- **D-C1. Should `PATCH /memories/:id` reject an edit whose base the client did not state?**
  Strict is correct for §19 and breaks every client that does not send the precondition. Optional
  is compatible and leaves the default at blind last-write-wins. This is a product decision about
  clients, not a code decision, and H178 stays NB until it is taken.
- **D-C2. Is `AI_INTEGRATIONS_OPENAI_API_KEY` set in production?** Every Compass tool in this
  repository — not only the eight added here — is unreachable without it, and no artifact in the
  tree records the answer. If it is not set, fourteen rows in C.3 are vacuous and should be marked
  ⌀ by whoever can answer.
- **D-C3. The three audiences `canPublishMemory` now refuses were previously accepted.** Any
  EXISTING production row in one of those three states is invisible to everyone but its owner and
  will stay that way; this predicate guards new writes only and does not repair old ones. Whether
  to find and repair them is an owner decision, and this section does not query production to
  count them.

### C.9 Files changed outside this lane, named loudly

`artifacts/api-server/src/compass/CompassTools.ts` is counted by **census-trips**,
**census-layover**, **census-trust** and **census-telegraph** as well as by this one. It gained
one import block, one spread, one dispatcher branch and one prompt block, and lost nothing.
`artifacts/api-server/src/routes/memories.ts` is counted by **census-telegraph**; it lost 146
lines to the policy module and gained two calls to `canPublishMemory`.

Those two moves invalidated **88 citations across three census documents** — 83 shifted
mechanically from the diff hunks, three inherited bare specs and two out-of-range ones corrected
by hand. Every one was a POINTER, verified to hold at the previous commit before being moved and
to hold at the new line after. **No verdict in another lane's census was read, re-derived or
changed**, and `check:doc-citations` reports zero broken anchors at this commit against 42 before
the repair.
