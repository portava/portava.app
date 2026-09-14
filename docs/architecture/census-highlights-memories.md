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
> | `head_commit` | `80a8d655a` — RE-DECLARED 2026-09-14 by §K/§L, replacing `338837b44`. §K re-derived eight rows (five `W → C`, three `N → W`) and refused three the lane proposed; §L corrects §K.4's own overstatement of the blast radius and holds H4 and H239 at `W` against the next lane's proposal. The 21 counted files that changed are that work plus the shared files sibling lanes touched. It does **NOT** certify the other 56 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `338837b44` — RE-DECLARED **2026-09-13 by section H**, which fixed two live disclosures on the two profile reads this census owns, closed a lifecycle write that never re-asserted its own guard, moved H178 from NOT-BUILT to BUILT-BUT-WRONG and repointed every citation its line shift invalidated — so it RE-MEASURED this document rather than only re-pointing it. The value it replaces is `d3b19fa9d`, section D's. **`338837b44` IS ALSO PRE-SQUASH**, so the owner follow-up section B.1 records — re-declare at the squash when this branch lands — is unchanged and still owed; that is now the FIFTH consecutive section to declare a commit that will be unreachable the moment it merges. Section D's own note follows, preserved verbatim. RE-DECLARED **2026-09-13 by section D**, which grouped all 134 BUILT-BUT-WRONG rows by cause, narrowed the Compass graph's §28.10 memory-eligibility gate, built the §28.8 revocation sweep, put §1's truth class on every canonical Memory payload the domain serves, and completed two of §24's three missing log fields — so it RE-MEASURED this document rather than only re-pointing it. The value it replaces is `1ff810e2`, section C's, whose spent acknowledgement moved to `retired` in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` in the same change. **`d3b19fa9d` IS ALSO PRE-SQUASH**, so section B.1's owner follow-up — re-declare at the squash when this branch lands — is unchanged and still owed; that is now the FOURTH consecutive section to declare a commit that will be unreachable the moment it merges, which is a defect of the workflow rather than of any one pass. Section C's own note follows, preserved verbatim. RE-DECLARED **2026-09-13 by section C**, which built §16's eight Compass Memory accessors, §14's fusion boundary and §23's publish predicate, and therefore RE-MEASURED this document rather than only re-pointing it. The value it replaces is `254e1876`, section B's. `check:census-freshness` reads the FIRST `head_commit` row in a file, so an appended section cannot re-declare it and this row is the only place the change can be made. **`1ff810e2` IS ALSO PRE-SQUASH**, so the owner follow-up section B.1 records — re-declare at the squash when this branch lands — is unchanged and still owed. Section B's own note follows, preserved verbatim. RE-DECLARED **2026-09-13 by section B**, which re-measured every row in this document against that commit; the value it replaced was `42aeac38`, and section A's own account of why `42aeac38` replaced `cdfff5995c92f7adfb3ae7880496bc94002717e9` is preserved verbatim below. **`254e1876` IS PRE-SQUASH and will become unreachable when this branch lands** — the same `CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI` failure section A records one paragraph down. Whoever merges must re-declare it to the squash commit, and section B.1 names that as an owner follow-up. The original note follows. RE-DECLARED 2026-09-10 from `cdfff5995c92f7adfb3ae7880496bc94002717e9`, the working-tree commit this census was measured at. It was necessary because `cdfff599` is PRE-SQUASH — this repository squash-merges, so it is an ancestor of nothing, is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). Reproduced 2026-09-10 in a fresh clone of this branch: `git diff cdfff599..HEAD` aborts with `Invalid revision range`, and the check reported this census as unreadable rather than checking it. `42aeac38` is #476's squash, where this document's content reached `main`. **This is a RE-DECLARATION, not a re-measurement.** FOUR counted files changed between `cdfff599` and `42aeac38`: `artifacts/api-server/src/lib/memoryOutbox.ts`, `.../services/memoryProjections/derivativeRegistry.ts`, `.../derivativeRegistryRead.ts`, and `.../services/memoryRetrieval/searchMemories.ts`. The move is defensible only because each was re-verified mechanically on 2026-09-10 over `cdfff599..42aeac38`: `memoryOutbox.ts` adds 48 lines of which ZERO survive a filter for lines that are neither comment nor blank; `searchMemories.ts` changes one import path and nothing else; the other two are a split whose exported-symbol set is IDENTICAL at both commits (18 exports, same names and signatures, diffed) and whose retained half differs by zero non-comment lines — the moved `readRegisteredPayload` no longer delegates to `readRegistration` but inlines that function's body verbatim, table, columns, filters, error mapping and all, because importing back would have closed an ESM cycle. The full per-file argument is preserved under `retired` in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, where it had been written as an acknowledgement. **Changed by the Trips lane, not this one**, because CI could not run this check against this census at all until it was; nothing else in this document is touched, and reverting it costs only the check. |
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
> *(Attribution restated 2026-09-14: "spec-attributable CORRECT is still zero" means no
> BUILT-AND-CORRECT row rests on an artifact that cites this spec. It does not mean those rows
> were built for something else — that is UNKNOWN. See the Headline restatement and
> `docs/architecture/attribution-method.md`.)*
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
| **CORRECT%, spec-attributable** | **0.0%** (0 of 17 carry an in-file citation of this spec) |

**The single most important number is the last one.** Every one of the 17 BUILT-AND-CORRECT
verdicts is satisfied by code written for a *different* spec — the Memories scrapbook (migration
`0067`), Passport, Media v2 (§33), the "Memory + Experience Intelligence Architecture" projection
family (migrations 2183–2214), or account-deletion hardening. Not one file cites this spec. The
spec entered the repository on **2026-09-07**; every file cited below predates it. **Nothing in
this repository has been built for the Highlights/Memories spec.**

> **ATTRIBUTION RESTATED 2026-09-14 — the last two sentences above are WITHDRAWN; those 17
> rows are attribution UNKNOWN, not attribution-elsewhere.** The reasoning is kept above
> because this repository keeps its reasoning; what is withdrawn is the conclusion drawn
> from it. See `docs/architecture/attribution-method.md`.
>
> **What was claimed.** That all 17 BUILT-AND-CORRECT verdicts were earned by work done for
> some *other* specification, and therefore that nothing in the tree had been built for this
> one.
>
> **Why it does not hold.** The load-bearing step is *"the spec entered the repository on
> 2026-09-07; every file cited below predates it."* A file date is a fact about the
> repository, not about the author's intent: a specification can be written, circulated and
> worked from long before anyone commits it here, so predating the upload is consistent with
> having been built from the spec and with never having heard of it. The owner has ruled that
> inference out. The second step — *"not one file cites this spec"* — is a true and useful
> measurement, but it is the ABSENCE of evidence for attribution to this spec; it is not
> evidence for attribution to a different one. Read at this tree, the artifacts this paragraph
> names as other programmes' work carry no spec citation of any kind in their headers:
> `artifacts/api-server/src/routes/memories.ts:2#Memory System routes` opens with a route
> list, `artifacts/api-server/src/lib/deletionDispositions.ts:2#Account-deletion coverage manifest.`
> with a coverage manifest, and
> `artifacts/api-server/src/services/passport/PassportMemoryService.ts:4#Creates and manages passport memories.`
> with a prose description — none of the three names a specification, this one or any other.
> The one migration cited by number, `0067`, is
> `artifacts/api-server/src/migrations/0067_reviews.sql:2#Cross-domain review system for trips and rent_buddy_bookings.`
> — a cross-domain review system, not the Memories scrapbook.
>
> **What would settle it.** For attribution TO this spec: a header block in the artifact naming
> `docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt` and the sections
> it implements — exactly the form section A.6 later found on 30 files. For attribution
> ELSEWHERE: a header naming a different, identifiable specification (a path, or a
> programme name plus its own section numbering), or a migration/PR whose own text states the
> programme that commissioned it. Absent either, the row is UNKNOWN, which is a measurement
> and not a failure.
>
> **The figure itself is unchanged and no verdict moves.** 0 of 17 is still the right count of
> BUILT-AND-CORRECT rows carrying an in-file citation of this spec. What it may no longer be
> read as is a count of rows that were not built for it.

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
    (`routes/memories.ts:267-283`), a real tag-consent model that refuses co-ownership
    (`routes/memories.ts:669-711`), a media-delete path that removes the storage object while the
    Memory survives (`routes/memories.ts:593-621`), a genuine private-by-default suggestion
    pipeline (`services/passport/PassportMemoryService.ts:73`, accepted at `:150`), and an
    account-deletion sweep that reaches every memory and highlight table
    (`lib/deletionDispositions.ts:152,192,352`). Calling that 1.1% undersells the repository.
  - **Spec-attributable CORRECT is lower than claimed: 0.0%, not 1.1%.** Every one of those 17 is
    pre-existing work for another spec. If the 1.1% was meant as "built for this spec", it should
    be zero.
    **[RESTATED 2026-09-14 — UNKNOWN.]** *"Every one of those 17 is pre-existing work for
    another spec"* is not measured; it is the date inference of the headline repeated. What is
    measured is that 0 of the 17 cite this spec. Their attribution is UNKNOWN. The corrected
    sentence is: *if the 1.1% was meant as "carries an in-file citation of this spec", it should
    be zero — and the question of what those 17 were actually built for is open.*
- **The claim I would replace both with:** *nothing in this repository was built for the
  Highlights/Memories spec; roughly a quarter of its requirements have a namesake artifact, and
  none of those namesakes is the spec's object.*
  **[RESTATED 2026-09-14 — the first clause is WITHDRAWN.]** The replacement claim this
  document should make is: *no artifact in this repository cited the Highlights/Memories spec at
  the time this section was written; roughly a quarter of its requirements have a namesake
  artifact; none of those namesakes is the spec's object; and whether any of them was built from
  the spec is UNKNOWN.* Section A.6 below then measured the first clause false at a later tree —
  30 files now cite the spec by path — which is the second reason not to read the original
  sentence as standing.

---

## Requirement-by-requirement

Buckets: **BAC** = built and correct · **BBW** = built but wrong · **NB** = not built ·
**CV** = cannot verify. Attribution column: **pre** = pre-existing work for another spec that
happens to satisfy this one; **—** = incidentally satisfied, no artifact was built; **spec** = built
for this spec (there are none).

> **ATTRIBUTION LEGEND RESTATED 2026-09-14.** Read **pre** as **UNKNOWN**: *the artifact was
> present before this spec was uploaded and carries no in-file citation of it.* That is what
> the mark was actually assigned on, and it does not establish which spec — if any — the work
> was done for. A **pre** mark becomes **elsewhere** only when the artifact's own header names
> a different, identifiable specification; it becomes **spec** only when the header names this
> one. Neither test was applied per row when these marks were written, so every **pre** in the
> table below is an UNKNOWN until re-read. See `docs/architecture/attribution-method.md`.

### §1 Architectural mandate (5)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H1 | Canonical Memory facts independent of viewer layout and AI narrative | NB | `memories` rows are read and serialized straight to the client (`artifacts/api-server/src/routes/memories.ts:2797#function mapMemory`, the one serialization point every Memory response spreads); there is no fact layer beneath a projection | |
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
| H10 | MemoryPrivacyService | BBW | **EVIDENCE CORRECTED 2026-09-14, VERDICT UNCHANGED.** Both citations were stale and the first was stale in a way that mattered: `canViewMemory` is in NO file in this repository — it is `canReadMemory`, and it is not in the route. `services/memory/memoryReadPolicy.ts:90#canReadMemory` is a policy MODULE, called from `routes/memories.ts:696` as "defence in depth, not the filter"; `lib/highlightPermissions.ts:117#canViewHighlight` (cited `:37`, which is prose about it). So "per-route read helpers" is false for the memory half. The verdict stays BBW for the reason it always gave, restated against what is actually there: READ policy is one of the five this row asks for, and audience, precision, resurfacing, personalization and publication have no service. Found by `check:citation-symbols`, which is why the sentence could be checked rather than believed. | pre |
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
| H50 | Memory lifecycle machine | BBW | `routes/memories.ts:248` accepts any of `draft/published/archived` on PATCH with no transition guard; `:676` writes `state:"deleted"` directly | pre |
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
| H79 | Public search queries only public derivatives, never private canonical storage plus post-query filtering | BBW | `routes/memories.ts:241-283` — the discovery feed reads canonical `memories` through the **service client** (RLS bypassed), applies `.limit()` **before** block filtering, then post-filters blocks in TypeScript. This is precisely the pattern §10 and §28.6 forbid | pre |
| H80 | Media visibility independent from Memory visibility | NB | `memory_items` has no visibility of its own; it inherits the memory's | |
| H81 | Publishing location must never exceed the owner's selected precision | NB | There is no owner-selected precision on a Memory; the only clamp is the gem ceiling | |
| H82 | Temporary operational location must not leak into durable public Highlights | NB | `routes/highlights.ts:141-148` persists `location_name`/`city`/`country` verbatim with no precision control and no TTL distinct from the media's | |
| H83 | Being tagged or referenced does not make another user a co-owner | **BAC** | `routes/memories.ts:669-711` — a tagged user may only approve/remove **their own** tag (`userId !== user.id → 403`); no edit, no visibility, no delete rights accrue. Owner-only checks at `:606-608`, `:669-674` | pre |
| H84 | Blocking and account deletion suppress future social resurfacing and unlink identity | **BAC** | Memories feed fails **closed** on a block-lookup error rather than serving an unfiltered feed (`routes/memories.ts:267-283`); highlights filter both directions (`routes/highlights.ts:872-880`, `:38-49`); deletion reaches `memories`/`memory_likes`/`memory_saves` (`lib/deletionDispositions.ts:152`), the derived family (`:192`) and every highlight table (`:352`), executed at `services/accountDeletion/AccountDeletionService.ts:964-975` | pre |
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
**all NOT-BUILT.** The nearest artifact is `services/media/MediaProjectionService.ts:1264#{ key: "gems", label: "Hidden Gems", ownerOnly: false, count: gemsCount, media: [] },`, a
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
| H115–H122 | `getMemory`, `searchMemories`, `getSharedMemories`, `getPlaceHistory`, `getTripMemories`, `getMemoryEvidence`, `createMemoryDraft`, `suggestMemoryCorrection` | NB ×8 | `compass/CompassTools.ts:114-489` defines 11 tools: `get_user_profile`, `get_current_trip`, `search_places`, `search_events`, `get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`, `get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`. **None** is memory-facing | |
| H123–H128 | LLM boundary: may summarize supported evidence · may propose merge/split/correction · may ask a minimal clarifying question · may not invent states/participants/identity/attendance/outcomes · may not bypass privacy policy · may not use stale history as current truth | NB ×6 | No memory-facing LLM path exists to constrain; no boundary is encoded. (`2221_compass_ai_writing_default_off.sql` is the adjacent posture, for Compass prose generally) | |
| H129 | Compass must not mutate canonical Memory facts through prose | **BAC** | The tool set at `compass/CompassTools.ts:114` contains no Memory mutation; the only write-shaped tool is `add_to_trip` (`compass/CompassTools.ts:426`). `routes/compass.ts:2275` `forgetMemory` writes `compass_memories` (a chat store), not `memories` | — |

### §17 Command bus and domain events (33)

**Commands (17).** Eleven of the seventeen operations exist as ad-hoc REST writes with **no command
boundary, no idempotency key, no audit row and no outbox insert** — the requirement is the boundary,
not the verb, so each is BBW:

`CREATE_MEMORY` (`routes/memories.ts:344`) · `ARCHIVE_MEMORY` (`:248` + `:628`) ·
`DELETE_MEMORY` (`:646`, soft) · `CHANGE_VISIBILITY` (`:617`) · `ADD_MEDIA` (`:685`) ·
`REMOVE_MEDIA` (`:727`) · `ADD_PERSON` (`:396`) · `REMOVE_PERSON` (`:838` — and only the *tagged*
user may remove; the owner cannot) · `CHANGE_PLACE` (`:616`) ·
`PUBLISH_HIGHLIGHT` (`routes/stories.ts:609`, forced public) · `HIDE_HIGHLIGHT`
(`artifacts/api-server/src/routes/highlights.ts:940#deleted_at`, a soft delete, not a reversible hide) — **11 BBW**.

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
| PublicMemoryProjection | BBW | `routes/memories.ts:241` is a canonical read, not a derivative (see H79) | pre |
| SearchEmbedding | NB | No embeddings exist | |
| NarrativeDerivative | NB | | |
| MapTrailDerivative | BBW | `lib/mapProducers/memoryProducer.ts:182` emits viewer-scoped map objects from `memory_remembers_for_user` — derived preferences, not a spatial presentation of Memories | pre |
| Derivative registration (source Memory version, type, destination, generatedAt, revocation state) | NB | `memory_derivative_registry` absent; nothing records where a derivative went | |

### §19 Offline and multi-device (6)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H175 | Client operation ids + server idempotency on the sync command | NB | `Idempotency-Key` handling exists for `routes/intel.ts:149` and `routes/mapObservations.ts:926`; no memory route reads it | |
| H176 | Memory can exist before all media uploads complete | **BAC** | `routes/memories.ts:340-405` creates a Memory with no items; items are added independently at `:685` | — |
| H177 | A failed media upload does not invalidate already-saved Memory facts | **BAC** | Same separation: item insert failure returns `db_error` at `:723` and leaves the Memory intact | — |
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
| H185 | Face recognition must not be a dependency for People Memories | **BAC** | People on a Memory are `memory_tags` — an explicit social-graph primitive with consent (`routes/memories.ts:206-216`, `:2022#memory_tags`). No face-recognition code exists in the repo | — |

### §21 Deletion, forgetting and revocation (8)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H186 | Archive: retain canonical, remove from normal browsing | **BAC** | `0067_memories.sql:22` permits `archived`; PATCH accepts it (`routes/memories.ts:248`); the feed filters `state='published'` (`:427`) so archived drops out of browsing while single-fetch by the owner still returns it (`:524` filters only `state != 'deleted'`) | pre |
| H187 | Do not resurface (retain + search privately, suppress proactive resurfacing) | NB | No such control on a Memory | |
| H188 | Do not personalize (retain, exclude from inference) | NB | | |
| H189 | Make private: revoke public derivatives and public indexing, retain the Memory | BBW | PATCH visibility works (`routes/memories.ts:448`) but revokes nothing — there are no derivatives or indexes to revoke, and no cache invalidation on the memories path (contrast `routes/highlights.ts:5`, which does invalidate the Compass cache) | pre |
| H190 | Delete Memory: revoke derivatives, remove indexes/embeddings, purge canonical/eligible evidence | BBW | `routes/memories.ts:503` writes `state:"deleted"` and stops. The media bytes stay publicly served — documented in the repo's own words at `services/accountDeletion/AccountDeletionService.ts:565-570` | pre |
| H191 | Delete media asset: remove asset and derivatives; the Memory survives | **BAC** | `routes/memories.ts:593-621` deletes the row first, then removes the storage object, and refuses any path outside the owner's `memories/{userId}/` prefix. The Memory is untouched | pre |
| H192 | Revocation propagates to public projection, search index, embedding, profile Highlight, Trip story, Passport reference, cached narrative and share links | NB | None of those destinations exists to propagate to | |
| H193 | Deletion observable, retryable, dead-lettered on repeated downstream failure | BBW | `AccountDeletionService` has named, reported steps (`:580`, `:1004-1006`) — but that is account deletion. Per-Memory deletion has no step, no report, no retry, no dead letter | pre |

### §22 Migration from existing Highlights/Memories (4)
H194 no big-bang; stable IDs/URLs · H195 legacy rows imported as `LEGACY_IMPORTED` with conservative
confidence · H196 dual-read shadow comparison then cutover · **all NOT-BUILT** — no migration to the
spec's model has been started. H197 "never fabricate trip/place/participant/visited during backfill"
— **CANNOT-VERIFY** (see below).

### §23 Authorization and RLS (13)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H198 | Owner-only access to canonical private Memory facts **by default** | BBW | RLS exists (`docs/migrations/0067_memories.sql:30-38`; `0026_highlights.sql:24-33`) — but **every** server read and write on both surfaces uses `getServiceClient()`, which bypasses RLS entirely (`routes/memories.ts:349`, `:424`; `artifacts/api-server/src/routes/highlights.ts:667#getServiceClient`). The effective default is the TypeScript helper `canViewMemory`, not the database | pre |
| H199 | Participant membership alone does not grant full Memory access | **BAC** | `routes/memories.ts:127-204` — a tag grants nothing; `trip_crew` requires both `visibility='trip_crew'` **and** live `trip_members` membership; a hidden viewer is denied under **every** visibility mode (`:143-146`, fixing audit MEM·M1) | pre |
| H200 | Public derivatives behind an explicit publication policy | NB | | |
| H201 | Exact location and private notes require tighter policies than public-safe summary | NB | Exact `location_lat/lng` are stored in the same row and gated only by the gem ceiling | |
| H202 | Service roles performing projections are scoped and audited | BBW | The service client is used as a blanket RLS bypass on every memory/highlight route; no per-surface scoping, no audit trail | pre |
| H203 | Search/index workers consume privacy-filtered event payloads, not raw rows | NB | No such workers | |
| H204 | Truth level and inference provenance are server-controlled; clients may assert but not forge "verified" | **CV** | `2150_passport_memories_write_boundary.sql` revokes `verification_level`, `source_type`, `source_id`, `suggestion_reason`, `plan_id`, `trip_id`, `place_id` from `anon`/`authenticated` — exactly the requirement, and it proves the hole by execution. But the file's own header reads "⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the owner's explicit approval". Whether production is protected is a live-state question | pre |
| H205 | `canReadMemory(userId, memoryId, surface)` | BBW | `routes/memories.ts:127` `canViewMemory(sc, memory, viewerId)` — **no `surface` parameter**, so one verdict serves the feed, the profile listing and the single fetch alike | pre |
| H206 | `canEditMemory(userId, memoryId)` | **BAC** | `routes/memories.ts:441-443` — owner-only, checked against a fresh read, before any patch is composed | pre |
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
engine version, reason codes, projection name and failure class — **BBW**: `routes/memories.ts:304`
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
| §28.11 | Never swallow projection/schema failures into plausible-looking empty history without structured error state | **BAC** | `routes/memories.ts:267-283` — a block-lookup error returns `db_error`, explicitly rejecting `data ?? []` because that "yields an empty set → nothing filtered → blocked content leaks". `loadMemoryGemContext` (`:66-78`) records `determined:false` and coarsens rather than silently passing | pre |
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
   Episodes*. `artifacts/api-server/src/routes/highlights.ts:501#media_url: d.mediaUrl` creates a highlight from a raw `mediaUrl` with no source.
   Until a Highlight has a source Memory, §12, §18 and half of §21 have nothing to attach to.
2. **The discovery feed is the exact anti-pattern §10 and §28.6 name.** `routes/memories.ts:241-283`
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
| A command boundary with idempotency keys, per-attempt audit, transactional outbox | **In code, yes. In production, no.** | `lib/memoryCommandBus.ts:281` (11 command types), `:434` `IDEMPOTENCY_KEY_HEADER`, `:440` envelope reader, `:470` `executeMemoryCommand`; `lib/memoryOutbox.ts:67-79` (§17's fourteen event names verbatim); `services/memory/MemoryDomainService.ts:121` `auditCommand`, `:437#dispatchMemoryCommand` `dispatchMemoryCommand`. The kernel tables and `public.memory_kernel_execute` are migrations **2710 / 2711, NOT applied**. |
| The flag is seeded FALSE | **Stronger than that — the row does not exist.** | 2710 seeds `memory_kernel_enabled`; 2710 is unapplied, so the production flag set (`lib/capability/snapshots/20260908-production-schema.json`) contains no such key, and `isFlagEnabled` is fail-closed. Every memory write in production is the legacy direct write, audited only by a log line marked `durable:false` (`MemoryDomainService.ts:360-370`). |
| Seven routes cross the boundary | **Yes** | `routes/memories.ts:513#CREATE_MEMORY` (CREATE), `:1499#dispatchMemoryCommand` (PATCH → ARCHIVE / CONFIRM / CHANGE_VISIBILITY / CHANGE_PLACE / UPDATE via `commandTypeForPatch` in `MemoryDomainService.ts`), `routes/memories.ts:1672#DELETE_MEMORY` (DELETE), `:1793#ADD_MEDIA` (ADD_MEDIA), `:1884#REMOVE_MEDIA` (REMOVE_MEDIA), `:2071#ADD_PERSON` (ADD_PERSON / REMOVE_PERSON) |
| MERGE / SPLIT / PIN / UNPIN / PUBLISH_HIGHLIGHT / HIDE_HIGHLIGHT / SET_RESURFACING_POLICY are **not** declared | **Yes, and the code says why** | `lib/memoryCommandBus.ts:306-313` — `MEMORY_COMMAND_TYPES_NOT_DECLARED`, each with its reason. They stay NOT-BUILT. |
| `memoryProjections/**` — registry, evidence, episodes, significance, graph | **Yes, and reachable from nothing** | `evidence.ts:246, 435`; `episodeDetection.ts:244`; `significance.ts:162`; `memoryGraph.ts:246`; `projectionRegistry.ts:501`; `derivativeRegistry.ts:287`. **No route or lib outside `src/test/` imports any of them** — grepped across `src/routes/`, `src/lib/`, `src/services/` and `src/scripts/` at this commit. |
| `memoryRetrieval/**` | **Yes, test-only** | `searchMemories.ts:169`, namespace table at `:49`. Same reachability finding. |
| `highlights/**` — ranking, lifecycle, projection policy, resurfacing, revocation | **Three of five are wired** | Wired: `highlightResurfacing` (`routes/highlights.ts:18`), `highlightProjectionPolicy` (`:23`), `highlightRevocation` (`:24`, executed `:945`). **Not wired:** `highlightRanking.ts` and `highlightLifecycle.ts` — test-only. |
| `highlightPermissions.ts` reconciled to one rule | **Yes, and it is live** | `lib/highlightPermissions.ts:1-55` records the fork it closed: `canEngageHighlight` had **zero callers** while five routes re-derived the rule inline and disagreed with it on self-like and self-reply. The routes' behaviour was kept — widening is a product decision — and every route now calls `canViewHighlight` / `canEngageHighlight` (`routes/highlights.ts:6-13`). No migration is involved, so this one **is** in production. |
| `highlights.archived_at` wired as a reversible archive | **Yes, and it is live** | `artifacts/api-server/src/routes/highlights.ts:52#archived_at` (projected), `:1037#/highlights/:id/archive` archive, `:1068#/highlights/:id/archive` unarchive, `:1105#/highlights/archived` `GET /highlights/archived`, and `.is("archived_at", null)` on the three list reads (`:593#archived_at`, `:768#archived_at`, and the following-feed at `:1626#archived_at`). **`archived_at` exists on `public.highlights` in production** (schema snapshot), so this is the one Highlights change in this range that a deployed database can actually hold. |
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
| H84 | BAC | **BBW** | **A false green, corrected.** Blocking half stands (`routes/memories.ts:267-283`, `routes/highlights.ts:872-880`). Deletion half is false: `highlights`, `highlight_likes`, `highlight_reports`, `highlight_views` are in `UNCLASSIFIED_BACKLOG` (`lib/deletionDispositions.ts:366-369`), `highlight_replies` in `DENOMINATOR_CORRECTION_BACKLOG` (`:569`); `AccountDeletionService.ts:100-104` confirms. `memories` / `memory_likes` / `memory_saves` remain genuinely cascaded (`:152`). | pre |
| H7 | NB | **BBW** | MemoryEvidenceService: `services/memoryProjections/evidence.ts` — normalization (`:246`), dedup (`:332`), precedence merge (`:364`), eligibility (`:435`), versioned (`:34`, `:36`). No route imports it; `memory_evidence` does not exist. | spec |
| H8 | NB | **BBW** | EpisodeDetectionService: `episodeDetection.ts:244` `detectEpisodes`, deterministic (sorted output, digest ids), `EPISODE_DETECTOR_VERSION` (`:32`). No inputs exist — `memory_evidence` and `memory_episodes` are still absent. | spec |
| H9 | NB | **BBW** | MemoryEligibilityService: `evidence.ts:435` `evaluateEligibility` with a closed rejection-reason set (`:391`). Test-only. | spec |
| H12 | NB | **BBW** | HighlightService: `services/highlights/` — ranking (`highlightRanking.ts:278`), lifecycle (`highlightLifecycle.ts:256`), projection policy, resurfacing, revocation. Three are wired into `routes/highlights.ts`; the two that would build and rank a Highlight are not. | spec |
| H13 | NB | **BBW** | MemorySearchService: `services/memoryRetrieval/searchMemories.ts:169`. Test-only; the projections it reads have no registry rows because 2730 is unapplied. | spec |
| H42 | NB | **BBW** | `ConfidenceBand` is declared with the spec's exact four members (`evidence.ts:59`) and computed (`confidenceBandOf`, `:593#confidenceBandOf`). No column stores it; nothing consumes it. | spec |
| H45 | NB | **BBW** | `MemoryRelationType` (`memoryGraph.ts:54, 58`) and a validated `MemoryEdge` (`:64, 73`). `memory_relations` still does not exist. | spec |
| H46 | NB | **BBW** | `HIGHLIGHT_LIFETIME_CLASSES` and §12's defaults table verbatim (`highlightLifecycle.ts:61, 73`). `highlights.lifetime_class` does not exist (2723 unapplied). | spec |
| H47 | NB | **BBW** | Truth precedence is encoded as an ordering, not prose: `precedenceRank` (`evidence.ts:81`) with `mergeByPrecedence` (`:364`). Governs no stored fact. | spec |
| H63 | NB | **BBW** | `scoreSignificance` (`significance.ts:162`) returns the score **with every contribution that produced it** — input code, weight, delta, cap, overriding rule — under `SIGNIFICANCE_POLICY_VERSION` (`:34`). Reachable from nothing. | spec |
| H64 | NB | **BBW** | `SIGNIFICANCE_FIELDS` + `redactSignificanceForAudience` (`significance.ts:285, 291`) strip the score for an audience. Scored BBW, not BAC, per A.2: nothing publishes the score, so the strip has never run in anger. | spec |
| H65 | NB | **BBW** | `MEDIA_QUALITY_MAX_CONTRIBUTION` (`significance.ts:86`) caps media quality at its own weight. Same limit as H64. | spec |
| H66 | NB | **BBW** | Explicit intent is a hard rule inside `scoreSignificance` rather than a weight (`significance.ts:162` and the contribution list it returns). Same limit. | spec |
| H75 | NB | **BBW** | `MEMORY_CONSENT_DIMENSIONS` (`highlightProjectionPolicy.ts:63`) is the spec's five, with `consentFromRow` / `mayProject` (`:87, 101`) treating `unknown` as withheld. `highlight_projection_policies` is 2721, **unapplied**, so `readProjectionPolicies` returns `absent` and nothing is enforced (`:228`). | spec |
| H81 | NB | **BBW** | `clampLocationToPrecision` (`highlightProjectionPolicy.ts:165`) and `resolveLocationDisclosure` (`:205`), wired into the feeds (`routes/highlights.ts:23`, applied at `:146#applyLocationPrecision`). Unenforced today for exactly the reason the file states: no policy table. | spec |
| H82 | NB | **BBW** | Same clamp, and `strictestPrecision` (`:134`) means a policy can only tighten. Same unapplied storage. | spec |
| H86 | NB | **BBW** | `SENSITIVE_CONTEXT_CATEGORIES` (`highlightResurfacing.ts:66`) plus `SENSITIVE_CATEGORY_REGISTRY_MAPPING` (`:93`) binding them to the existing `lib/protectedLocations.ts` registry — which is the connection the body found missing. The mapping is declared; no read on either surface consults it yet. | spec |
| H89 | NB | **BBW** | `HIDE_PERSON_FROM_RESURFACING` is a declared control (`highlightResurfacing.ts:129`) and is applied on the proactive feeds by owner id (`routes/highlights.ts:112`). Storage is 2720, **unapplied**: `applyResurfacingControls` logs "§11 resurfacing controls are NOT DEPLOYED — feed served without them" (`:96-102`) and suppresses nothing. | spec |
| H90 | NB | **BBW** | `HIDE_TRIP` declared (`highlightResurfacing.ts:129`) with its surface effects (`:157`). Same unapplied storage; no trip-keyed subject reaches the feed filter. | spec |
| H91 | NB | **BBW** | `KEEP_PRIVATE_FOREVER` declared and in `FEED_SUPPRESSING_CONTROLS` (`routes/highlights.ts:79`). Same unapplied storage. | spec |
| H99 | NB | **BBW** | `HIGHLIGHT_RANKING_FACTORS` (`highlightRanking.ts:61`) is §12's seven verbatim and `rankHighlights` (`:278`) computes them. No `ranking_score` column (2723) and no route calls it — `routes/highlights.ts` still orders by `created_at`. | spec |
| H100 | NB | **BBW** | `manual_pin` is the first ranking factor and outranks the rest by construction. No pin column, no pin route, no pin in the client. | spec |
| H101 | NB | **BBW** | `DIVERSITY_DIMENSIONS` (`highlightRanking.ts:74`) is trip/person/venue/activity, applied inside `rankHighlights`. Unreachable. | spec |
| H175 | NB | **BBW** | `Idempotency-Key` is now read on the memory command routes (`lib/memoryCommandBus.ts:434, 440`; `routes/memories.ts:308`) and carried into every dispatch. The receipt table is 2710, **unapplied**, so with the kernel off a replayed key produces a second write and only a log line records the key (`MemoryDomainService.ts:360-370`). | spec |
| H187 | NB | **BBW** | `DO_NOT_RESURFACE` is declared, its surface effects are enumerated against §21's table (`highlightResurfacing.ts:157`), and it is applied to both proactive feeds. Storage unapplied (2720). Still no such control on a **Memory** — this is the Highlights surface only. | spec |
| H188 | NB | **BBW** | `RETAIN_BUT_DO_NOT_PERSONALIZE` is separated from `DO_NOT_RESURFACE` — the body's complaint that the two were inseparable no longer holds in the vocabulary (`highlightResurfacing.ts:144-157`). Storage unapplied. | spec |
| H192 | NB | **BBW** | `REVOCATION_DESTINATIONS` (`highlightRevocation.ts:168`) is §21's eight verbatim and `executeRevocation` (`:305`) is wired into `DELETE /highlights/:id` (`routes/highlights.ts:945`). **One of the eight is actually reached** — `cached_narrative`, and the outcome text says frankly that even that is guaranteed only for the in-process L1 cache. The rest report `not_applicable` or `not_implemented`, which the type distinguishes from success (`:180-188`). | spec |
| H200 | NB | **BBW** | The publication policy exists as an artifact (`highlightProjectionPolicy.ts:333` `PROJECTION_POLICY_COLUMNS`, `:364` `readProjectionPolicies`) and is consulted on the feeds. Its table is 2721, **unapplied**, so there is no policy to be behind. | spec |
| H201 | NB | **BBW** | The precision ladder is now applied on a durable public surface — Highlight `location_name` / `city` / `country` are rewritten to the owner's rung before serving (`artifacts/api-server/src/routes/highlights.ts:146#applyLocationPrecision`, `highlightProjectionPolicy.ts:165`). It does not reach a Memory's `location_lat` / `location_lng`, and it is unenforced until 2721 lands. | spec |
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
| H79 (public search must query a derivative, never canonical + post-filter) | **BBW** | `routes/memories.ts:241-283` is untouched by this range: still the service client over canonical `memories`, still `.limit()` before block filtering. `PublicMemoryProjection` exists in the registry and nothing routes through it. This is the single largest gap between the code that landed and the code that serves traffic. |
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

> **ATTRIBUTION METHOD NOTE, 2026-09-14.** The 63 stand: each rests on an artifact whose own
> header names `docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt`
> and the sections it implements — positive evidence of attribution TO this spec, which is
> the strongest form this corpus has. That is measured at this tree:
> `artifacts/api-server/src/lib/memoryCommandBus.ts:4#Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt`
> is one of 30 source files carrying that path.
>
> **"0 of the 16 BAC verdicts are" means 0 of them CITE this spec, and nothing more.** It is
> not a finding that those 16 were built for something else. Their attribution is UNKNOWN —
> see the restatement under the Headline. The distinction matters most exactly here, where
> the same section reports both kinds of number in the same sentence: one is evidenced, the
> other is an absence.

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
| The wiring | `artifacts/api-server/src/scripts/checkMemoryCertification.ts:42#async`, `artifacts/api-server/package.json:53#check:memory-certification`, `artifacts/api-server/scripts/run-all-checks.sh:169#run_check`, `artifacts/api-server/src/scripts/guardRegistry.ts:563#checker` | It runs in `check:all`. `run-all-checks.sh` goes from 25 passed to **26**; the five exit-2 checks are unchanged (they need live credentials this pass must not supply). |

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
  longer true: at `artifacts/api-server/src/routes/memories.ts:584#router.get` every privacy
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
   pulls in the revocation service and `artifacts/api-server/src/routes/highlights.ts:146#function`
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
| H105 | Life Chapters are projections, not duplicated Memories | BBW | `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:227#buildLifeChapters` emits ids, counts and a derived label — no caption and no media is copied upward, which is the §28.8 rule. **Evidence corrected in §J: "Unreachable" understated it.** The function took a `themes` argument that NOTHING produced, so the LIFE_CHAPTER level was not merely uncalled, it was structurally empty. `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:320#deriveChapterThemes` is that missing producer and `artifacts/api-server/src/routes/memories.ts:835#router.get` serves it. **The verdict does not move**, because §E.5 ruled the only thing left — a surface to wire it to — product-blocked, and §J declines to overturn that on its own authority |
| H106 | Relationship edge types | BBW | `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:58#MEMORY_RELATION_TYPES` is §4's nine, with a validated edge shape at `:64`. No `memory_relations` table |

#### §14 Executable memories (H107–H109)

| id | requirement | verdict | evidence |
|---|---|---|---|
| H107 | Do-again compiled through current-world / Temporal-Freedom engines | NB | A repository-wide grep for `doAgain`, `do_again`, `takeMeBack` and `take_me_back` across `artifacts/` and `travel-buddy-standalone/` in `.ts`, `.tsx` and `.sql` returns nothing at all — not a fixture, not a comment |
| H108 | The eight executable actions | NB | Same grep. `add_to_trip` (`artifacts/api-server/src/compass/CompassTools.ts:452#add_to_trip`) adds a PLACE to a trip and knows nothing about a Memory |
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

`artifacts/api-server/src/compass/CompassTools.ts:144#get_user_profile` opens a list of **eleven** tools —
`get_user_profile`, `get_current_trip`, `search_places`, `search_events`,
`get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`,
`get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`. Not one is
memory-facing, so there is no memory-facing LLM path for §16's six boundary rules to
constrain either.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H115 | `getMemory` | NB | Not in the eleven tools at `artifacts/api-server/src/compass/CompassTools.ts:144#get_user_profile` |
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
through `artifacts/api-server/src/services/memory/MemoryDomainService.ts:437#dispatchMemoryCommand`;
the other six are listed with their reasons at `:306#MEMORY_COMMAND_TYPES_NOT_DECLARED`.
**Every declared command is BBW for one shared reason** and it is not repeated in each row:
the durable receipt, the audit row and the event emit all live in `memory_kernel_execute`,
migrations 2710 and 2711, which are **not applied** — the postcondition at
`artifacts/api-server/src/migrations/2711_memory_kernel_execute.sql:554#IF` even asserts the
flag is still false — so `memory_kernel_enabled` has no row, `isFlagEnabled` is fail-closed,
and each write is the legacy direct write with a log line marked `durable:false`
(`artifacts/api-server/src/services/memory/MemoryDomainService.ts:189#auditCommand`).

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
| H138 | `ADD_PERSON` | BBW | Declared; authorized as consent — the tagged person only — at `artifacts/api-server/src/services/memory/MemoryDomainService.ts:372#authorizeParticipantCommand` |
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
is the shared owner filter: it drops `deleted` and `removed`. **That sentence used to read
"No route, lib or service outside `src/test/` and `src/services/memoryCertification/` imports
the registry", and section J falsified it**: `artifacts/api-server/src/routes/memories.ts:73#getProjectionDefinition`
imports it and `GET /trips/:tripId/memories/recap` serves one of the eleven. It is still true of
the other ten, which is why only H166 moves below and the rest keep their verdicts for their own
stated reasons.

| id | requirement | verdict | evidence |
|---|---|---|---|
| H163 | MemoryTimelineProjection — owner private timeline | BBW | Defined in the registry and unreachable. What ships is `travel-buddy-standalone/src/lib/memoryTimeline.ts:2#memoryTimeline`, a pure CLIENT-side month grouping over `passport_memories` that declares itself Passport §15 — not a server projection and not over Memories |
| H164 | PassportMemoryProjection | BBW | Defined in the registry. The shipped artifact is `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:19#Discovery`, which projects Passport artefacts to four consumers, not Memories |
| H165 | ProfileHighlightProjection — audience-specific profile | BBW | Defined, with a viewer-aware filter and a seven-field whitelist. `routes/highlights.ts` still returns raw highlight rows filtered by viewer permission; no audience-specific narrowing |
| H166 | TripMemoryProjection — trip recap | **BAC** | Defined and scoped by `trip_id`, and **consumed since section J** by `artifacts/api-server/src/routes/memories.ts:2594#router.get` — §23's ladder runs per row BEFORE the builder, §10's person ladder narrows `people` before the builder sees a tag, and the eight-field whitelist is what keeps `caption` and the coordinate off the wire. (The row's old evidence, *"`GET /trips/:tripId/memory` returns a raw list"*, was falsified in §H.7 — that route returns a single `{ memory }` and always did.) **CEILING: the recap is built per request and NOT registered**, because the registry table is 2730 and unapplied (H174), so there is no registration to revoke and `sourceVersion` travels on the response instead of being stored |
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
`artifacts/api-server/src/services/memory/MemoryDomainService.ts:219#place_correction_rate`
and again at `artifacts/api-server/src/routes/memories.ts:1496#place_correction_rate`, both
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
| H215 | `place_correction_rate` | NB | Named in two comments — `artifacts/api-server/src/services/memory/MemoryDomainService.ts:219#place_correction_rate` and `artifacts/api-server/src/routes/memories.ts:1496#place_correction_rate` — both saying the command exists so the metric COULD be counted. No counter is incremented anywhere |
| H216 | `participant_correction_rate` | NB | Occurs only in this census and the spec. ADD_PERSON / REMOVE_PERSON are dispatched and counted by nothing |
| H217 | `false_memory_rate` | NB | Occurs only in this census and the spec. It is corrected-over-surfaced inferred assertions, and neither quantity is stored anywhere |
| H218 | `explicit_memory_without_candidate_rate` | NB | Occurs only in this census and the spec |
| H219 | `privacy_revocation_latency` | NB | Occurs only in this census and the spec. `executeRevocation` produces a per-destination report and no timing at all (`artifacts/api-server/src/services/highlights/highlightRevocation.ts:168#REVOCATION_DESTINATIONS`) |
| H220 | `projection_lag` | NB | Named in one comment, `artifacts/api-server/src/lib/memoryOutbox.ts:233#projection_lag`. `projectionStaleness` answers FRESH / STALE / REVOKED / NOT_REGISTERED and emits no lag figure. The `projection_lag_seconds` in `artifacts/api-server/src/server/trips/outboxWorker.ts:41#projection_lag_seconds` is the Trips map worker's, not this one |
| H221 | `resurfacing_suppression_violations` ("must be zero") | NB | Occurs only in this census and the spec. Nothing counts a violation, and with 2720 unapplied the suppression set is `absent`, so a violation could not be DETECTED if it happened — the metric §24 says must be zero is one nothing could observe being non-zero |
| H222 | `do_again_conversion` | NB | Occurs only in this census and the spec, and there is no do-again to convert (H107) |
| H223 | Operational logs carry memoryId, commandId, eventId, source version, engine version, reason codes, projection name, failure class | BBW | `artifacts/api-server/src/services/memory/MemoryDomainService.ts:189#auditCommand` emits `memoryId`, `commandId`, `eventId`, `reason` and `engineVersion` (`:202#engineVersion`), and deliberately nothing from the Memory's body. **Three of the eight are missing**: source version, projection name and failure class. `eventId` is always null while the kernel is off |

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
| H237 | Invariant: deleted memory cannot remain in Compass retrieval | BBW | HELD on the only Compass-facing memory artifact that exists: the deleted Memory leaves `CompassMemoryProjection`, its registration is revoked with an emptied payload, and reading the revoked derivative refuses with `derivative_revoked` rather than returning an empty page. **BBW because the named surface does not exist** — `artifacts/api-server/src/compass/CompassTools.ts:144#get_user_profile` declares no memory tool |
| H238 | Invariant: rejected candidate cannot become a Highlight | NB | `NO_SURFACE`. The rejection half is real and asserted; the second half has nothing to assert against, because nothing turns a candidate into a Highlight — `highlight_sources` is 2722, unapplied, with no writer, and `POST /highlights` inserts a client-supplied `mediaUrl`. The suite asserts this exact status at `artifacts/api-server/src/test/memoryCertificationInvariants.test.ts:117#reports` so it can never drift into looking like a pass |
| H239 | Invariant: planned activity without occurrence cannot earn a visit Memory/Stamp | BBW | HELD: PLANNED+SAVED alone is refused with `PLANNED_OR_SAVED_ONLY` and the same set plus one OCCURRED record is eligible, so the refusal is the intent rule and not a blanket deny. BBW because it is proved on `evidence.ts`, which no route imports; the live stamp path enforces the rule by requiring a real check-in (H4) and is not covered by this test |
| H240 | Invariant: blocked person cannot be newly resurfaced through shared-memory recommendations | **BAC** | HELD on a module a route imports, and the live half was already covered: `HIDE_PERSON_FROM_RESURFACING` suppresses exactly its subject across proactive resurfacing and recap, does not leak to another participant, and an UNREADABLE preference set suppresses rather than serving. `artifacts/api-server/src/test/memoriesBlockFailClosed.test.ts:109#describe` covers the live feed's fail-closed block filter. **Ceiling: 2720 is unapplied, so in production the set is `absent` and suppresses nothing** |
| H241 | Invariant: public location precision cannot exceed owner policy | **BAC** | HELD over the whole ladder: the disclosed field set is monotone toward HIDDEN, HIDDEN discloses nothing, `strictestPrecision` can only tighten, and both an unreadable policy row and an unparseable one clamp to HIDDEN. The module is imported by `artifacts/api-server/src/routes/highlights.ts:146#function`. Mutation 4 turned it red. **Ceiling: 2721 is unapplied, so no rung is ever stored and the clamp never runs** |
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
| H264 | §28.11 — never swallow projection or schema failures into plausible-looking empty history without a structured error state | **BAC** | `artifacts/api-server/src/routes/memories.ts:637#req.log.error` returns `db_error` on a block-lookup failure rather than serving an unfiltered feed, and `loadMemoryGemContext` records `determined: false` and coarsens rather than passing silently. §25's `PROJECTION_WORKER_OUTAGE` (H247) now makes the same rule executable one layer down: an unreadable registry refuses with a named reason instead of returning zero rows |
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
`artifacts/api-server/src/compass/CompassTools.ts:140#COMPASS_TOOL_DEFINITIONS` now holds
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
| the eleven-tool list (×3 rows) | `CompassTools.ts:144#name` | `CompassTools.ts:144#get_user_profile` | `:83` had drifted onto a comment. **It was passing `check:doc-citations` anyway**, because the anchor was the single token `name` and line 83 reads "…the Telegraph spec names." A one-word anchor is a substring lottery; the replacement anchors on the tool name itself. |
| `add_to_trip` | `CompassTools.ts:185#name` | `CompassTools.ts:452#add_to_trip` | Same defect, worse outcome: `:157` is now `get_place_details`, and `#name` matched it happily. |
| the tool array (§16 rows) | `CompassTools.ts:67-215` | `CompassTools.ts:99-473` | The array's real extent on the merged tree. |
| H129's tool set | `CompassTools.ts:67` | `CompassTools.ts:99` | Same. |
| H129's write-shaped tool | `:158` | `CompassTools.ts:411` | Bare `:158` also named no file; now fully qualified. |
| H129's `forgetMemory` | `routes/compass.ts:2199` | `routes/compass.ts:2275` | +76 lines above it; the call is unchanged. |
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
| §23's ladder, no longer module-private | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:90#canReadMemory` | Moved out of `routes/memories.ts` comment for comment. Nothing in the ladder changed. `routes/memories.ts:214#memoryReadPolicy.js` imports it back, so the repository has one copy where it had one private one. |
| A fifth read surface | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:82#MemoryReadSurface` | `"compass"` joins single, profile, trip and public_feed. It runs the ADDRESSED ladder, not the feed rule, because a Memory shared with this viewer is a Memory this viewer may be told about. |
| One gate the eight cannot half-perform | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:276#canCompassReadMemory` | The ladder AND the bidirectional block check in one call. `routes/memories.ts` calls `isBlocked` separately at four read sites, which is fine three lines apart and is not fine across eight accessors. |
| §23's audience predicate | `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:360#canPublishMemory` | Refuses the three combinations `canReadMemory` denies to every non-owner. Reasons and user-facing messages at `artifacts/api-server/src/services/memory/memoryReadPolicy.ts:339#PUBLISH_REFUSAL_MESSAGE`. Wired at `artifacts/api-server/src/routes/memories.ts:458#canPublishMemory` (POST) and `:1440#canPublishMemory` (PATCH, on the MERGED row). |
| §14's invariant as a datum, not a habit | `artifacts/api-server/src/services/memory/historicalTruth.ts:88#establishes_current_status` | Every Memory fact leaves the tools carrying `establishes_current_status: false`. A consumer cannot drop the caveat without dropping a field. |
| §14's refusal | `artifacts/api-server/src/services/memory/historicalTruth.ts:194#currentWorldReading` | A current-world claim built from a `historical` or `ai_inference` source class is REFUSED and comes back unavailable. The admitted set is two names at `:67#CURRENT_WORLD_SOURCE_CLASSES`. |
| §14's fusion, which is a juxtaposition | `artifacts/api-server/src/services/memory/historicalTruth.ts:224#fuseHistoricalWithCurrent` | Returns both halves with `merged: false` and sets `may_state_current_status` from the CURRENT half alone. There is no code path in the module that produces one merged claim. |
| §16's eight accessors | `artifacts/api-server/src/compass/MemoryCompassTools.ts:102#MEMORY_TOOL_SPEC_NAMES` | The spec's eight names, in the spec's order, mapped to tool names. Definitions at `:785#MEMORY_COMPASS_TOOL_DEFINITIONS`, dispatcher at `:949#executeMemoryCompassTool`. |
| No coordinate is selectable | `artifacts/api-server/src/compass/MemoryCompassTools.ts:133#MEMORY_FACT_COLUMNS` | `location_lat` and `location_lng` are not in the select list at all, so `sanitizeToolResult` is defence in depth rather than the defence. |
| Attendance is only an APPROVED tag | `artifacts/api-server/src/compass/MemoryCompassTools.ts:440#unconfirmed_participation` | A `pending` memory_tag is the OWNER's assertion about somebody who has not confirmed it, and it comes back under a key that says so. A `removed` tag is not reported at all. |
| The accessor that has to say "there is none" | `artifacts/api-server/src/compass/MemoryCompassTools.ts:593#evidence_store` | `getMemoryEvidence` answers `evidence_store: "absent"` first, then lists the artifacts attached to the Memory with a caveat that they are not §6-normalized evidence. |
| The minimum clarifying question | `artifacts/api-server/src/compass/MemoryCompassTools.ts:698#clarifyingQuestion` | Three material facts, ONE question, in a fixed priority order. A draft missing all three produces one question, not an interrogation. |
| Two write-shaped tools that write nothing | `artifacts/api-server/src/compass/MemoryCompassTools.ts:658#toolMemoryCreateDraft` and `:728#toolMemorySuggestCorrection` | Both return a proposal with `requires_confirmation` and a `confirm_via` naming the existing authenticated route, which re-authorizes. Field allow-lists at `:637#DRAFTABLE_FIELDS` and `:641#CORRECTABLE_FIELDS`, both deliberately SHORTER than `patchMemorySchema`: audience lists, visibility and lifecycle state cannot be proposed by prose. |
| The wiring | `artifacts/api-server/src/compass/CompassTools.ts:514#MEMORY_COMPASS_TOOL_DEFINITIONS` (spread) and `artifacts/api-server/src/compass/CompassTools.ts:1991#MEMORY_COMPASS_TOOL_NAMES.has` (dispatch) | One import, one spread, one branch, one prompt block — the shape Telegraph's §18.3 block already established in this file. |
| The §16 boundary as prompt text | `artifacts/api-server/src/compass/MemoryCompassTools.ts:940#MEMORY_COMPASS_PROMPT_RULES` | Listed LAST on purpose. It is the weakest of the three layers, and it exists only for §16's "may" clauses, which cannot be expressed as a refusal. |
| The suites | `artifacts/api-server/src/test/memoryCompassTools.test.ts:300#bypass` (35 tests) and `artifacts/api-server/src/test/memoryPublishPolicy.test.ts:195#refuses` (18 tests) | Both registered in `package.json`'s `test` script. |

**The two greps section B.7 wrote are the ones that decide §16, so here they are re-run rather
than described.** B.7 recorded `grep -cE 'name: "[a-z_]*(memor|highlight|storie)'` over the tool
files returning **0** and **0**, and a grep for a tool implementation reading a Memory table
returning nothing. On this commit the first returns **8** and the second returns the eight
accessors. A test asserts the first mechanically, in the definition list rather than by shelling
out: `artifacts/api-server/src/test/memoryCompassTools.test.ts:247#offered`.

### C.2 Reachability, stated as a chain with its weak links named

`POST /compass/ask` → `COMPASS_TOOL_DEFINITIONS` handed to the model
(`artifacts/api-server/src/routes/compass.ts:1295#COMPASS_TOOL_DEFINITIONS`) → the model emits a
tool call → `executeCompassTool` dispatches by name → `executeMemoryCompassTool`.

Three things that chain depends on, each said rather than assumed:

1. **`COMPASS_ENABLED`.** Read fail-closed at
   `artifacts/api-server/src/routes/compass.ts:1384#isCompassEnabled`. The committed production
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

## D. The 134-row gap, grouped — and the two live defects that grouping found — 2026-09-13

This section exists because of one instruction: **shrink the gap between CONSTRUCTED and
CORRECT by making the code right, not by re-labelling rows.** At section C's close this
document stood at **C=52 W=134 N=78 X=2 — 69.9 % constructed, 19.5 % correct, a 50.4-point
gap, the worst in the corpus.** The gap IS the W column: 134 requirements that are built and
are wrong.

Nobody had ever asked what those 134 rows have in common. So that was done first, and the
answer changed what this pass built.

### D.1 The 134 W rows, grouped by WHY — measured, not estimated

Every W row was assigned exactly one group: **the first thing standing between it and
CORRECT.** A row behind an unapplied migration is (c) even when nothing calls its code
either, because calling it would not make it true. The assignment is reproducible — it is a
table of ids, not a judgement per reading — and it is printed in full below rather than
summarised, so a reader who disagrees with a placement can say which one.

| group | rows | what it means |
|---|---:|---|
| **(a)** logic wrong or incomplete in code, nothing external stops the fix | **9** | the only group where correctness moves by typing |
| **(b)** logic right, nothing reaches it — wiring needs no migration and no flag | **6** | |
| **(c)** capped by an unapplied migration, an absent column, or a flag with no row | **107** | |
| **(d)** rests on an LLM choosing to call something, which nothing here measures | **3** | owner decision D-C2, inherited from §C |
| **(e)** needs something nobody has written | **9** | |

**Eighty percent of this census's correctness gap is not code.** 107 of 134 rows are
capped by storage that is written and not deployed — 2710, 2711, 2720, 2721, 2722, 2723,
2730, 2338, 2339 — or by columns §3 names that no migration creates. No amount of
engineering on this branch moves them: the remedy is `supabase migration up` and a flag,
and both are owner acts this lane may not perform. **The largest single act available to
anyone who wants this census's CORRECT% to move is applying eight migrations.** That is the
finding, and it was not visible until the rows were counted.

The groups in full:

#### (a) — 9 rows: logic wrong or incomplete, fixable in code

| id | what stands in the way |
|---|---|
| H6 | lifecycle guard and audit now exist; versioning and merge/split do not, and merge/split is (e) |
| H10 | MemoryPrivacyService does not exist as a service; its parts are scattered across three files that already run |
| H77 | `lib/publicIdentity.ts` implements 2 of §10's 5 rungs; CREW_ONLY and ANONYMOUS_COUNT are derivable from `memory_tags` + `trip_members`, both deployed |
| H84 | the blocking half holds; the deletion half needs `highlights` and its four children moved out of `UNCLASSIFIED_BACKLOG` — owner decision D6 |
| H189 | **PARTLY CLOSED HERE.** Making a Memory private now revokes the one public derivative production has. The `compass_feed_cache` half is still not invalidated |
| H190 | **PARTLY CLOSED HERE.** The same revocation covers a soft delete. Media bytes stay publicly served |
| H193 | per-Memory deletion has no named step, no report and no retry; the account-deletion machinery next door has all three |
| H202 | the service client is a blanket RLS bypass on every memory/highlight route; per-surface scoping and an audit trail are code |
| H237 | **CLOSED HERE.** The Compass graph builder was upsert-only, so a deleted or narrowed Memory stayed in a Compass projection forever |

#### (b) — 6 rows: logic right, nothing reaches it

| id | what stands in the way |
|---|---|
| H5 | **CLOSED HERE.** The §1 truth class now rides on every canonical Memory payload the domain serves |
| H104, H105 | the compression hierarchy and Life Chapters are pure functions over `memories`; nothing calls them |
| H165, H166 | `ProfileHighlightProjection` / `TripMemoryProjection` are pure over tables production has. Wiring them needs no migration — and changes a response shape live clients read, which is why this pass did not do it on its own authority |
| H198 | one read helper now instead of five inline copies, and every read still runs on the service client — the default is TypeScript, not RLS |

#### (c) — 107 rows: capped by storage nobody has applied

| ids | what stands in the way |
|---|---|
| H13, H110–H114, H162, H163, H164, H167–H170, H173, H174 | 2730 `memory_derivative_registry`, **UNAPPLIED** |
| H175, H130–H133, H136–H141 | 2710 audit/receipt tables **UNAPPLIED**, and `memory_kernel_enabled` has **no row** in production |
| H147–H149, H152–H154, H160 | 2711 `memory_kernel_execute` **UNAPPLIED** — the emit is inside the function, so no domain event is ever emitted |
| H86–H91, H187, H188 | 2720 `highlight_resurfacing_preferences`, **UNAPPLIED** |
| H75, H81, H82, H200, H201, H209, H210 | 2721 `highlight_projection_policies`, **UNAPPLIED** |
| H93 | 2722 `highlight_sources`, **UNAPPLIED** |
| H46, H99–H101, H257 | 2723 lifetime class / ranking score / pin, **UNAPPLIED** |
| H44, H76, H79, H208 | 2338 `memories.location_precision` + the public-feed derivative, **UNAPPLIED** |
| H7, H9, H54–H57 | §3.6 `memory_evidence` — no table deployed; the normalizer and eligibility gate run only on fixtures |
| H8, H58–H61 | §3.6 `memory_episodes` + `memory_evidence` — the detector has no input store |
| H17, H21, H22, H25, H31, H38, H41, H42, H68 | the columns and tables §3 names are not on the deployed schema |
| H63–H66 | significance is computed; there is no column to store it on and no surface that publishes it |
| H47, H48, H49, H67 | precedence, correction-durability and the candidate thresholds all need the evidence/candidate stores |
| H11, H12, H50, H51, H144, H145 | the bounded services and the two lifecycle machines, each capped by one of the above |
| H15 | the `memory_recaps` flag is seeded FALSE |
| H103 | `highlights_feed_bounded_enabled` (2339) is not in the applied list |
| H223 | **SEVEN of §24's eight log fields now land** (see D.3). `projectionName` has no reachable projection log, because the projection half is 2730 |
| H239, H242–H244, H249, H252 | §25 invariants, certified against fixtures of the unapplied stores |
| H254–H256, H258, H260, H261 | phase rows; each aggregates rows already capped above |

#### (d) — 3 rows: the unobservable LLM leg

| ids | what stands in the way |
|---|---|
| H120, H123, H126 | a §16 permission whose remaining leg is prompt text handed to a model behind `tool_choice: "auto"`, through an OpenAI credential this repository does not record |

**This pass added nothing to group (d) and moved nothing out of it.** Section C's own note
stands: fourteen of its C rows rest on a model choosing to call a function, and nothing in
this repository can show that it ever has. That is open owner decision **D-C2**, and this
section neither closes it nor leans on it. Every row moved below is reachable by an ordinary
HTTP request or by a scheduler that runs whether or not anyone talks to Compass.

#### (e) — 9 rows: nobody has written it

| ids | what stands in the way |
|---|---|
| H45, H62, H106, H124 | `memory_relations` has **no migration anywhere in the tree** — not written, not unapplied. Its only appearance in any `.sql` file is a comment in 2711 saying it does not exist |
| H181, H183 | Memory media never enters the staged `post_media` pipeline; there is no memory-media pipeline to fix |
| H192 | seven of §21's eight revocation destinations do not exist as destinations |
| H2 | §1's private-first mandate for AUTOMATIC Memories. The automatic path that would default is the candidate pipeline, which does not exist |
| H43 | `friends_only` is mutual-follow and the spec's rung is FOLLOWERS — changing it is a product decision about who sees what |

### D.2 What grouping found: two live defects, in the one Compass projection production has

Group (a) is where the work is, and reading it surfaced something none of the previous three
passes of THIS census looked at. Every earlier pass searched the files this document already
watched. This one asked a different question — *which code in this repository reads the
`memories` table?* — and found a reader no section of this document had ever named.

**HALF OF WHAT FOLLOWS WAS ALREADY ON THE RECORD, IN ANOTHER CENSUS, AND THIS SECTION DID NOT
FIND IT.** `census-compass.md` CH-03 has scored the §28.8 half **W** with the defect stated
exactly: *"a graph **node** built from a memory persists after that memory is deleted: the only
pruning is of stale city/time-slice keys … no deletion hook, no per-memory prune."* That is the
finding, written by the Compass lane, and it sat there while this census's H237 read as though
`CompassMemoryProjection` were "the only Compass-facing memory artifact that exists". Two
censuses were looking at the same file and only one of them could see it. What this section adds
to CH-03 is the fix and the §28.10 half beside it; the observation was not its own, and claiming
it would be the exact overclaim this corpus exists to catch.

`artifacts/api-server/src/compass/CompassGraphEngine.ts:720#Experiences` builds the Travel Intelligence
Graph from `public.memories`. Its output lands in `compass_graph_nodes` and
`compass_graph_edges`; `buildCityWorldModels` and `computeCityConfidenceIndex` fold those into
per-city Destination World Models and the city-confidence index, which reach **every** user
through the Compass feed, the prompt context lines and `lib/discoveryModifiers.ts`. All four
tables are in the committed production schema snapshot. The rebuild is **not** on-demand: it
runs daily from
`artifacts/api-server/src/lib/intelligenceGraphScheduler.ts:30#REBUILD_INTERVAL_MS`, started at
boot by `artifacts/api-server/src/index.ts:128#startIntelligenceGraphScheduler`.

**Defect 1 — §28.10, eligibility.** The gate was `state = 'published' AND visibility <>
'only_me'`. `memories.visibility` is a **six**-rung ladder, so `<> 'only_me'` admitted four
private audiences — `friends_only`, `trip_crew`, `circle_only` and `custom` — and
`hidden_user_ids` was never consulted. The comment beside it argued the gate respected "the
owner's explicit choice"; it respected one of the owner's five explicit choices. §28.10:
"Never route public-world intelligence directly from private Memory without
consent/eligibility/anonymization." Anonymization held — the read APIs return aggregates.
Consent and eligibility did not.

**Defect 2 — §28.8, revocation.** The builder persists with `upsert` and nothing else. Upsert
adds and updates; it never removes. A Memory that was public on Monday and is deleted,
archived, or narrowed on Tuesday kept its experience node and its person/place/trip/event/city
edges indefinitely, and kept contributing to the city's world model and confidence score. The
daily rebuild did not fix that — it reran the same additive build. §28.8: "Never keep deleted
Memories in embeddings, public caches, Highlights, Passport, or **Compass projections**."
§21 says the same for a narrowing: "Make private: revoke public derivatives."

**Defect 2 was known and unrepaired for at least one census cycle.** CH-03 named it, scored it,
bounded the leak correctly ("*this owner was at this place/trip/event*"), and nothing was built
— because it is a Compass row about a Memories rule, and neither lane owned both halves. That is
a corpus-level failure mode worth naming: a defect FOUND by one census and FIXABLE by another
can sit indefinitely in the seam, fully documented, with both documents telling the truth.

**This falsified a green.** H263 (§28.10) has read **BUILT-AND-CORRECT** since section B on the
evidence "*The only path from derived memory to any shared surface is
`artifacts/api-server/src/lib/mapProducers/memoryProducer.ts:13#memory_remembers_for_user` … Nothing feeds memory into world
intelligence.*" There was a second path, it was daily, and it carried four private audiences.
**H263 was a false green at `f8384ea5b` and its C was not earned.** It is green at the end of
this pass because the code was changed, not because the sentence was rewritten — and the row
below says so in those words rather than quietly repointing the citation.

### D.3 What was built

**1. §28.10 eligibility, stated once and used by both halves.**
`artifacts/api-server/src/compass/CompassGraphEngine.ts:548#isPublicWorldMemory` is `isPublicWorldMemory`
— `state === "published" && visibility === "public"`. One definition, because the builder that
ADDS an experience node and the sweep that REMOVES one must agree; when they disagree the
graph either keeps a row it would no longer admit or deletes one it just wrote, and neither
failure announces itself. The query now asks the database for it
(`artifacts/api-server/src/compass/CompassGraphEngine.ts:768#visibility`) **and** the
loop re-asserts it (`artifacts/api-server/src/compass/CompassGraphEngine.ts:775#isPublicWorldMemory`). Both are
separately mutation-covered, because defence in depth that nothing exercises is a comment.

**2. §28.8 revocation.**
`artifacts/api-server/src/compass/CompassGraphEngine.ts:1478#reconcileExperienceNodes` is
`reconcileExperienceNodes`: it reads the persisted `experience` node keys, asks `memories`
about **those ids**, and deletes the nodes — and every edge touching them — whose Memory is
gone or no longer eligible. Three design choices, each load-bearing:

  - **Positive, not inferred by absence.** The obvious implementation is "delete every
    experience node this run did not write", and it is wrong: `buildGraphFromSources` reads at
    most `BUILD_LIMIT` (5000) rows, so on a tree with more eligible Memories than that,
    absence from the batch means *not read*, not *not eligible*, and the sweep would erase
    live rows.
  - **Fails closed.** An unreadable `memories` read sets `unresolved` and deletes **nothing**.
    Deleting on a transient outage erases a graph; keeping a stale node one more day is
    recoverable, and the next tick retries. The report distinguishes the two rather than
    reporting zero twice.
  - **Edges first, and before the aggregates are folded.** A node deleted before its edges
    leaves orphan `in_city` edges, and those are what `buildCityWorldModels` counts; a sweep
    run after the fold would let a revoked experience into today's score anyway.
    `artifacts/api-server/src/compass/CompassGraphEngine.ts:1574#experienceRevocations` places it.

**3. §1 in the Memory domain, not only on the Compass surface.**
`artifacts/api-server/src/services/memory/historicalTruth.ts:275#asHistoricalMemoryPayload` is
`asHistoricalMemoryPayload`, and
`artifacts/api-server/src/routes/memories.ts:2810#asHistoricalMemoryPayload` applies it at `mapMemory` — the
single serialization point every memory route returns through. A payload arriving with a
`truthClass` that is not `historical` has the claim **removed**, not merged.

**4. §24's failure class and source version.**
`artifacts/api-server/src/services/memory/MemoryDomainService.ts:159#failureClassOf` is
`failureClassOf`, a closed sort of every declared `MemoryKernelReason` **and** the HTTP codes
the legacy path answers with — which matters because `memory_kernel_enabled` has no row in
production, so 100 % of the refusals a user actually meets come through the legacy branch. It
returns `"unclassified"` rather than guessing, and a test reads the union out of
`lib/memoryCommandBus.ts` so the two sets cannot drift apart silently. `sourceVersion` is the
row's `updated_at` as it was **before** the command, carried from
`loadMemoryForCommand` — no new column, no extra round trip.

**Where the assertions live.** Nine new tests, all in files `package.json`'s `test` script
already runs, so `check:test-registration` covers them:

| what it asserts | file |
|---|---|
| the §28.10 gate, stated once and used by both halves | `artifacts/api-server/src/test/compass-intelligence-graph.test.ts:718#eligibility` |
| the gate runs in the QUERY, not only in the loop | `artifacts/api-server/src/test/compass-intelligence-graph.test.ts:673#eligibility` |
| a client that ignores the predicate still gets nothing private in | `artifacts/api-server/src/test/compass-intelligence-graph.test.ts:639#IGNORES` |
| a rebuild revokes deleted / archived / narrowed / vanished experiences | `artifacts/api-server/src/test/compass-intelligence-graph.test.ts:734#REVOKES` |
| an unreadable `memories` read deletes nothing and says so | `artifacts/api-server/src/test/compass-intelligence-graph.test.ts:777#unreadable` |
| the sweep runs before the aggregates are folded | `artifacts/api-server/src/test/compass-intelligence-graph.test.ts:899#rebuildIntelligenceGraph` |
| §1's truth class on every Memory the REST domain serves | `artifacts/api-server/src/test/memories.test.ts:851#historical` |
| §24's source version, from the route rather than from a hand-built record | `artifacts/api-server/src/test/memories.test.ts:937#source` |
| §24's failure class, and the audit LINE that has to carry it | `artifacts/api-server/src/test/memoryCommandBus.test.ts:359#failure` |

### D.4 Row moves

| id | was | now | why |
|---|---|---|---|
| H5 | W | **C** | §1's separation is now a property of the Memory DOMAIN, which is exactly what section C said was missing: "*`routes/memories.ts` still serializes Memory rows with no truth class on them.*" Every canonical Memory the REST domain serves — single read, discovery feed, profile listing, trip recap, create and patch responses — carries `truthClass: "historical"` and `establishesCurrentStatus: false`, applied by `artifacts/api-server/src/routes/memories.ts:2810#asHistoricalMemoryPayload` rather than written into each handler. **CEILING: this is a declaration on the datum, not an enforcement on the reader.** What is mechanical is that the caveat cannot be dropped without dropping a field, that a payload claiming `current_world` has the claim removed, and that `currentWorldReading` still refuses a historical source class |
| H237 | W | **C** | "Deleted memory cannot remain in Compass retrieval." It now holds on the only Compass projection of Memories **production actually has**: `artifacts/api-server/src/compass/CompassGraphEngine.ts:1478#reconcileExperienceNodes` revokes the experience node and every edge touching it when the Memory is deleted, archived, hard-deleted with its owner's account, or narrowed below `public`. **PART OF THIS MOVE IS A RE-READ, NOT A BUILD, AND IS LABELLED AS SUCH:** the §16 accessors section C built already excluded deleted Memories (`canCompassReadMemory` requires `published`; every tool query filters `state <> 'deleted'`) and this row did not account for them. The BUILD half is the graph sweep. **CEILING: the revocation is bounded by the rebuild's daily cadence**, so a deleted Memory can sit in the aggregate substrate for up to 24 hours, and §24's `privacy_revocation_latency` — the metric that would measure exactly that — does not exist |
| H263 | C | **C** | **NO NET MOVE, AND THAT IS THE WORST WAY TO READ THIS ROW.** Its C was a FALSE GREEN at `f8384ea5b`: its stated evidence was "*the only path from derived memory to any shared surface is `memoryProducer.ts` … Nothing feeds memory into world intelligence*", and `CompassGraphEngine` was a second path, running daily, carrying `friends_only`, `trip_crew`, `circle_only` and `custom` Memories into the Destination World Model. The row ends green because the gate was narrowed to `public` (D.3), not because the sentence was rewritten. Evidence replaced: the rule now holds on **both** paths, and both are named |
| H189 | W | **W** | Evidence corrected, verdict unmoved. The row read "*revokes nothing — there are no derivatives or indexes to revoke, and no cache invalidation on the memories path*". Half of that is now false: there IS a public derivative of a Memory in production — its experience node and edges in the Compass graph — and narrowing a Memory's audience now revokes it. **Still W for two reasons, both stated rather than implied:** the revocation is asynchronous with a daily ceiling, and `compass_feed_cache` is still never invalidated on a memory visibility change |
| H190 | W | **W** | Same correction, same verdict. A soft delete now revokes the graph derivative on the same cadence. The media bytes stay publicly served, §21's five-step deletion lifecycle still does not exist, and neither moves |
| H223 | W | **W** | **A BUILD THAT DID NOT MOVE A ROW, recorded as such.** Five of §24's eight operational-log fields were present while the doc comment above them quoted all eight. Seven land now — `failureClass` and `sourceVersion` were added at `artifacts/api-server/src/services/memory/MemoryDomainService.ts:199#failureClass`. `projectionName` is an explicit null and will stay one on this path: a command is not a projection, and the projection log that would carry the eighth field is `services/memoryProjections/derivativeRegistry.ts`, whose storage is 2730 — written, unapplied, never run outside a test. By this census's own rule (A.2: code built, storage unapplied ⇒ BBW) the row does not move, and it is not moved |
| H79 | W | **W** | **Evidence falsified and replaced; verdict unmoved.** The row points at a range of `routes/memories.ts` that is now the create and patch schemas, and says of it "*still the service client over canonical `memories`, still `.limit()` before block filtering*". Neither is true at this commit — the feed is `artifacts/api-server/src/routes/memories.ts:584#router.get`: every privacy predicate runs inside the query and `LIMIT` applies to the already-filtered set, with `hidden_user_ids` now among them. W stands on the half the row got right — §10 asks the public surface to read a DERIVATIVE, and the derivative is 2338, unapplied |
| H258 | W | **W** | **Evidence falsified and replaced; verdict unmoved.** The row reads "*Zero of the Compass read tools exist (H115–H122)*". Section C built all eight and moved six of them to C in this same document. W stands because §15's retrieval is still 2730 |
| H83 | C | **C** | **Evidence falsified and replaced; verdict unmoved.** The row proves "being tagged does not make another user a co-owner" by citing `userId !== user.id → 403` — a line that no longer exists. `artifacts/api-server/src/routes/memories.ts:2089#authorizeParticipantCommand` is now `authorizeParticipantCommand`, under which the **owner** may also remove a tag. The verdict survives for a different reason than the one written: a tagged user still gets no edit right and no audience right; what changed is that the owner gained one |

### D.5 Red-first: every mutation, and the one the harness refused

Every mutation was applied to **production** code, the named suites measured, the file restored
from a byte-for-byte backup and `cmp`-verified. None is a change to a test or to a constant an
assertion reads back.

**The harness inherits §C.4's rule and it fired.** A mutation whose anchor is not unique in the
file is REFUSED before it is applied. Mutation 13's first anchor —
`sourceVersion: existing.updated_at ?? null,` — occurs **twice** in `routes/memories.ts`, and
the harness refused it with that count rather than mutating the first occurrence and reporting
whatever red came out. It was refitted with a unique anchor and run. That is §C's mutation 17
caught before it happened rather than after.

| # | mutation (production file) | what went red |
|---|---|---|
| 1 | `isPublicWorldMemory`: restore the old gate — anything but `only_me` is public-world | the §28.10 gate test, and the §28.8 revocation test |
| 2 | the `memories` read: put the eligibility back in the loop only, not in the query | "the eligibility runs in the QUERY, not only in the loop" |
| 3 | `reconcileExperienceNodes`: an unreadable `memories` read means "nothing is eligible" | "an unreadable `memories` read deletes NOTHING and says so" |
| 4 | `rebuildIntelligenceGraph`: sweep AFTER the aggregates are folded | "runs the sweep BEFORE folding the aggregates" |
| 5 | `reconcileExperienceNodes`: delete the nodes but leave the edges | the §28.8 revocation test, on the orphan-edge assertion |
| 6 | the builder loop: drop the belt-and-braces eligibility check | "a client that IGNORES the query predicate still gets no private memory into the graph" |
| 7 | `asHistoricalMemoryPayload`: let an incoming `truthClass` win | "a payload that arrives already claiming to be current_world has the claim REMOVED" |
| 8 | `mapMemory`: stop marking the payload at all | 4 tests — single read, stranger read, the three list surfaces, and both writes |
| 9 | `MEMORY_TRUTH_ENVELOPE`: claim the Memory establishes current status | the same 4, plus the override test |
| 10 | `auditCommand`: drop the §24 failure class | "a REJECTED command logs the failure class beside the reason code" |
| 11 | `failureClassOf`: call every refusal the same class | 3 tests, including the one that reads the reason union out of `lib/memoryCommandBus.ts` |
| 12 | `auditCommand`: drop the §24 source version | "an ACCEPTED command logs all eight §24 field names" |
| 13 | the PATCH dispatch: stop passing the source version | "a PATCH logs the updated_at the row had BEFORE the write" |
| 14 | `loadMemoryForCommand`: stop selecting `updated_at` | **NOTHING — this mutation SURVIVES.** See below |

**Three mutations survived on their first run, and each survival was a real finding rather than
a nuisance.**

  - **6 survived** because the belt-and-braces eligibility check in the builder loop was
    exercised by nothing: every other test drives a fake that honours `.eq()`, so the primary
    defence always fired first. Defence in depth that nothing exercises is not defence in
    depth. A test was added that drives a client returning the whole table whatever it is
    asked for, and mutation 6 now goes red.
  - **7 survived** because the test for it was **VACUOUS**. It drove the route with a
    `truthClass: "current_world"` column on the fixture row and asserted the response said
    `historical` — and it passed with the override deliberately broken, because `mapMemory`
    builds its payload from an explicit field list and never copies an unknown column. The
    route could not reach the branch under test. The test was moved onto the function, where
    the property is real, and mutation 7 now goes red. **A green whose red cannot be produced
    is not evidence**, and this one was written in this pass, by this author, four hours
    before the mutation found it.
  - **10 survived** because every assertion was on the classifier and none on the line it is
    supposed to appear on: a field computed and then not logged is not a log field. Log-line
    tests were added and mutation 10 now goes red.

**14 still survives, and it is not fixable from inside this lane.** The fake clients in
`src/test/` ignore the `.select()` column list and return whole rows, so no test in this
repository can tell whether a query asked for a column. That is a property of the harness, not
of this change; it means the *narrowing* half of a select is unverifiable here, and it is
recorded rather than papered over.

### D.6 The ceiling

1. **Nothing here applies a migration or flips a flag, so 107 of the 134 rows could not move
   and did not.** The three rows this section touches were chosen because they were the ones
   that *could*.
2. **The graph revocation is asynchronous.** Up to 24 hours, bounded by the scheduler's
   interval, and nothing measures the actual latency because §24's `privacy_revocation_latency`
   does not exist. A synchronous revoke on the write path would close that and was not built:
   it would put a graph write inside a memory PATCH, which is the coupling §2 exists to prevent.
3. **The eligibility narrowing removes real data from the world model.** Cities whose depth
   came partly from private Memories will score lower. That is the correct direction — a
   confidence score standing on data its owners never published was not honest — but it is a
   behaviour change in a surface census-compass grades, and it is named here rather than left
   for that lane to discover.
4. **H5 marks; it does not enforce.** No mechanism stops a consumer from treating a Memory
   payload as current-world truth. What is mechanical is the marking, the removal of a contrary
   claim, and §14's existing refusal to build a current claim from a historical source.
5. **`compass_feed_cache` is still never invalidated on a Memory privacy change**, which is why
   H189 stays W.

### D.7 What this pass did NOT build, and why

- **Groups (c) and (e) — 116 of 134 rows.** Not touchable from a branch. Applying 2710, 2711,
  2720–2724, 2730, 2338 and seeding `memory_kernel_enabled` is the single largest available
  move on this document and it is an owner act.
- **H165/H166 (wiring the two pure projections into their routes).** Buildable with no
  migration — and each changes a live response shape. Doing it silently to move two rows would
  be scoring, not building. Named in (b) so the next lane can decide it deliberately.
- **A synchronous revoke on the memory write path.** See the ceiling, item 2.
- **Anything in group (d).** See D.1.
- **The seven remaining §21 revocation destinations (H192).** They do not exist as
  destinations; writing them is a subsystem, not a fix.

### D.8 Owner decisions this section surfaces

- **D-D1 (NEW) — how long may a revoked Memory stay in an aggregate?** The graph sweep runs
  daily. §28.8 says "never keep", and "never" and "within 24 hours" are different promises. If
  the answer is "not at all", the revoke belongs on the write path and §2's coupling rule needs
  a ruling. If the answer is "a day is fine", §24's `privacy_revocation_latency` should exist
  so the day is measured rather than assumed.
- **D-D2 (NEW) — was the old graph gate a disclosure?** `friends_only`, `trip_crew`,
  `circle_only` and `custom` Memories have been feeding the Destination World Model and the
  city-confidence index daily. The read APIs return aggregates, so no memory id, handle or
  coordinate left the graph — but the rows are in `compass_graph_nodes` and
  `compass_graph_edges` in production **now**, and this lane may not run a backfill to remove
  them. **The fix stops new ones; it does not clean the existing table.** The first scheduled
  rebuild after this lands will, because the sweep runs on every rebuild — but that is a
  consequence to state out loud, not to assume.
- **D6 (OPEN, inherited)** — `highlights` and its four children are in `UNCLASSIFIED_BACKLOG`
  in `lib/deletionDispositions.ts`. No highlight row is erased by account deletion. Unchanged.
- **D-C2 (OPEN, inherited)** — fourteen §16 C rows rest on a model choosing to call a tool,
  through a credential this repository does not record. Unchanged, and not leant on.

### D.9 Files changed outside this lane, named loudly

`artifacts/api-server/src/compass/CompassGraphEngine.ts` and
`artifacts/api-server/src/test/compass-intelligence-graph.test.ts` are graded by
**census-compass.md**, not by this document. They were changed anyway, because H263 and H237
are rows of THIS census and the defect is in that file.

**Two census-compass rows are affected and NEITHER WAS MOVED HERE.** Moving another lane's
verdict from inside this one is how a census stops being a measurement:

  - **CH-03** ("Never keep deleted Memories in Compass projections") is **W**, on the precise
    ground that there is "no deletion hook, no per-memory prune". There is one now. That row is
    very likely a W→C and **the Compass lane should re-read it**; this section states the
    change and leaves the verdict alone.
  - **CC-15** ("Graph reads only PUBLISHED, non-`only_me` memories") is **C**. Its verdict
    survives — the gate is now strictly narrower — but **its wording and its four citations are
    stale**: the rule is no longer "non-`only_me`", it is `public`, and `:690-705`, `:697-703`,
    `:698-700` and `:704` no longer point at the filter. They are **unanchored**, so
    `check:doc-citations` cannot see any of it. Repointing them would mean rewriting another
    lane's evidence for a claim this lane just changed, so they are named here instead.

Three more things a Compass reader should know:

1. **An existing test asserted the defect as intended behaviour.** It was named "emits
   experience nodes from PUBLISHED, non-only_me memories" and its fixture's "public" Memory was
   `visibility: "friends_only"`. The test was not wrong about the code; the code was wrong, and
   the test faithfully pinned it. Renamed, re-fixtured, and widened to all four private rungs.
2. **The fake client was looser than production and it hid a failure.** `compass_graph_nodes.id`
   is `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, but the fake minted an id only on `insert`,
   not on `upsert` — so every upserted row carried `id: undefined`, and any code that reads rows
   back by id and deletes them appeared to succeed while deleting nothing. The §28.8 sweep's
   first run reported three nodes deleted with three still in the store. The fake now mints an
   id the way the database does. **`cleanupNonCanonicalCityRows` reads rows back by id in the
   same way**, and its tests pass only because they seed ids by hand; that is a Compass-lane
   read, not this one's.
3. **`GraphRebuildReport` gained one optional field**, `experienceRevocations`. Optional, so no
   existing caller breaks; present on every `rebuildIntelligenceGraph`, including when it
   removed nothing, because "swept, found nothing" and "never swept" are different states and
   the scheduler log is the only place anyone would notice.

`artifacts/api-server/src/compass/CompassTools.ts` was **not** touched.
`COMPASS_TOOL_COUNT_IN_HEADER` is unchanged at 41 and no tool was added or removed.

**Two citations in `census-telegraph.md` were REPOINTED, and nothing else in that document was
read or changed.** Both named line 1712 of `routes/memories.ts` with the anchor `state`; this pass's edits to that
file moved it to `artifacts/api-server/src/routes/memories.ts:2762#state`, and
`check:doc-citations` named both. (The stale number is written out in words here rather than in
citation form: reproducing a broken `path:line#anchor` inside a note about it is itself a broken
citation, which this section learned by doing it.) The claim they carry — "applies
`state = published` only when the viewer is not the owner" — was re-read at the new line before
the number was changed, and it holds: the filter is inside `if (!isOwnProfile)`. A pointer, not
a judgement, and the same repair the layover lane's §12 documents. **Seventeen citations in THIS
document were repointed for the same reason** — the anchor form is what made all nineteen
findable; the 6,489 unanchored citations into the same two files moved silently and are still
wherever they were.

### D.10 The recomputed headline

| figure | section C (`f8384ea5b`) | **now** |
|---|---:|---:|
| Denominator | 266 | **266** |
| BUILT-AND-CORRECT | 52 | **54** |
| BUILT-BUT-WRONG | 134 | **132** |
| NOT-BUILT | 78 | **78** |
| CANNOT-VERIFY | 2 | **2** |
| CONSTRUCTED% | 69.9 % | **69.9 %** |
| CORRECT%, raw | 19.5 % | **20.3 %** |
| **the gap** | **50.4 points** | **49.6 points** |

**Two rows. Eight tenths of a point.** Set against a 50-point gap that is the honest size of
this pass, and the arithmetic above says why: 107 of the 134 rows were never reachable from a
branch, and the nine that were are nine. What this section is actually worth is not in that
table — it is a live daily path that carried four private audiences into public-world
intelligence and never took any of them back out, found by counting rows instead of reading
the same files a fourth time.

---

## D.11 The integration re-read — four counted files moved under this document

**This section changes no verdict and moves no row.** It restates one bullet of D.3 that the
merge made half-false, records a report field D.3 did not have, and names a behaviour that no
test in this repository pins. `check:census-freshness` named exactly which four files to look
at; this is what was found in them.

**What happened mechanically.** Section D was measured at `d3b19fa9d`. It was merged into
`claude/sweet-fermat-fmx7up` at `75cc31d9e`, together with the Compass, Discovery, Passport,
Trust and Wall lane. `head_commit` stays `d3b19fa9d` — the merge commit keeps it an ancestor of
HEAD, which is the checker's stated rule — and it is still PRE-SQUASH, so B.1's owner follow-up
is unchanged and still owed.

### The merge had to choose between two fixes of the same defect

Both lanes closed §28.8 / §21 independently and neither knew the other was doing it. This lane
wrote `reconcileExperienceNodes`; the Compass lane wrote `pruneOrphanedExperienceNodes`. **The
merge kept this lane's function and deleted the other**, and the reason matters to two rows of
this document rather than being a merge-hygiene detail: the deleted sweep screened on
`state = 'published' AND visibility <> 'only_me'` — which is D.2's **Defect 1**, the six-rung
gate, wearing the fix's name. A sweep on that predicate keeps every named audience
(`friends_only`, `trip_crew`, `circle_only`, `custom`) in the graph permanently: the builder no
longer writes those rows, but a row already in `compass_graph_nodes` is never asked about again
by a sweep that considers it eligible. Had it survived, **H263 would be a false green for the
second time and H237's C would not be earned.**

The surviving sweep decides through `isPublicWorldMemory`
(`artifacts/api-server/src/compass/CompassGraphEngine.ts:548#isPublicWorldMemory`), the same
predicate `buildGraphFromSources` gates its write on, which is the property D.3 item 1 claims
and is unchanged at this commit. A Compass-lane test pins the distinction:
`artifacts/api-server/src/test/compassCensusCorrectness.test.ts:214#B2` seeds one experience
node per rung — `only_me`, `draft`, `archived`, the named audiences and `public` — and asserts
that **only the `public`, `published` Memory keeps its node**. Under the discarded predicate
every named audience is eligible and survives, so the case goes red on the count. The counts
themselves are deliberately not reproduced here: that fixture is being widened by the Compass
lane in the same tree as this is written, and a number copied out of a file that is moving is
the decay this document already carries seventeen repointed citations for.

### The four files

| file | what changed between `d3b19fa9d` and `75cc31d9e` | does it move a verdict here? |
|---|---|---|
| `artifacts/api-server/src/compass/CompassGraphEngine.ts` | +71/−20, all inside the §28.8 sweep: the surviving `reconcileExperienceNodes` absorbed two things from the deleted implementation — a new report field and a per-batch failure path | **No — but it falsifies half a sentence.** See below |
| `artifacts/api-server/src/routes/compass.ts` | +72/−21: a Sensing `:148` grounding envelope applied on both `/compass/ask` branches, and `GET /compass/recommendations` moved onto the Passport batch identity projection | No. All three lines this census cites are byte-identical; only their numbers moved, and the merge repointed them |
| `artifacts/api-server/src/services/media/MediaProjectionService.ts` | +188/−5: a `places.neighborhood` label producer, and the §30 Tagged bucket made real over `public.tags` | No. The one line this census cites is the "Hidden Gems" strip literal, and it is unchanged |
| `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts` | +154/−0, appended: `buildListIdentityProjections`, a viewer-aware batch identity projection for list surfaces | No. It projects list IDENTITY; the row it is cited by turns on this module not projecting MEMORIES |

### The half-sentence the merge falsified

D.3's second bullet under **2. §28.8 revocation** reads, and stays on the record as written:

> **Fails closed.** An unreadable `memories` read sets `unresolved` and deletes **nothing**.
> Deleting on a transient outage erases a graph; keeping a stale node one more day is
> recoverable, and the next tick retries. The report distinguishes the two rather than
> reporting zero twice.

**Restated at `75cc31d9e`: it fails closed PER BATCH, and the pass no longer abandons itself.**
The sweep asks `memories` about the node keys it holds in chunks of 200
(`artifacts/api-server/src/compass/CompassGraphEngine.ts:1274#DELETE_CHUNK`). Before the merge,
the first chunk whose read errored or threw set `unresolved` and **returned** — every later
chunk's revocations waited a day. Now a failed chunk sets `unresolved`, counts its keys into a
new field, and the loop **carries on**
(`artifacts/api-server/src/compass/CompassGraphEngine.ts:1535#undecided`).

Three corrections, each mechanical:

1. **"deletes nothing" is now a statement about the FAILED BATCH, not about the pass.** Nothing
   in a batch that failed can be deleted, because the dooming decision is a pure helper,
   `artifacts/api-server/src/compass/CompassGraphEngine.ts:1427#deadExperienceKeys`, which
   returns `[]` on `ok === false` and is called with the batch's own `ok`
   (`artifacts/api-server/src/compass/CompassGraphEngine.ts:1534#deadExperienceKeys`). A failed
   batch therefore contributes no dead keys and cannot widen a revocation. The batches that
   answered are acted on.
2. **"reporting zero twice" is now three states, not two.** `ExperienceReconcileReport` gained
   `artifacts/api-server/src/compass/CompassGraphEngine.ts:1410#undecided` — the node keys the
   pass refused to judge. A clean sweep reports `undecided: 0, unresolved: false`; a partial one
   reports a non-zero `undecided`; a sweep that could not read the node table at all reports
   `examined: 0, unresolved: true`. D.3's sentence covered the first and the third and had no
   word for the second, because before the merge the second did not exist.
3. **The whole-pass fail-closed claim survives in one place, and only there.** An unreadable
   `compass_graph_nodes` read still returns immediately and decides nothing
   (`artifacts/api-server/src/compass/CompassGraphEngine.ts:1491#report.unresolved`). That is
   the read D.3's third design choice depends on, and it is untouched.

**The evidence-table line in D.3 is restated the same way.** It reads "an unreadable `memories`
read deletes nothing and says so", citing
`artifacts/api-server/src/test/compass-intelligence-graph.test.ts:777#unreadable`. That test
blinds **every** `memories` read, so what it pins is the all-batches-fail case — where the
statement is still exactly true — and it still passes unchanged. So does
`artifacts/api-server/src/test/compassCensusCorrectness.test.ts:251#B3`, which asserts the same
shape plus `undecided: 2`.

**What no test pins, stated rather than left to be discovered.** The MIXED case — one batch
fails, another succeeds, the successful one's revocations are applied anyway — is asserted by
construction and by nothing else. `DELETE_CHUNK` is 200 and no fixture in this repository seeds
more than 200 experience nodes, so every existing test exercises a single batch, and
`deadExperienceKeys` is not exported and is named by no test. The carry-on path is the half of
this change that is new behaviour, and it is the half with no red-first evidence behind it. It
is recorded here as a ceiling rather than counted as a build.

### Every row that cites one of the four files, re-derived

| row | verdict at `d3b19fa9d` | at `75cc31d9e` | the mechanical reason it does not move |
|---|---|---|---|
| H237 | C | **C** | The sweep still revokes the experience node and every edge touching it, and still runs before the aggregates are folded (`artifacts/api-server/src/compass/CompassGraphEngine.ts:1574#experienceRevocations`, re-read at the new line). The per-batch change moves the ceiling in the SAFE direction: a transient read failure no longer defers every other batch's revocation for a day. The stated ceiling — daily cadence, no `privacy_revocation_latency` — is unchanged |
| H263 | C | **C** | The §28.10 gate is byte-identical: `:548`, `:768` and `:775` are untouched by the merge. What the merge decided is which sweep AGREES with that gate, and it kept the one that does |
| H189 | W | **W** | Unchanged. `compass_feed_cache` is still never invalidated on a Memory visibility change, which is the half the W rests on |
| H190 | W | **W** | Unchanged. The media bytes stay publicly served and §21's five-step deletion lifecycle still does not exist |
| H129 | BAC | **BAC** | The grounding envelope added to `/compass/ask` reads the answer back against the turn's tool evidence and appends a correction; it writes nothing. `grep -cE '\.from\("memories"' src/routes/compass.ts` returns **0** at this commit, and the cited `forgetMemory` call still writes `compass_memories` |
| H104–H106 | BBW | **BBW** | Their current evidence is `services/memoryProjections/memoryGraph.ts`, not this file — the `MediaProjectionService.ts` citation sits in section A's superseded §13 paragraph. The Tagged bucket reads `public.tags` (people tags), not `memory_relations`, which still has no migration anywhere in the tree |
| H164 | BBW | **BBW** | `buildListIdentityProjections` projects display name, avatar and badge for list rows. `grep -cE '\.from\("memor'` and `grep -cE '\.from\("highlight'` over `src/services/passport/PassportConsumerProjections.ts` each return **0** at this commit: the module still projects Passport artefacts, not Memories, which is what the row says |

**H123–H128 were re-read and are not moved, and the reason is narrower than "not relevant".**
Section C moved them to W, W, C, W, C, C on evidence in `memoryCompassTools` — prompt rules,
`canCompassReadMemory`, the truth class — none of which is in a changed file. The new envelope
is a mechanism, and a mechanism is exactly what C.5 item 5 says H126 would need; but it polices
three claim kinds and they are named in the type itself
(`artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:60#live_claim_without_verified_source`):
a live-status claim with no `verified_live` datum, a wait figure with no wait datum, a crowd
assertion with no crowd datum. H126's weakest third is emotional states, preference and
historical outcomes on a MEMORY. The envelope does not read those, so it does not close them,
and H126 stays W.

**What this section would have looked like if it had gone the other way.** If the merge had
kept `pruneOrphanedExperienceNodes` instead, this would be a re-measurement: H263 would go back
to a false green and H237's C would have to be withdrawn, because a sweep that agrees with the
OLD gate leaves four private audiences in `compass_graph_nodes` for good. The B2 case above is
what decides it, and it is named rather than paraphrased so the next reader can run it instead
of trusting this paragraph.

**The headline in D.10 is unchanged: 266 rows, 54 C, 132 W, 78 N, 2 X.** Nothing in this
section constructed anything.

---

## E. The BRANCH queue, worked — §10's person ladder, §23's `canSeeParticipant`, and the sweep case D.11 said nothing pinned — 2026-09-13

D.1 grouped the W column by the one question that decides whether a branch can do anything
about a row: **would a production deploy and a flag flip, with no code change, make this row
true?** The rows where the answer is *no, it needs code and only code* are groups **(a)** and
**(b)**. That is the BRANCH queue, and this section is what happened when it was worked
instead of counted.

### E.1 The queue, re-derived rather than taken on trust — and the one row D.1 filed in the wrong group

D.1's tables were re-parsed against the verdict tables rather than read as prose. The result:

- The five group tables name **134 ids, with no overlap and no gap**, and 134 is exactly the W
  count at the commit D.1 was measured at.
- Against the document **as it stands now**, 132 of those 134 are still W. The two that are not
  are **H5** and **H237**, which D.1's own entries mark "CLOSED HERE". **The grouping is stale
  by exactly those two rows and by nothing else** — every current W row appears in it, and no
  id in it is anything but W, H5 and H237 excepted. It was not re-derived, because re-deriving a
  grouping that reproduces is how a document spends a pass restating itself.
- So the queue this section inherited is **(a) ∪ (b) minus H5 and H237 = 13 rows**:
  H6, H10, H77, H84, H189, H190, H193, H202 from (a); H104, H105, H165, H166, H198 from (b).

**One row is in the wrong group, and it is a row that could be closed.** D.1 files **H209**
(§23 `canSeeParticipant(userId, memoryId, participantId)`) under **(c)**, "capped by 2721
`highlight_projection_policies`, UNAPPLIED", alongside H75, H81, H82, H200, H201 and H210. For
those six that is right: each needs a value an owner has STORED, and 2721 is the column that
would store it. H209 does not. It is an **authorization predicate**, and every other §23
predicate in this census — `canReadMemory`, `canEditMemory`, `canPublishMemory`,
`canSeeExactLocation` — is answered from the subject row plus membership, with no policy table
anywhere. H209 is answerable the same way, from `memory_tags.status`, `memories.visibility`,
`memories.trip_id` + `trip_members`, `blocks` and `profile_privacy_settings` — five objects all
on the deployed schema. **H209 belongs in (a). Filing it in (c) hid a closeable row inside the
107 nobody can touch**, and the mis-file is worth more than the row: the grouping's value is
that it tells a branch where to look, and one wrong placement is one place a branch does not.

The queue this section actually worked is therefore **14 rows**. Two were closed. Twelve were
opened, read, and are named in E.5 with the thing that stops each.

### E.2 What was built

**1. §10's person visibility ladder, on the Memory participant surface — and the leak it closed.**

The defect was not a missing abstraction. It was a missing filter.
`GET /memories/:id` and `GET /memories/:id/tags` returned **every** `memory_tags` row —
`tagged_user_id` included — to **every** viewer permitted to read the Memory, with no predicate
on `status` at all. Two consequences, and each is a disclosure about somebody who did not agree
to it:

- a person tagged and **not yet consenting** (`status = 'pending'`, which is what
  `POST /memories` writes) was profile-linked by user id to every viewer of that Memory; and
- a person who had **removed their own tag** — `PATCH /memories/:id/tags/:userId` writes
  `status = 'removed'`, and it is the only exit the product offers — was **still shipped by id**,
  because nothing read the column it had just written.

§5 admits a participant "only after participant consent". §10 says blocking must "unlink profile
identity". Neither held on a surface that answered with the raw table.

`artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts:163#participantRungFor`
is the decision: a single fixed branch order, hardest rule first, that turns those five deployed
objects into one of §10's five rungs. The order is the policy and is written as one sequence so
that two readings of the same facts cannot disagree — block, then self, then absence, then an
unparseable status, then the owner, then withdrawal, then pending, then a crew-scoped audience,
then the name opt-in. Three properties are load-bearing and each is separately
mutation-covered:

  - **A withdrawn participant is HIDDEN, not ANONYMOUS_COUNT.** This is the branch most open to
    argument, so it is argued in the file: "somebody was here, we will not say who" is still a
    disclosure about a person on a Memory they have left, and an exit has to lead outside.
  - **ANONYMOUS_COUNT drops the id, not only the name.** A rung whose purpose is "you do not
    learn who" leaks the identity the moment the id ships beside the count. The renderer that
    enforces that is §C's existing `discloseParticipant`, imported rather than re-transcribed:
    two copies of a five-rung privacy ladder drift, and the drift is silent.
  - **HIDDEN is not counted; ANONYMOUS_COUNT is.** Folding the hidden into the count would leak
    a withdrawal or a block as an arithmetic difference between two viewers' answers.

`artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts:356#canSeeParticipant`
is §23's predicate with §23's own signature. It returns the RUNG, not a boolean, because §10's
answer to "may this viewer see this participant" is one of five and three of the five are
partial; a caller wanting the boolean asks `rung !== "HIDDEN"` in one place. It reads the Memory
itself rather than trusting a caller to have loaded it, and **every read it makes fails closed**
— an errored `memories`, `memory_tags` or `blocks` read discloses nobody, and an unreadable
`trip_members` makes a crew-scoped roster disclose nobody.

Both routes go through
`artifacts/api-server/src/routes/memories.ts:1351#loadParticipantVisibility` and
`artifacts/api-server/src/routes/memories.ts:1372#participants.participants`, and
`artifacts/api-server/src/routes/memories.ts:2046#participants.participants`.

**THE RUNG IS DERIVED, NOT STORED, AND THAT IS THE WHOLE REASON THIS ROW WAS REACHABLE.** The
Highlights surface reads its rung out of `highlight_projection_policies`, which is migration
2721 and is not applied — which is why every §10 row that needs a stored rung sits in group (c)
and stayed there. This surface reads no 2721 column and adds none. The price is stated rather
than hidden, and it is the row's ceiling: a participant cannot choose their own rung here,
because there is no column to choose it in. What they can do is withhold or withdraw consent,
and that is now honoured.

**2. The §28.8 sweep case D.11 said no test pinned.**

D.11 recorded, as a ceiling rather than a build, that the merged sweep's carry-on path — one
batch fails, another succeeds, **the successful one's revocations are applied anyway** — was
"asserted by construction and by nothing else", because `DELETE_CHUNK` is 200
(`artifacts/api-server/src/compass/CompassGraphEngine.ts:1274#DELETE_CHUNK`) and no fixture in
this repository seeded more than 200 experience nodes.

**That was checked before it was believed, and it is exactly true.** Restoring the pre-merge
behaviour — `return` on the first failed batch, with `undecided` still assigned so the
single-batch reports are byte-identical — left **all 72 tests** of
`compass-intelligence-graph.test.ts` and `compassCensusCorrectness.test.ts` **green**. A naive
restoration does go red, but on `compassCensusCorrectness.test.ts`'s `undecided: 2` assertion,
which the early return skips past — it catches the missing field assignment, not the carry-on.

`artifacts/api-server/src/test/compass-intelligence-graph.test.ts:795#BATCH` seeds 250
experience nodes, fails the first batch's `memories` read and answers the second, and asserts
**both** halves, because a sweep that carries on wrongly is worse than one that stops: the batch
that answered has its 17 revocations applied, and the 200 keys of the batch that did not are
left exactly as they were and counted into `undecided`. It is the first fixture in the tree that
crosses `DELETE_CHUNK`.

**Where the assertions live.** All in files `package.json`'s `test` script runs, so
`check:test-registration` covers them; `src/test/memoryParticipantLadder.test.ts` was appended
to that script at the end.

| what it asserts | file |
|---|---|
| every rung §10 declares is reached by some fact set on this surface | `artifacts/api-server/src/test/memoryParticipantLadder.test.ts:147#declares` |
| §23's predicate, from the deployed tables, failing closed one table at a time | `artifacts/api-server/src/test/memoryParticipantLadder.test.ts:281#canSeeParticipant` |
| the error BINDING refuses, not the null it happens to arrive with | `artifacts/api-server/src/test/memoryParticipantLadder.test.ts:334#BINDING` |
| a pending participant's id does not reach a third party, and a count does | `artifacts/api-server/src/test/memories.test.ts:1011#consented` |
| the tags route applies the same ladder, not a second copy of the old rule | `artifacts/api-server/src/test/memories.test.ts:1079#ladder` |
| one batch fails, another succeeds, and the successful one still revokes | `artifacts/api-server/src/test/compass-intelligence-graph.test.ts:795#BATCH` |

### E.3 Row moves

| id | was | now | why |
|---|---|---|---|
| H77 | W | **C** | "Person visibility ladder (NAMED → PROFILE_LINKED → CREW_ONLY → ANONYMOUS_COUNT → HIDDEN)." The row's evidence was "`lib/publicIdentity.ts` implements 2 of the 5 rungs … No CREW_ONLY, ANONYMOUS_COUNT or HIDDEN". All five are now reached on a live Memory surface, per viewer and per participant, by `artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts:163#participantRungFor`, and a test asserts that no rung §10 declares is unreachable rather than asserting a list. **CEILING, stated in the row rather than implied: the rung is DERIVED — from consent, audience, crew, blocks and the name opt-in — and is not owner- or participant-SELECTED, because no Memory carries a person-visibility column; that column is 2721 and stays unapplied.** Two narrower limits: the ladder governs the PARTICIPANT list, not the Memory OWNER's own identity, which is still the two-rung universal display-name rule; and `POST /memories/:id/share` and the feed surfaces return no participant list to apply it to |
| H209 | W | **C** | §23 `canSeeParticipant(userId, memoryId, participantId)`. The row read "Tag rows are returned to any permitted viewer", and at section B "not wired to `memory_tags`; no per-memory policy row". `artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts:356#canSeeParticipant` is the predicate at the spec's own signature, loading its own subject and failing closed on `memories`, `memory_tags`, `blocks` and `trip_members` independently. Both routes that return participants decide through the same function. **THE SECOND HALF OF THE OLD EVIDENCE IS ANSWERED, NOT SATISFIED: there is still no per-memory policy row, and there does not need to be** — §23's other four predicates have none either. That is the re-grouping argument of E.1, and the row moves on it |
| H237 | C | **C** | **NO MOVE. A CEILING CLOSED, NOT A VERDICT CHANGED.** D.11 named the mixed-batch carry-on as "the half of this change that is new behaviour, and the half with no red-first evidence behind it". It has evidence now (`artifacts/api-server/src/test/compass-intelligence-graph.test.ts:795#BATCH`), and D.11's statement that no test pinned it was verified by restoring the pre-merge behaviour and watching 72 tests stay green. The row's OTHER stated ceiling — daily cadence, no `privacy_revocation_latency` — is untouched |
| H10 | W | **W** | **Evidence corrected, verdict unmoved, and the group placement contested.** The row says "no audience/precision/resurfacing/personalization/publication policy service". Two of those five now exist as a service on this surface — audience, through the participant ladder, and the §23 predicate that answers it. The other three do not and cannot here: resurfacing and personalization are `highlight_resurfacing_preferences` (2720, unapplied) and publication policy is 2721. **D.1 files H10 in (a), "fixable in code". Three-fifths of it is not** — it is (c) wearing (a)'s label, and the next lane should not spend a pass on it expecting a close |
| H83 | C | **C** | **Evidence extended, verdict unmoved.** D.4 already corrected this row once. What is added: "being tagged does not make another user a co-owner" now has a second, stronger reading on the same surface — being tagged no longer grants the tagged person's identity to third parties either, until they say so. The row's claim was about rights accruing TO the tagged user; the new code is about rights accruing to everyone else ABOUT them, and it holds in the same direction |
| H198 | W | **W** | **Evidence corrected, verdict unmoved.** The row's ceiling is "every read still runs on the service client — the default is TypeScript, not RLS", and that is unchanged: the two routes above still read `memory_tags` through `getServiceClient()`. What changed is that the TypeScript default is now one function with a fixed branch order instead of an unfiltered `SELECT`. A narrower bypass is still a bypass and the row does not move |

### E.4 Red-first: every mutation, and the two that survived

Every mutation was applied to **production** code, the named suites measured, the file restored
from a byte-for-byte backup and `cmp`-verified. None is a change to a test or to a constant an
assertion reads back. The harness inherits §C.4's rule: **an anchor that is not unique in its
file is REFUSED before it is applied**, and it printed the count rather than mutating the first
occurrence.

| # | mutation (production file) | what went red |
|---|---|---|
| A1 | the §28.8 sweep: `return` on the first failed batch (the pre-merge behaviour), `undecided` preserved | **NOTHING — 72 tests green.** This is the measurement D.11's ceiling predicted; see below |
| A2 | the same, after the new fixture was added | "a transient failure on one batch must not hold another batch's privacy revocation for a day" — 0 !== 17 |
| A3 | `deadExperienceKeys`: a FAILED batch dooms every key it asked about | the same test at 217 !== 17, and the existing all-batches-fail test |
| B1 | `participantRungFor`: a pending participant is profile-linked again | 7 tests — the ANONYMOUS_COUNT rung, the rung-coverage property, and both routes |
| B2 | `participantRungFor`: a withdrawn participant is counted instead of hidden | 4 — including the route assertion that a removed tag leaves no trace |
| B3 | `participantRungFor`: a block no longer outranks the rest of the ladder | 4 — the branch-order test and the blocked-roster route test |
| B4 | `discloseMemoryParticipant`: CREW_ONLY discloses to a viewer who is not crew | 2 |
| B5 | `loadParticipantVisibility`: an unreadable `trip_members` reads as membership | 1 |
| B6 | `consentFromTagStatus`: an unparseable status reads as consent | 2 |
| B7 | `projectParticipants`: HIDDEN participants are folded into the anonymous count | 4 |
| B8 | `canSeeParticipant`: the `memories` error binding removed | **NOTHING on the first run.** See below |
| B9 | the single-read route: stop applying the ladder | 3 |
| B10 | the tags route: stop applying the ladder | 3 |

**A1 survived, and its survival is the finding rather than a gap.** D.11 wrote that the mixed
case "is asserted by construction and by nothing else". A1 is that sentence executed: the
carry-on removed, every single-batch report identical, **72 of 72 green**. A2 is the same
mutation after the 250-node fixture exists. The pair is the whole argument — the first says the
behaviour was unpinned, the second says it is pinned now.

**B8 survived because the guard was unreachable through the door the test used, exactly as §D.5's
mutation 6 was.** `maybeSingle()` returns `data: null` beside an error, so
`if (!memory) return "HIDDEN"` on the next line covered the error branch, and deleting
`if (error) return "HIDDEN"` changed no outcome any test could see. A guard whose red cannot be
produced is a comment. The fix is not to delete the guard but to drive the one shape that
separates it from its neighbour — a client answering with a live, public, approved row **and**
an error — and `artifacts/api-server/src/test/memoryParticipantLadder.test.ts:334#BINDING` does
that for both the `memories` and the `memory_tags` read. B8 and the same mutation on the
`memory_tags` read now each go red.

**Two production files were also mutated and are recorded as unchanged:**
`artifacts/api-server/src/compass/CompassGraphEngine.ts` and
`artifacts/api-server/src/routes/memories.ts` were both restored and `cmp`-verified after every
mutation above; `git status` reports the engine byte-identical to `HEAD`.

### E.5 The twelve queue rows opened and NOT closed, with what stops each

These were read at this commit, not inherited from D.1's one-line notes. **Four of the twelve
are not BRANCH rows at all**, and saying so is the point of opening them.

| id | what actually stops it | is it really BRANCH? |
|---|---|---|
| H6 | §2 MemoryDomainService wants versioning and merge/split. `memories.current_version` (§3.1) is created by **no migration in the tree** — its only appearance in any `.sql` is 2711's comment saying so. `memory_relations` is the same: every match in every `.sql` in the tree is that one comment. | **No — (c) and (e).** Filed (a) |
| H10 | Three of its five faculties are 2720 and 2721. See E.3. | **No — three-fifths (c).** Filed (a) |
| H84 | `highlights` and its four children sit in `UNCLASSIFIED_BACKLOG`. Moving them is a line of TypeScript and a ruling about whether account deletion erases Highlights. **Owner decision D6, open since section A.** | Code-shaped, decision-blocked |
| H189 | Two blockers. `compass_feed_cache` is still never invalidated on a Memory visibility change — that half **is** branch work and was not done here. The other half is the graph revocation's daily cadence, which D.6 item 2 rules out fixing on the write path (§2 coupling) and D-D1 leaves open. **Closing the cache half alone does not move the row**, which is why it was not done as a row-scoring exercise | Half BRANCH, half owner |
| H190 | The media bytes stay publicly served, and §21's five-step deletion lifecycle does not exist. Memory media never enters the staged `post_media` pipeline (H181/H183, group (e)) | Half (e) |
| H193 | Per-Memory deletion has no named step, report or retry. The Highlights side has all three (`services/highlights/highlightRevocation.ts`) and a Memory analogue is real branch work — but "dead-lettered on repeated downstream failure" needs somewhere to put a dead letter, and there is no such store | BRANCH, with an (e) tail |
| H202 | Per-surface scoped service roles are `GRANT`s, which is a migration, and the audit trail is a table | **No — (c)/(e).** Filed (a) |
| H104, H105 | Pure over `memories`, reachable from nothing. Wiring them needs a surface to wire them TO, and no route in the spec or the app asks for a compression hierarchy. Inventing an endpoint to move two rows is scoring | BRANCH, product-blocked |
| H165, H166 | Exactly as D.7 left them: buildable with no migration, and each changes a live response shape. **This lane is the "next lane" D.7 addressed and it declines too, for a reason D.7 did not state: nothing in this repository can tell you which clients read those shapes.** Naming it twice is better than doing it twice | BRANCH, risk-blocked |
| H198 | Owner-only-by-default means the database refusing, not TypeScript refusing. Every memory and highlight read and write goes through `getServiceClient()`; replacing it means a user-scoped client on every one of them and a re-verification of every fail-closed branch that currently assumes the bypass | BRANCH, and large |

### E.6 The ceiling

1. **Two rows. This section does not pretend that is a dent in 132.** The arithmetic D.1
   established is unchanged: 107 of the W rows are capped by storage nobody has applied, and
   that remains the single largest available move on this document and an owner act.
2. **The participant ladder is a READ-side rule.** It decides what a response may contain. It
   does not stop a Memory being created with a tag on somebody, and it does not notify them.
3. **The derived rung cannot express a participant's own preference.** A person who is content
   to be named on one Memory and not another has no way to say so; the only control they have is
   the binary of the tag itself. That control is a column, the column is 2721, and 2721 is
   unapplied.
4. **`loadParticipantVisibility` calls `isBlocked` once per participant.** Bounded by the tag
   count of one Memory, which is small, and correct; but it is N round trips where the feed uses
   a set-shaped read, and a Memory with a large roster would feel it.
5. **The mixed-batch fixture is 250 nodes against a `DELETE_CHUNK` of 200.** It proves two
   batches. It does not prove the third, and a sweep whose second and third batches both fail is
   still covered only by construction.

### E.7 Owner decisions — and precisely which rows hang on D-C2

**D-C2 (OPEN, inherited) — is `AI_INTEGRATIONS_OPENAI_API_KEY` set in production?** C.8 says "if
it is not set, fourteen rows in C.3 are vacuous". This lane may not take that decision. It can
say exactly which rows it is, which C.8 did not:

- C.3 moved **fourteen** rows to C: H115, H116, H117, H118, H119, H121, H122, H125, H127, H128,
  H109, H70, H74 and H207.
- **Thirteen of those fourteen are reachable only through a Compass tool call** — every one of
  H115–H119, H121, H122, H125, H127, H128 is a tool in `MemoryCompassTools.ts`; H109 and H70 are
  proved through `memory_get_place_history`; H74 through `memory_create_draft`. If the
  credential is absent, none of the thirteen has ever executed in production and all thirteen
  are vacuous.
- **H207 is not among them and must not be marked with them.** §23's `canPublishMemory` is wired
  to `POST /memories` and `PATCH /memories/:id` and is reached by an ordinary HTTP request with
  no model in the path. It stands whatever the answer is.
- The three group-(d) rows — **H120, H123, H126** — are a different set and are already W; they
  are not affected by D-C2's outcome because they are not counted as correct in the first place.

**So the exposure is thirteen C rows, not fourteen**, and if the answer is "not set" the raw
CORRECT% falls from **21.1 % to 16.2 %** — 43 of 266, against the 56 this section closes at. That number is stated so the decision can be
taken with its size visible; it is **not** applied, and no row is moved on it here.

- **D-D1 (OPEN, inherited)** — how long may a revoked Memory stay in an aggregate? Unchanged.
  E.2's fixture narrows the question slightly: the carry-on path means a transient read failure
  no longer adds a second day to the wait, so the answer needed is about the scheduler's day,
  not about a compounding one.
- **D-D2 (OPEN, inherited)** — was the old graph gate a disclosure? Unchanged; no backfill was
  run and none may be from here.
- **D6 (OPEN, inherited)** — `highlights` in `UNCLASSIFIED_BACKLOG`. Unchanged, and it is what
  holds H84.
- **D-E1 (NEW) — should a participant's `pending` tag be visible to the Memory's other
  participants?** This pass answers "no": before consent, a third party gets a count. A trip crew
  looking at a crew Memory of their own trip is a third party under that rule, and an owner may
  reasonably think the crew should see who was invited. The code takes the private reading
  because it is the reversible one; the other reading is a product decision and is not taken
  here.

### E.8 Files changed outside this lane, named loudly

`artifacts/api-server/src/compass/CompassGraphEngine.ts` was **mutated and restored, not
changed.** The only edit to a Compass-graded file is the new case in
`artifacts/api-server/src/test/compass-intelligence-graph.test.ts`, which adds a fixture and
asserts existing behaviour. **No census-compass verdict was read, re-derived or changed**, and
CH-03 — which D.9 said the Compass lane should re-read — is still that lane's to move.

`artifacts/api-server/src/routes/memories.ts` is counted by **census-telegraph**. It gained an
import block and two ladder call sites and lost nothing; both of that document's citations into
it were displaced and are repointed below.

**Every file this section changed, named once so the next integration re-read has the list:**
`src/services/memory/memoryParticipantVisibility.ts` (new),
`src/test/memoryParticipantLadder.test.ts` (new),
`src/routes/memories.ts`, `src/test/memories.test.ts`,
`src/test/compass-intelligence-graph.test.ts`, `package.json` (the `test` script, appended at
the end) and `src/scripts/checkCensusFreshness.ts` (CENSUS_SCOPE only — two paths added, no
ratchet and no floor touched). **`check:census-freshness` already reported this document STALE
before this section began** — D.11 exists because of that report — and it still does; nothing
here re-measures `head_commit`, and the four files D.11 acknowledged are joined by the four
above.

**Citations repointed — pointers, not judgements.** The insertion displaced every anchored
citation below it. Each was moved by locating **the exact text of the original line** in the new
file and taking that line's new number; where the text was not unique, the citation was left
alone rather than guessed at, and one —
`artifacts/api-server/src/routes/memories.ts:1499#dispatchMemoryCommand` — was resolved by exact
text plus its ordinal, because the line occurs twice in both files and the first is still the
first.

| document | citations repointed |
|---|---|
| this document | 53 into `routes/memories.ts`, 1 into `compass-intelligence-graph.test.ts` |
| `census-telegraph.md` | 2, both the `#state` anchor D.9 already repaired once |
| `mobile-reachability-ledger.md` | 3 |
| `docs/handoff/2026-08-30-audit-findings.md`, `docs/UNIVERSAL-SHARE-AUDIT.md` | 1 each |

**23 citations in this document were deliberately NOT repointed**, all of them unanchored
`path:line-line` spans whose original line text is not unique in the file — a blank line, a bare
`});`, a repeated `const sc = getServiceClient();`. Guessing them by offset is exactly the decay
the anchor form exists to prevent, and they are left where they are with this sentence as the
record.

`check:doc-citations` reports **58 broken anchors** at this commit against **109** before the
repair. **None of the 58 points into any file this section touched** — they are in
`CompassTools.ts`, `MediaProjectionService.ts` and six route files being edited by other lanes in
this same tree as this is written, and they were broken before this section began.

### E.9 The recomputed headline

Restated from `pnpm -s check:census-integrity`, not counted by hand.

| figure | section D (`d3b19fa9d`) | **now** |
|---|---:|---:|
| Denominator | 266 | **266** |
| BUILT-AND-CORRECT | 54 | **56** |
| BUILT-BUT-WRONG | 132 | **130** |
| NOT-BUILT | 78 | **78** |
| CANNOT-VERIFY | 2 | **2** |
| CONSTRUCTED% | 69.9 % | **69.9 %** |
| CORRECT%, raw | 20.3 % | **21.1 %** |
| **the gap** | **49.6 points** | **48.8 points** |

**Eight tenths of a point, again, and the second half of this section is worth more than the
first.** What it is actually worth: a live participant surface that shipped the user id of every
person who had declined or not yet answered a tag, closed; a §23 predicate that the grouping had
filed as unreachable and was not; and one of the two sentences D.11 wrote as a ceiling, turned
into a test by first proving the ceiling was real.

---

## F. A live defect fixed, a green withdrawn, and an enumeration that repeated the mistake it was written to correct — 2026-09-13, measured at HEAD `46156b375`

§E worked the BRANCH queue — groups (a) and (b) of §D.1 — and left twelve rows open with a
reason against each. This section did not work that queue again. It took ONE row that §D.1 had
filed in group (c), read the sentence that kept it BUILT-BUT-WRONG, and followed it out of the
document and into the code it names.

The sentence is **H239's**, §B.5, and it is worth quoting because it contains its own
instruction:

> HELD: PLANNED+SAVED alone is refused with `PLANNED_OR_SAVED_ONLY` … BBW because it is proved
> on `evidence.ts`, which no route imports; **the live stamp path enforces the rule by requiring
> a real check-in (H4) and is not covered by this test**.

Two claims. The second one — *the live stamp path enforces the rule* — had never been checked.
It was inherited from H4's body evidence, which names two routes and was written in the body,
before section A. **One of the seams it does not name minted a `verification_level: 'checkin'`
city stamp for a layover the route itself validates as being in the FUTURE, on two open
production flags. That is fixed here.**

**AND THEN THIS SECTION MADE THE SAME MISTAKE AND CAUGHT ITSELF.** The fix was written, the
tests were written, and this section was drafted with H239 moving **W → C** on an enumeration of
*"every path in the repository that mints a durable 'you were here' artifact"*. That enumeration
was a search for callers of two FUNCTIONS, and the sentence it was made to support is about a
SET. There is a second stamp family it never looked at — §F.2 — and one of that family's call
sites awards a stamp carrying a destination city **at trip creation**. So the C is not earned,
H239 stays **W**, and **H4, which makes the identical universal claim, comes DOWN to W with
it.** The headline in §F.10 therefore moves the wrong way, and moving the wrong way is the
correct outcome here: the row was never true, and this section's first draft would have
re-greened it on exactly the kind of evidence that made it false in the first place.

The denominator is still **266**, the counting rule in "How I decided what counts" is unchanged,
and the four buckets are unchanged. No migration was written and none was applied. Production
project `ajrurzioarfkagpuxfnb` was not touched, queried or altered.

### F.1 The defect, stated before the fix

`POST /api/airport/sessions` creates a layover session. Thirty lines before the end of the
handler it refuses a session whose flight has already gone —
`artifacts/api-server/src/routes/airport.ts:628#if (departureMs <= Date.now()) {`, *"This layover
has already departed — set a departure time in the future"*. **A layover session is, by the
route's own validation, a FUTURE event.**

At the end of the same handler it minted a Passport stamp for the layover's city.
**RE-READ AT INTEGRATION, NOT RE-POINTED — that write is no longer in this handler**, and §F.7's
consequence 3 said this evidence would go stale for exactly this reason. The sibling Layover lane
deleted the creation-time seam outright; the only `passport_stamps` write left on this route is
reached from `DELETE /airport/sessions/:id`, behind four terms, at
`artifacts/api-server/src/routes/airport.ts:2991#sourceType: "layover_session", verificationLevel: "checkin",`.
The paragraph stays in the PAST TENSE because the defect it describes was real at `6d4fd1a06` and
is not real now; what follows is the reading of the tree as it was, and §G says what the merge did
with it. Nothing required the ARRIVAL to have happened. A traveller describing next Tuesday's connection
was recorded in `passport_stamps` as having **checked in** to an airport city they had not
reached, and might never reach.

**It was live, not latent.** The committed production snapshot records
`artifacts/api-server/src/lib/capability/snapshots/20260908-production-schema.json:5917#airport_mode_enabled`
and
`artifacts/api-server/src/lib/capability/snapshots/20260908-production-schema.json:5996#passport_stamps_enabled`.
Both gates on the path are open. **This is not an unapplied migration and not a flag seeded
false** — the two causes that account for 105 of this document's 131 remaining W rows. It is a
line of TypeScript that was missing.

**Three spec rules, one write.** §1 — *"Planned, saved, or nearby must never be represented as
experienced without occurrence evidence or user confirmation"*. §25's H239 — *"planned activity
without occurrence cannot earn a visit Memory/Stamp"*. And §4's TruthLevel, because the row does
not merely exist, it **names its own evidence** `checkin` on
`passport_stamps.verification_level` — a rung that says a check-in happened, which is a claim no
amount of typing into a form can earn.

**HALF OF THIS WAS ALREADY ON THE RECORD IN ANOTHER CENSUS AND THIS SECTION DID NOT FIND IT.**
`census-layover.md` scores the same write **W** twice and describes it exactly: L19 —
*"it fires at session **creation**, not post-session, and the only gate is the
`passport_stamps_enabled` flag; the user never elects it"* — and L162 — *"A stamp is written
automatically at session **creation** … before the traveller has completed anything and without
electing anything."* That is the Layover lane's finding, written down, correct, and sitting there
while this census carried H4 at BUILT-AND-CORRECT on the strength of two routes it had read and
three it had not. **This is the §D.2 seam for the third time**: a defect found by one census and
fixable by another, fully documented, owned by neither. What §F adds to L19 and L162 is the
sharper rule (§1 is about what the artifact CLAIMS, not about who elected it), the fix, and the
red-first evidence. The observation was not its own.

### F.2 The seams — one family enumerated to the bottom, and a second one this section did NOT read

**There are TWO stamp families in this repository and they write DIFFERENT TABLES.** Saying so
first is the whole point of this subsection, because the first draft of it said "five seams" and
meant "five callers of the two functions I happened to grep for".

**Family one: `passport_stamps` and `passport_memories`, minted through `createStamp` /
`createSuggestedMemory`. ENUMERATED TO THE BOTTOM, and the enumeration is closed rather than
asserted:** the ONLY `.insert(` into `passport_stamps` anywhere outside `src/test/` is inside
`artifacts/api-server/src/services/passport/PassportStampService.ts:63#export async function createStamp`
— every other write to that table is an `update` of `catalog_id` or `visibility`, never a new
stamp — so enumerating that function's callers enumerates the family. Five route seams, each
listed with the occurrence evidence it requires:

| seam | what it requires before it mints | verdict at `6d4fd1a06` |
|---|---|---|
| `POST /api/trips/:tripId/geofence/check-in` | a GPS fix inside the meetup radius, inside the window, by an ACCEPTED member, whose check-in row actually persisted (`artifacts/api-server/src/routes/geofence.ts:761#if (distanceM > radiusM) {`) | enforces |
| `POST /api/me/passport-stamps/gps` | `artifacts/api-server/src/routes/location.ts:382#if (stampType === "city_visit" && city && trustLevel === "gps_verified") {` — GPS-verified or nothing | enforces |
| `POST /api/hidden-gems/:id/verify-visit` | `artifacts/api-server/src/routes/hiddenGems.ts:957#const result = await recordGpsCheckin` and then only when the check-in is not flagged suspicious | enforces |
| `POST /api/me/safe-return/sessions/:id/confirm` | the traveller's own explicit "I am safe" (`artifacts/api-server/src/routes/safeReturn.ts:562#stampType: "safe_return",`), which is §1's *user confirmation* limb | enforces |
| `POST /api/airport/sessions` | **nothing.** The session is created and the stamp follows | **does not enforce** |

Four of five held. The fifth is the one nobody had opened, and it was the only one whose
requirement was not in the route at all. It is gated now (§F.3).

A **sixth** writer reaches `passport_memories` without going through `createSuggestedMemory`:
`POST /api/events/:id/memory` inserts directly. It was opened and it holds — the handler refuses
unless `events.state` is `completed`, and the row is written by an explicit host action, so both
of §1's limbs are present. It is named because the first draft's grep would not have found it,
and a reader checking that grep would have concluded the family had five members when it has six.

**Family two: `user_stamps`, minted through
`artifacts/api-server/src/services/passport/StampAwardEngine.ts:799#export async function awardStamp`.
NOT READ, AND THAT IS WHY NOTHING IN THIS SECTION MOVES FORWARD.** It is a criteria engine over
`stamp_definitions`, reached from **more than fifteen** route call sites — the Trips, Events, Follows, Rent-a-Buddy,
Hidden Gems, Safe Return, Stamps, Stamp Catalog and two Admin routers — and this section read
one of them. That one is enough to show the question is live rather than theoretical:
`artifacts/api-server/src/routes/trips.ts:424#definitionSlug: "first_trip_created",` awards
`first_trip_created` and `trip_planner` **at trip creation**, for a trip whose status is merely
not `draft`, passing the trip's `destinationCity` and `destinationCountry` onto the stamp row.
Those two slugs are PLANNING achievements and a badge for planning a trip is not a visit claim — but whether a `user_stamps` row carrying a city
is rendered anywhere as somewhere the traveller has BEEN depends on that table's readers, and
this section did not read them either. (It did check the one that would have been worst:
`artifacts/api-server/src/lib/mapProducers/personalCityProducer.ts:272#.from("passport_stamps")`
is the map's personal-city producer and it reads `passport_stamps`, the audited family, not
`user_stamps`.)

**Rule 7 of this census's own method decides what to do with that**: a prohibition is
BUILT-AND-CORRECT when *"I read that surface and no violating path exists"*, and is NOT
assumed-satisfied when *"I did not read a definitive surface"*. Family two is a definitive
surface for a claim phrased "never". It was not read. So H239 does not move and H4 comes down.

### F.3 What was built

**1. §1's occurrence question, answerable on a route.**
`artifacts/api-server/src/services/memory/occurrenceGate.ts:80#export function declaredOccurrenceHasHappened`
takes an instant a caller declared something happened at and answers whether it has happened,
with the clock passed in so it is pure and replayable. Three properties, each separately
mutation-covered:

  - **It refuses with §6's OWN reason code, not a second vocabulary.**
    `artifacts/api-server/src/services/memory/occurrenceGate.ts:105#reason: "PLANNED_OR_SAVED_ONLY"`
    is the string §6 already uses at
    `artifacts/api-server/src/services/memoryProjections/evidence.ts:424#PLANNED_OR_SAVED_ONLY`,
    imported as a type rather than retyped, so the engine's refusal and the route's refusal are
    the same token and a reader grepping for it finds both halves. Two refusals it adds —
    `NO_DECLARED_OCCURRENCE` and `UNPARSEABLE_OCCURRENCE` — are deliberately NOT §6 codes,
    because §6's normalizer rejects those cases before eligibility ever runs and there is no
    eligibility code to borrow.
  - **It allows no clock skew, which is the OPPOSITE of `evidence.ts` and is the point.**
    `FUTURE_SKEW_MS` forgives a producer whose clock runs fast when it REPORTS an observation;
    the observation still describes something that happened. Forgiving skew here would admit an
    occurrence that has not happened, which is the exact claim §1 forbids.
  - **It fails closed three ways.** Absent, unparseable and not-yet-arrived all refuse. The
    boundary is `<=`, not `<`, so an artifact minted in the same millisecond as the event it
    records is not refused — that is a real shape and is not the one this gate exists to stop.

**2. The seam gated.** **RE-READ AT INTEGRATION — the gate is on a different route than this
section left it on, and it is still this predicate.** §F gated the CREATION-time seam inside
`POST /airport/sessions`; that call site no longer exists, because the merge kept the Layover
lane's structure, so this section names no line number for it — a citation to a deleted line is
the one kind this document must not carry. The predicate now decides at
`artifacts/api-server/src/routes/airport.ts:2965#const occurrence = declaredOccurrenceHasHappened(args.session.arrivalTime, Date.now());`,
the fourth term of `artifacts/api-server/src/routes/airport.ts:2928#async function writeElectedLayoverStamp`,
and a refusal is still LOGGED with its reason and policy version rather than being silent — and
is now also REPORTED to the caller, as `reason: "not_occurred"`, which the creation-time seam
could not do because it was fire-and-forget.

**§F PREDICTED THIS WOULD MAKE THE PREDICATE UNREACHABLE. IT DID NOT, AND §G WITHDRAWS THAT
PREDICTION.** Completion and election are things the CALLER says; `endSession` consults no clock,
so moving the seam answered §3 and §17 and left §1 open. Composing the two lanes was the only
resolution that closed all three limbs.

**The refusal is still terminal for that session**: nothing re-runs the seam after the session is
closed, so a layover set up in advance and closed out early earns no stamp at all. That removes a
stamp that was never earned and keeps the one that was — the real flow is a traveller who opened
Airport Mode in the terminal, whose declared arrival is already in the past and who elects the
stamp on the way out, and the control test below is exactly that traveller.

**3. §28.11 on the one Compass accessor that was swallowing its reads.**
`artifacts/api-server/src/compass/MemoryCompassTools.ts:546#async function toolMemoryGetEvidence`
made two reads — `memory_items` and `memory_tags` — and destructured neither one's `error`.
supabase-js RESOLVES on a database failure, so `{ data: null }` is what an empty table and an
unreadable table both look like, and `?? []` turned the second into the first: an unreadable
participant table was reported as `confirmed_participants: 0`, a claim that **nobody was there**,
handed to a language model beside a field named `evidence_store_reason`. Every other read in that
file checks and refuses; these two were the exception. They now answer `null` beside a named
unavailability (`artifacts/api-server/src/compass/MemoryCompassTools.ts:581#const tagsUnavailable`),
so the difference between "zero" and "unknown" survives to the prompt.

**4. A block that stopped the profile card and not the Memory card beside it.**
`artifacts/api-server/src/services/telegraph/shareables.ts:452#const loadMemory` is a THIRD
re-derivation of the Memory visibility rule — a fourth READER of it, counting §23's predicate
itself. H205's ceiling counts two re-derivations, `routes/contentStamps.ts` and
`routes/wellKnownShare.ts`, both of which say in their own comments that they mirror the
predicate. This one does not say so, and it disagreed with the predicate on exactly one rung:
`memoryReadPolicy.canReadMemory` checks blocks in both directions and `loadMemory` checked none.
`loadProfile`, the next loader down in the same file, has checked them since it was written. So a traveller who blocked somebody had that person refused their
PROFILE share card and served the title and city of their PUBLIC Memory in the same chat. The
check is now there
(`artifacts/api-server/src/services/telegraph/shareables.ts:487#.eq("blocker_id", r.owner_id as string)`),
one direction only — the owner blocking the viewer, matching the neighbour — because widening a
share rule beyond what the file's own sibling applies is a product decision and not a repair of a
divergence.

**Where the assertions live.** `src/test/memoryPlannedNotExperienced.test.ts` is new and was
appended to the END of `package.json`'s `test` script, so `check:test-registration` covers it;
the other two suites already ran.

| what it asserts | file |
|---|---|
| a future instant is refused, with §6's own reason code | `artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts:217#refuses an instant that has not arrived` |
| a layover that has not begun writes NO `passport_stamps` row | `artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts:281#a session whose arrival is still in the future` |
| the gate is not a blanket deny — a past arrival still earns it | `artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts:306#the refusal is not a blanket deny` |
| turning up inside the meetup radius DOES earn the stamp | `artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts:492#CONTROL — turning up inside the radius` |
| checking in before the window opens earns nothing | `artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts:517#checking in before the window opens` |
| an invited-but-not-accepted member earns nothing | `artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts:532#an invited-but-not-accepted member earns nothing` |
| an unreadable participant read is not "nobody was there" | `artifacts/api-server/src/test/memoryCompassTools.test.ts:584#an unreadable memory_tags read is not reported` |
| an unreadable attachment read is not "nothing is attached" | `artifacts/api-server/src/test/memoryCompassTools.test.ts:596#an unreadable memory_items read is not reported` |
| a blocked viewer is refused the owner's public Memory card | `artifacts/api-server/src/test/telegraphShare.test.ts:396#a Memory whose owner has blocked the viewer degrades` |
| an unreadable `blocks` withholds rather than shares | `artifacts/api-server/src/test/telegraphShare.test.ts:411#an unreadable blocks table withholds` |

**THE CLIENT IS SCHEMA-STRICT, AND THAT IS LOAD-BEARING FOR EVERY "NO ROW WAS WRITTEN"
ASSERTION.** The airport and geofence cases drive their real routers against
`makeSchemaStrictClient`, which validates every column named in a select, a filter or a write
body against `src/test/generated/liveColumns.json` — the live `information_schema` — and answers
42703 exactly as PostgREST does. An assertion that no `passport_stamps` row was written proves
nothing if the write it stands in for would have failed on a dead column anyway, so both CONTROL
cases additionally assert `deadColumnErrors` is empty: the earning path names only columns
production has, which is what makes the refusals statements about production rather than about
the fake.

### F.4 Row moves

| id | was | now | why |
|---|---|---|---|
| H239 | W | **W** | **DRAFTED AS W → C AND WITHDRAWN BEFORE IT WAS COMMITTED, for a reason worth more than the move would have been.** §25's invariant is "planned activity without occurrence cannot earn a visit Memory/Stamp". Two of its three blockers were genuinely removed here: the rule is now true on every seam of family one (§F.2), and the live surface is covered by a registered suite rather than only by `evidence.ts` — which is §B.5's own rule for grading a §25 invariant, *"BAC only when the property is proved on a path production serves — either the module is imported by a route, **or a separate registered suite covers the live surface**"*, the rule H236 and H240 are C under. The third blocker is the one this section put there: **`user_stamps` and `StampAwardEngine` were never read**, and an invariant phrased "cannot" is not proved by auditing the stamp family you thought of. Also unchanged: the engine half — `evidence.ts` is imported by no route — and the three family-one seams that are argued from reading rather than driven. |
| H4 | C | **W** | **A BACKWARD MOVE, AND THE MOST USEFUL THING IN THIS SECTION.** §1: "Planned/saved/nearby never represented as 'experienced' without occurrence evidence or user confirmation." Its C has stood since the body on evidence naming `routes/geofence.ts` and `routes/location.ts` — two of the five seams of ONE of the two stamp families. It was **already false** when this section began: `POST /api/airport/sessions` wrote a `checkin`-verified city stamp for a layover validated as being in the future, on two open production flags. That half is fixed. What is NOT fixed, and what takes the row down rather than restoring it, is that the claim is universal and family two — `user_stamps`, fifteen-plus call sites, one of which awards at trip creation with a destination city attached — has not been read by anybody. **Rule 7: a prohibition graded without reading a definitive surface is not assumed-satisfied.** The row returns to C when somebody enumerates `StampAwardEngine`'s callers the way §F.2 enumerates `createStamp`'s, and not before. |
| H264 | C | **C** | **A SECOND FALSE GREEN, CLOSED THE SAME WAY.** §28.11 — "never swallow projection/schema failures into plausible-looking empty history without structured error state" — was C on `routes/memories.ts`'s block-lookup branch. Rule 7 of this census's own counting method grades a prohibition **on the surface where a violation would live**, and a violating path existed: `toolMemoryGetEvidence` reported an unreadable participant table as `confirmed_participants: 0`. Read the object, not the sentence about it. Green now because the two reads bind their errors. **D-C2 DOES NOT RESCUE THE OLD GREEN AND DOES NOT UNDERWRITE THE NEW ONE.** If the OpenAI credential is absent the tool never executes — but rule 7 asks whether a violating path exists on the surface, and §A.2 already holds that unreachable code is BUILT. A prohibition is not satisfied by its violation being unreachable. This row's C rests on the live branch in `routes/memories.ts` and on there now being no violating path beside it, neither of which turns on a model choosing anything. **WHY THIS GREEN SURVIVES WHEN H4'S DOES NOT, stated rather than left to be wondered at:** rule 7 turns on whether a DEFINITIVE surface was read, and for H4 there is a discrete, nameable, unopened body of code — a whole second minting family. For §28.11 there is not: the surfaces are the memory and highlight read paths this census grades, earlier sections read them, and this pass read every read in the file it repaired. **CEILING, and it is a real finding for the next lane: no guard enforces this half.** `check:unchecked-supabase-reads` scans `compass/` and would still not have caught it — its in-scope tiers are exclusion tables, gate-FUNCTION names (`require*` / `can*` / `is*` / `check*` …) and guard-FILE names, and `toolMemoryGetEvidence` in `MemoryCompassTools.ts` is none of the three. That scanner is about authorization failing open. §28.11's other half — a factual report that turns an unreadable table into a confident number — has no mechanical guard at all, and the only reason this one was found is that somebody read the function. |
| H205 | C | **C** | **Evidence corrected, verdict unmoved.** §B.2 states the row's ceiling as *"two other surfaces re-derive the rule instead of calling it"*, and §C names the same two. There are **three**, not two: `artifacts/api-server/src/services/telegraph/shareables.ts:452#const loadMemory` is a third re-derivation — a fourth reader of the rule, counting the predicate itself — and unlike the other two it says nothing about mirroring anything and DISAGREED with the predicate on blocks until §F.3. The verdict survives because the requirement is the predicate and the predicate exists with its surface parameter; what is now true and was not is that one of the three transcriptions had drifted, which is the failure mode the ceiling was written to warn about, arriving. |
| H84 | W | **W** | **Evidence corrected, verdict unmoved, and the correction is against the half the row said was FINE.** §A.3 records H84's split as *"the blocking half is still correct and fail-closed; the deletion half was never true"*. The blocking half was not universally correct either: a Memory share card reached a viewer its owner had blocked. That is closed here. W stands on the deletion half, which is owner decision **D6** and is untouched — `highlights` and its four children are still in `UNCLASSIFIED_BACKLOG`. |
| H120 | W | **W** | **Evidence extended, verdict unmoved.** §C.3 has this row at W because `getMemoryEvidence` is *"an accessor over an absent store"* — §3.6's `memory_evidence` has no migration in this tree (H24). That is unchanged and is the whole of the W. What changed is that the accessor's two reads no longer answer a database failure with a confident zero. An accessor that is honest about a store that does not exist is still an accessor over a store that does not exist. |

**One row moved, and it moved DOWN. No row in another lane's census was moved.** §F.7 names the
two census-layover rows and the two census-compass rows this work bears on and leaves all four
alone — and note that H4 coming down does NOT license taking census-layover's L19 or L162 down
with it: those rows are scored against the Layover spec's "if the user chooses" limb, they are
already W, and this lane does not grade them.

### F.5 Red-first: every mutation, and the one the harness refused

Every mutation was applied to **production** code, the named suites measured, the file restored
from a byte-for-byte backup and `cmp`-verified. None is a change to a test or to a constant an
assertion reads back. The harness inherits §C.4's rule: **an anchor that is not unique in its
file is REFUSED before it is applied.**

**All three defect claims below went red on their FIRST run, against the tree as it stood — no
mutation was needed to produce them.** That is said plainly because it is the difference between
finding a defect and adding coverage to code that was already right, and this section did both:
the geofence cases (7 and 8) and the geofence control were green from the start and are covered,
not repaired.

| # | mutation (production file) | what went red |
|---|---|---|
| — | *none: the test was run against the tree* | **the layover case failed with the offending `passport_stamps` row quoted in full** — `city: 'Cebu'`, `source_type: 'layover_session'`, `verification_level: 'checkin'`, for an arrival 48 hours in the future |
| — | *none: the test was run against the tree* | **the Compass case failed with "a failed participant read was served to the model as a confident zero"** |
| — | *none: the test was run against the tree* | **the share case failed with "a blocked viewer was served the owner's public Memory"** |
| 1 | `routes/airport.ts`: the gate is asked with `Number.MAX_SAFE_INTEGER` as "now", so every arrival reads as past | the future-arrival case |
| 2 | `occurrenceGate.ts`: the not-yet-arrived branch removed | the predicate case AND the route case — the pair that shows the route decides through the gate rather than beside it |
| 3 | `occurrenceGate.ts`: an absent instant no longer refuses | the absent-instant case |
| 4 | `occurrenceGate.ts`: an unparseable instant no longer refuses | the unparseable case |
| 5 | `occurrenceGate.ts`: `>` becomes `>=`, so the boundary instant is refused | the boundary case — the one branch a reader would call an off-by-one and leave alone |
| 6 | `routes/geofence.ts`: the outside-radius refusal stops returning | the 5-km case, on the stamp assertion. **It also crashed the next case with a socket hang up**, because the handler then answers twice; that second red is an artifact of a crude mutation and is not a second finding |
| 7 | `routes/geofence.ts`: a window that has not opened reads as open | the before-the-window case |
| 8 | `routes/geofence.ts`: a non-accepted member reads as accepted | the invited-member case |
| 9 | `MemoryCompassTools.ts`: `tagsUnavailable` forced false | the participant case |
| 10 | `MemoryCompassTools.ts`: `itemsUnavailable` forced false | the attachment case |
| 11 | `MemoryCompassTools.ts`: the count hard-coded to 0 while the marker stays | the participant case — so the assertion is on the COUNT and not merely on the marker beside it |
| 12 | `shareables.ts`: the block filter points at the wrong owner | the blocked-viewer case |
| 13 | `shareables.ts`: the `bErr` arm deleted, so an unreadable `blocks` reads as not blocked | the unreadable-`blocks` case |
| — | **REFUSED** | a fourteenth, deleting the two-line block guard from `loadMemory`, was refused before it ran: its anchor occurs **twice** in the file, and the second copy is `loadProfile`'s. A mutation on a non-unique anchor proves nothing, and in this case it would have mutated the wrong function and reported whatever red came out |

**What else would turn this red.** Deleting `src/test/memoryPlannedNotExperienced.test.ts` turns
`check:test-registration` red, because it is registered. Adding a sixth `createStamp` seam turns
**nothing** red — §F.2 is an enumeration read once, not a guard, and that is this section's
largest stated gap.

### F.6 The ceiling

1. **NO row moved forward, and one moved back.** §D.1's arithmetic is unchanged and is restated
   in §F.8: **105 of the 131 W rows are capped by storage nobody has applied**, and applying
   eight migrations remains the single largest available move on this document and an owner act.
   What this section changed is the code, in three places, and the record, in six rows.
2. **THE BIGGEST HOLE IS THE ONE THIS SECTION OPENED IN ITSELF: `user_stamps` is unread.**
   `StampAwardEngine.awardStamp` is reached from more than fifteen route call sites and this
   pass read one of them. Until somebody reads the rest, neither H4 nor H239 can be green, and
   the reason is not a migration, a flag or an owner — it is that nobody has looked.
3. **Three of family one's five seams are read, not driven.** `routes/location.ts`, `routes/hiddenGems.ts`
   and `routes/safeReturn.ts` were opened at this commit and each was found to require a GPS fix,
   a GPS check-in, or the traveller's own confirmation. That is an argument from reading, and a
   reading is not a test. They are in this census's `CENSUS_SCOPE` so a change to any of them
   ages the document, which is the weakest of the three available guarantees and is the one this
   section has.
4. **The airport refusal is terminal.** A traveller who sets up a layover in advance now earns no
   stamp for it, ever, because nothing re-runs the seam once the arrival passes. That is the
   correct direction — the stamp was unearned — but it is a behaviour change and the owner
   decision it opens is **D-F1** below.
5. **The gate answers about a DECLARED instant, not an observed one.** The arrival time is
   typed by the traveller. §1 admits *user confirmation* as a limb, and a person who says "I
   landed at 14:00" when 14:00 is in the past is confirming they are there; but the stamp still
   carries `verification_level: 'checkin'`, which names an observation the server never made.
   §4's own TruthLevel would call that `USER_ASSERTED`, and H41 already scores this repository's
   `unverified/gps/checkin/verified` ladder BUILT-BUT-WRONG for being a different vocabulary
   from §4's. **That is not repaired here** and it is **D-F2**.
6. **The §28.11 repair makes the accessor honest; it does not make it useful.** H120 stays W.
7. **The share-card block check is one-directional.** A viewer who blocked the OWNER still sees
   the owner's public Memory card. `canReadMemory` refuses in both directions. The divergence is
   narrower than it was and it is not gone.

### F.7 Files changed outside this lane, named loudly

`artifacts/api-server/src/routes/airport.ts` is graded by **census-layover**.
`artifacts/api-server/src/services/telegraph/shareables.ts` and
`artifacts/api-server/src/test/telegraphShare.test.ts` are graded by **census-telegraph** and
cited by **census-discovery**. `artifacts/api-server/src/compass/MemoryCompassTools.ts` is cited
by **census-compass**. They were changed anyway, because H4, H239, H205, H84 and H264 are rows of
THIS census and the defects are in those files.

**Four rows in other censuses are affected and NONE was moved here.**

  - **census-layover L19 and L162** both score the layover stamp seam **W**, and both name
    "fires at session creation" as the reason. That reason is now only half true: it still fires
    at session creation, and it now fires only for a layover that has begun. Whether that is
    enough to satisfy L19's *"post-session durable artifacts **if the user chooses**"* is the
    Layover lane's judgement, not this one's — the "if the user chooses" limb is untouched and
    the traveller still elects nothing. **Those rows are very likely still W, and the Layover
    lane should re-read them anyway**, because the sentence under them has changed.
  - **census-compass CH-01 and CH-02** rest on `MemoryCompassTools.ts`. Neither can have moved:
    no tool was added or removed, `MEMORY_TOOL_SPEC_NAMES` and `MEMORY_COMPASS_TOOL_DEFINITIONS`
    are byte-identical, and CH-01's claim — that not one of the eight issues an INSERT, UPDATE or
    DELETE — is untouched by a change that adds two reads of an `error` field. The argument is
    written out per row in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`.
  - **census-telegraph** grades `shareables.ts`. Its §5.3 contract row and its share-family rows
    are unaffected in direction: a loader that withholds MORE is still a loader that withholds,
    and the new arm uses `unauthorized`, a state that contract already has. Not read, not
    re-derived, not moved.

**A SIBLING LANE IS FIXING THE SAME DEFECT AND THE TWO FIXES COLLIDE. THE INTEGRATOR HAS TO
CHOOSE, AND THIS SECTION SAYS WHICH WAY IT SHOULD GO EVEN THOUGH THAT COSTS IT ITS OWN CODE.**
While this was being written, the Layover lane was closing L19 and L162 on the same seam, on its
own branch, by a different and **better** route: it DELETES the creation-time seam outright and
mints the stamp only at end-of-session, when the outcome is `completed` **and** the traveller has
elected it. That satisfies BOTH limbs — §1's occurrence limb, because a completed session is one
that happened, and L19's *"if the user chooses"* limb, which §F's gate does nothing about and
which §F.7 concedes below. **If the two land together, keep theirs.** Three consequences, stated
now so the merge is not a discovery:

  1. `declaredOccurrenceHasHappened` becomes unreachable from `routes/airport.ts` — there is no
     creation-time seam left to gate. The predicate is not thereby worthless (it is the only
     place §1's rule is written as code rather than as an `if`), but a census may not score an
     unreachable module BAC, and §A.2 is this document's own rule for that.
  2. **The CONTROL case of the airport suite goes RED**, and it should:
     `artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts:306#the refusal is not a blanket deny`
     asserts that a past arrival DOES earn a stamp at session creation, and under their fix
     nothing earns one at session creation. The refusal case stays green, and a suite whose
     refusals still pass while its control no longer can is proving less than it looks —
     §B.1 built four paired controls into the §25 fixtures for exactly that reason, so that
     *"a gate that refuses everything fails all four"*. Whoever merges must re-point this
     control at the end-of-session path, not delete it.
  3. **Neither H239 nor H4 is green, so the merge cannot break a green — but their evidence in
     §F.1 and §F.4 goes stale**, because it cites a seam that will no longer exist. Re-read, do
     not re-point. Both rows are held by §F.2's second family either way, and the merge does not
     touch that.

This is the §D.2 seam a third time and the §D.11 merge choice a second. Neither lane knew the
other was working it.

**Citations repointed — pointers, not judgements.** The three edits displaced fifty-two anchored
citations across five documents. Every one was moved by taking the EXACT TEXT of the original
line from the file at `6d4fd1a06` and finding that text in the file now; all fifty-two resolved
uniquely, none needed an ordinal, and none was moved by offset. Thirteen were verified by hand —
the file opened at the new number and the line read — before any number was written.

| document | citations repointed |
|---|---|
| `census-layover.md` | 22, all into `routes/airport.ts` |
| `census-telegraph.md` | 18, all into `services/telegraph/shareables.ts` |
| this document | 10, into `compass/MemoryCompassTools.ts` and `test/memoryCompassTools.test.ts` |
| `census-compass.md` | 1, into `compass/MemoryCompassTools.ts` |
| `census-discovery.md` | 1, into `services/telegraph/shareables.ts` |

`check:doc-citations` reports **RESULT clean**, anchored **2521** against a floor of 2507, and
unanchored **6443** against a ceiling of 6443 — unchanged, because every citation this section
adds is anchored.

### F.8 The W column after this section, and precisely how many rows any branch can reach

§D.1's grouping was re-checked against the document as it stands rather than taken on trust, and
it still reproduces. This section takes nothing OUT of the W column and puts one row IN — and
what is worth reading is where the two rows it touches now sit.

**H239 leaves group (c) without going anywhere better.** D.1 filed it under "§25 invariants,
certified against fixtures of the unapplied stores", among the 106 rows no branch can reach.
That was true of its ENGINE half and false of its surface half, and the surface half is now
built and covered. What holds it is no longer storage; it is an unread second stamp family,
which is code. **It moves (c) → (a), and like H209 before it, it was a closeable row filed among
the unreachable ones — the difference is that this time closing it needs a pass nobody has
spent, not a paragraph.** **H4 joins (a) for the same reason.**

| group | rows at §E | rows now | what it means |
|---|---:|---:|---|
| **(a)** logic wrong or incomplete in code | 7 | **9** | H6, H10, H84, H189, H190, H193, H202 — §E.5 opened all seven — **plus H239 and H4, both waiting on one thing: somebody enumerating `StampAwardEngine`'s callers the way §F.2 enumerates `createStamp`'s** |
| **(b)** logic right, nothing reaches it | 5 | 5 | H104, H105, H165, H166, H198 |
| **(c)** capped by an unapplied migration, an absent column, or a flag with no row | 106 | **105** | H239 leaves it |
| **(d)** rests on an LLM choosing to call something | 3 | 3 | H120, H123, H126 — owner decision **D-C2** |
| **(e)** needs something nobody has written | 9 | 9 | |
| | 130 | **131** | |

**THE SINGLE CHEAPEST ROW IN THIS DOCUMENT IS NOW H4.** It needs no migration, no flag, no owner
decision and no product ruling — it needs one lane to read fifteen call sites and say, for each,
whether the stamp it awards is a visit claim and whether the thing that earned it had happened.
That is a day, and it is worth two rows.

**THREE of the 131 W rows are blocked on D-C2 and 128 are not.** The three are H120, H123 and
H126, and they are already W — D-C2's outcome cannot make them worse. The thirteen rows D-C2
genuinely endangers are all **C** rows and §E.7 enumerates them; that exposure is unchanged by
this section, which added nothing to group (d) and leant on nothing in it. **Every row this
section touched is reachable by an ordinary HTTP request with no model in the path:**
`POST /api/airport/sessions` and `POST /api/trips/:tripId/geofence/check-in` are ungated REST
routes, and the Telegraph share loader is reached by resolving a share reference.

### F.9 Owner decisions this section surfaces

- **D-F1 (NEW) — should a layover stamp be awarded when the layover actually starts?** The gate
  refuses at creation for a future arrival and nothing re-runs it, so a traveller who plans ahead
  earns nothing. The alternatives are all product decisions this lane may not take: award it on
  the first read of an active session whose arrival has passed; award it on the existing
  `layover_sessions.status` transition; or leave it, on the ground that Airport Mode is used in
  the terminal. **`layover_sessions.status` has no "arrived" value** — 2741 widened the CHECK to
  admit `returning` and nothing else — so option two is a migration, not a branch.
- **D-F2 (NEW) — may a self-declared arrival time carry `verification_level: 'checkin'`?** The
  layover stamp names its own evidence as a check-in. After this section it is at least a
  check-in that has happened; it is still one the server never observed. §23's H204 (CANNOT-VERIFY)
  is the neighbouring question — *clients may assert but not forge "verified"* — and the honest
  rung for a self-declared layover is `unverified`. Changing it rewrites rows census-passport and
  census-layover both grade, so it is named rather than done.
- **D-F3 (NEW) — should the Memory share card refuse a viewer who blocked the OWNER?**
  `canReadMemory` refuses in both directions; `loadProfile` and now `loadMemory` refuse in one.
  Two answers are defensible and the file's own neighbour picked one; this section matched the
  neighbour rather than deciding.
- **D-F4 (NEW, and it is a LANE assignment rather than an owner decision) — somebody must read
  `StampAwardEngine`.** It is the only thing between H4 and C, and H4 is now the cheapest row in
  the document. The work is: enumerate `awardStamp`'s call sites, and for each say (1) whether
  the stamp it awards is a claim about having BEEN somewhere, and (2) whether the thing that
  earned it had happened at the moment it was written. `POST /trips` is the one to start with,
  because it awards at creation with a destination city attached. This is named as a decision
  only because deciding NOT to do it is also a decision, and it would leave two rows red for the
  reason that nobody looked.
- **D-C2 (OPEN, inherited)** — unchanged, not leant on, and §F.8 says exactly which rows it
  reaches.
- **D6 (OPEN, inherited)** — unchanged, and it is what holds H84.
- **D-D1, D-D2 (OPEN, inherited)** — unchanged.

### F.10 The recomputed headline

Restated from `npm run -s check:census-integrity`, not counted by hand.

| figure | section E | **now** |
|---|---:|---:|
| Denominator | 266 | **266** |
| BUILT-AND-CORRECT | 56 | **55** |
| BUILT-BUT-WRONG | 130 | **131** |
| NOT-BUILT | 78 | **78** |
| CANNOT-VERIFY | 2 | **2** |
| CONSTRUCTED% | 69.9 % | **69.9 %** |
| CORRECT%, raw | 21.1 % | **20.7 %** |
| **the gap** | **48.8 points** | **49.2 points** |

**CORRECT went DOWN and the gap got WIDER, and this section is worth more than the one that
drafted itself going the other way.** The brief that commissioned this work asked for the gap to
shrink. What was available to shrink it honestly was one row, and one row turned out not to be
available: the draft that moved H239 to C rested on an enumeration of the stamp family this
author happened to grep for, which is the same shape of evidence that had been holding H4 green
since the body — two routes named out of two families, one of which nobody has read.

So the ledger for this pass is: **one live production defect found and fixed** (a route that
validates its own event as being in the FUTURE was writing a Passport row saying the traveller
had checked in, on two open flags); **two more found and fixed** (a Compass accessor reporting an
unreadable participant table as "nobody was there", and a share card that a block did not stop);
**three red-first suites added**; and **one green withdrawn**, because the thing this census
keeps catching in other passes turned out to be in this one too. A number that moved up by a
third of a point on that evidence would have been another false green in a document that has
already caught four — H84 in §A, H263 in §D, and H4 and H264 here — and the first one that was
avoidable by its own author before anybody else had to find it.

## G. The merge did not choose, and §F's first consequence was wrong — 2026-09-13, written by the INTEGRATING LANE

§F closed with a handoff: the Layover lane was fixing the same seam by a better route, **"if the
two land together, keep theirs"**, and three consequences were written down *"so the merge is not
a discovery"*. The integration verified that against both diffs rather than inheriting it. It is
half right, and the wrong half is the half §F could not see from inside its own branch.

**WHAT THE TWO FIXES ACTUALLY COVERED.** §1 has an occurrence limb; L19 and §17 L162 have an
election limb. Neither lane closed both:

| limb | §F's gate (creation-time) | Layover's fix (end-of-session) |
| --- | --- | --- |
| §1 — *"planned, saved, or nearby must never be represented as experienced"* | **yes** | no |
| L19 — *"post-session durable artifacts **if the user chooses**"* | no | **yes** |
| §17 L162 — *"durable only when the user elects Passport/Memory behaviour"* | no | **yes** |

§F assumed the occurrence limb came free with the other two — *"a completed session is one that
happened"*. It does not.
`artifacts/api-server/src/services/airport/LayoverSessionService.ts:279#export async function endSession`
is not temporal: it sets `status` to whatever the caller named, gated only on the row still being
live. Nothing between creating a layover and closing it consults a clock. So at the Layover lane's
tip, a traveller could create next Tuesday's connection, close it as `completed`, elect the stamp,
and be handed a durable `verification_level: 'checkin'` row for a city they had never reached —
the same defect §F found, moved one route along, and the move is what hid it, because each lane's
tests only covered its own half.

**THE OTHER LANE'S GREEN CASE WAS DEMONSTRATING IT.** `sessionRow()` defaults `arrival_time` to
`now + 5 minutes`, so *"a COMPLETED session the traveller elected to keep writes exactly one
stamp"* — passing — asserted that a layover which had not begun earns a stamp. A fixture default
carried the defect straight through a suite written to catch it. That is §B.1's paired-control
lesson from the other side: a control can be green and still be pointing at the wrong world.

**RESOLUTION: COMPOSE, DO NOT CHOOSE.** The merge kept the Layover lane's structure — creation
seam deleted, stamp minted at `DELETE` behind completion, election and the kill switch — and added
this document's predicate as a **fourth term** with its own published reason, `not_occurred`.

**§F'S CONSEQUENCE 1 IS THEREFORE FALSE AND IS WITHDRAWN.** It read *"`declaredOccurrenceHasHappened`
becomes unreachable from `routes/airport.ts`"* and concluded §A.2 forbade scoring the module. There
is a seam left to gate; it is on a different route.
**No row moves on this correction** — H4 and H239 were not green and are not made green by it.
What changes is that the module is reachable, which §F had conceded it would not be.

Consequences 2 and 3 stood and were carried out as written: the airport CONTROL case was
**re-pointed** at the end-of-session path rather than deleted — keeping its schema-strict
`deadColumnErrors` assertion, which is why it was kept rather than folded into the Layover suite —
and §F.1/§F.4's evidence was **re-read** rather than re-pointed.

**RED FIRST, AT THE OTHER LANE'S TIP.** Taken against `152b3b62e` itself, not a reconstruction:
4 cases, 3 green and 1 red, `expected: 0, actual: 1`. The three that passed are what make the red
mean something — a past arrival still earns exactly one stamp, the boundary is `<= now`, and
`not_elected` still binds independently — so the new case cannot be satisfied by a gate that
refuses everything. After the fourth term: **24 of 24** across the three affected suites.

**MUTATIONS.** Inverting the term (`!occurrence.occurred` → `occurrence.occurred`) fails 5 of 11 —
red in BOTH directions, so the term is not merely present but load-bearing each way. Disabling it
(`if (false && …)`) fails 2 of 17 across this document's suite and the Layover suite together,
which is what proves the re-pointed CONTROL is still doing work rather than passing vacuously.

**WHAT WOULD TURN THIS RED (P24).** A fifth caller of `createStamp` with
`sourceType: 'layover_session'` on a path that does not run the four terms; `endSession` gaining a
temporal guard of its own and the two disagreeing; or `arrivalTime` ceasing to be the instant the
layover begins. None is guarded against beyond the suites above, and no guard in this repository
would catch any of them.

---

## H. Three reads that published more than the fourth, and a guard the write never re-asserted — 2026-09-13

§F.8 left this document with a queue whose top row was H4 and whose arithmetic was D.1's: 107
of the W rows are capped by storage nobody has applied, and no branch reaches them. This pass
did not take the queue. It asked the question §D.2 asked — *which code actually serves this
data?* — of the two surfaces this census owns, and enumerated every read on each **to the
bottom** rather than to the first one that looked wired.

**Three of the four Memory reads that publish a coordinate performed the location protection.
Two of the three Highlight reads that publish a location to anyone but its owner performed the
§10 clamp.** (`GET /highlights/archived` is the fourth Highlight read and is not counted: it
filters `.eq("owner_id", user.id)` and publishes to nobody else, so §10 does not reach it.) The
read that was missing in each case is the SAME read — the PROFILE listing, the surface a
stranger lands on. Neither omission is visible from the function that does the protecting; it
is visible only from a list of callers, which is the same shape of finding as §F's unread
`createStamp` family and the reason that enumeration was worth the pass it cost.

A third defect came out of reading `PATCH /memories/:id` for the audience question and noticing
that the §5 guard decides on a value the write never asserts.

### H.1 The three defects, each stated before its fix

**D-H-1 — `GET /users/:userId/memories` served the exact coordinate of a Memory sitting on a
protected Hidden Gem. LIVE, on deployed tables, with no flag in the way.**

`artifacts/api-server/src/routes/memories.ts:163#function protectMemoryRow` clamps a non-owner
read to the STRICTER of two independent ceilings, and the two do not share a blocker:

- the owner's §10 `location_precision` rung is gated on `memory_location_precision_enabled`
  because migration 2338 is unapplied — inert today;
- the HIDDEN-GEM ceiling is gated on **nothing**. `public.hidden_gems` is in
  `artifacts/api-server/src/test/generated/liveColumns.json` with `sensitivity_level`, `status`,
  `latitude` and `longitude`, and `gemSensitivityToCeiling` returns `city` for `protected`,
  `reveal_after_save` and `reveal_after_acceptance` and `neighborhood` for `approximate`. At the
  `city` tier `coarsenMediaLocation` replaces the point with a deterministic snap to a 0.1°
  grid.

`GET /memories`, `GET /memories/:id` and `GET /trips/:tripId/memory` each called
`protectMemoryRow`. `GET /users/:userId/memories` went straight to `enrichMemories`, which
serialized the raw row. The same Memory, to the same viewer, disclosed a grid cell from the
discovery feed and an exact point from the owner's profile.

**D-H-2 — `GET /users/:userId/highlights` did not apply §10's precision clamp. LATENT, and
this is stated rather than dressed up: `highlight_projection_policies` is migration 2721 and is
not deployed, so `readProjectionPolicies` answers `absent` and the clamp is a documented no-op
on every route today.** Nothing is being disclosed right now that would not be. What is wrong is
structural: the day 2721 lands, two feeds honour the owner's rung and the profile read does not.

The cause is precise and worth recording because it is a class of mistake rather than an
oversight. `routes/highlights.ts` carried ONE section header over TWO independent passes —
`applyResurfacingControls` (§11/§21) and `applyLocationPrecision` (§10) — and ONE rationale:
*"WHY THIS RUNS ON THE FEEDS AND NOT ON THE PROFILE READ. §21 draws the line for us: 'Do not
resurface — retain and search privately; suppress PROACTIVE resurfacing.' GET
/users/:id/highlights is an explicit retrieval"*. That is exactly right about the first pass and
has nothing to do with the second: §10 does not distinguish proactive from explicit, and a
profile read publishes `location_name` to a viewer just as a feed does. One rationale was
written for two passes and was true of one of them.

**D-H-3 — `PATCH /memories/:id` evaluated the §5 lifecycle guard against a row value the write
never re-asserted. LIVE.** The handler reads the row, runs
`guardLifecycle(existing.state, d.state)`, and then writes with `.eq("id", id).eq("owner_id",
user.id)` and no precondition at all. `assertLifecycleTransition` treats `deleted` and `removed`
as TERMINAL, and its own comment says why: *"a plain PATCH {"state":"published"} put
moderator-removed content back into the discovery feed"*. The guard closes that door when the
row is already terminal **when it is read**. It does nothing when the row becomes terminal
between the read and the write — and `DELETE /memories/:id`, which sets exactly that state, is
an ordinary authenticated route the same owner can call from a second device. Publish on the
phone, delete on the laptop, and the Memory is published again, past a guard that ran, passed,
and was never re-asserted.

### H.2 What was built, and where

| what | where | why it is there and not somewhere else |
|---|---|---|
| Location protection moved INTO the list serializer | `artifacts/api-server/src/routes/memories.ts:2877#async function enrichMemories` and `artifacts/api-server/src/routes/memories.ts:2881#const safeRows` | It was the CALLER's job and one caller did not know. Every list response on this surface goes through this one function, so a fifth list read cannot omit the protection without omitting the serializer. It cannot be applied twice by accident either: coarsening is a grid snap, not an idempotent clamp, so `GET /memories` stopped pre-protecting in the same change |
| §10 clamp on the third Highlight read | `artifacts/api-server/src/routes/highlights.ts:686#applyLocationPrecision` | Matches the two existing call sites exactly. **No owner bypass was introduced**, because neither existing call site has one — `GET /highlights/active` clamps the viewer's own Highlights — while the Memory sibling `protectMemoryRow` does bypass. Matching what exists can only narrow disclosure; inventing a bypass on one of three routes would widen it |
| `readProjectionPolicies(null, …)` answers `unreadable` | `artifacts/api-server/src/services/highlights/highlightProjectionPolicy.ts:381#no service client is configured` | `getServiceClient()` can return null and the profile read tolerates that for its author lookup. `absent` means "this deployment has no such control"; a missing client means "there IS a control and we cannot see it". Deciding it in the function rather than at each call site is what stops the third caller picking the other one |
| A compare-and-swap on the field the §5 guard judged | `artifacts/api-server/src/routes/memories.ts:1546#write = existing.state == null` and the zero-row disambiguation at `artifacts/api-server/src/routes/memories.ts:1585#code: "conflict"` | Pinned to `state` and **nothing else**, which is the field-level half of §19's sentence. A whole-row precondition (`updated_at`) would refuse a caption edit racing a title edit — two commands that are not in competition — and §19 asks for the opposite. Zero matched rows are re-read so that "somebody changed it first" (409) is answered differently from "the write broke" (500) and from "it is gone" (404) |

`GET /highlights/archived` was examined and deliberately **not** changed: it filters
`.eq("owner_id", user.id)`, so it publishes nothing to anyone but the owner, and §10 governs
publication.

### H.3 Row moves

| id | was | now | why |
|---|---|---|---|
| H178 | N | **W** | §19 *"Concurrent edits should resolve at command/field level, not blind row last-write-wins"*. The row's evidence read *"builds a partial patch but applies it unconditionally; no version, no `If-Match`, no conflict detection"*. Two of those three are no longer true: the write is now conditional on the state the guard was judged against, and a losing command is told `conflict` rather than silently winning. **W and not C, for two reasons that are not rhetorical.** (1) Two concurrent edits of the same NON-lifecycle field still resolve by last-write-wins with no detection, because for those the server holds no base the client stated — that is owner decision **D-C1**, still open and not closed here. (2) The compare-and-swap is on the LEGACY write; the kernel path's precondition would be `memory_kernel_execute`'s, which is migration 2711 and unapplied. Since `memory_kernel_enabled` has no row in production the legacy path IS what serves traffic, so the guard is live — but half the code has it and half does not |

**One row. This section does not pretend that is a dent in 131,** and D.1's arithmetic is
unchanged: the largest available move on this document is still an owner applying eight
migrations.

### H.4 Defects fixed that moved NO row, and exactly why each moved none

| defect | the rows that grade it | why they do not move |
|---|---|---|
| D-H-1 (memory profile coordinate leak) | H76, H208 — both **W** | Both are capped on the OWNER-POLICY half, not the gem half. H76 says the ladder is *"applied to Memory reads only as a Hidden-Gem ceiling … never as an owner-selected precision"*; H208 says `canSeeExactLocation` *"answers 'is this coordinate on a protected gem', not 'may this viewer see this Memory's exact location under the owner's policy'"*. Both sentences are still true: 2338 is unapplied and no rung is stored. Fixing which READS run the ceiling does not add the rung |
| D-H-1 / D-H-2 | H241 — **C** | Its invariant is *"public location precision cannot exceed owner policy"*, and with 2721 and 2338 unapplied there is no owner policy to exceed on either surface. So the row was not false when it was written and is not made true by this work. What changed is the size of the claim: the invariant now holds over FOUR reads instead of two, and the surface that would have falsified it the day the migration lands is gone. **This is stated rather than scored, because a C that survives on "the violation was unreachable" is exactly the reading §F's H4 withdrawal refused** |
| D-H-2 | H81, H82, H201 — all **W** | All three end on the same clause: unenforced until 2721 lands. Adding a third enforcement point does not apply a migration |
| D-H-3 | H50 — **W** | H50's ceiling is the stored vocabulary: *"none of `CANDIDATE`, `CONFIRMED`, `MERGED`, `REJECTED` can be written"*. The guard being harder to race does not add a state to `0067`'s five |

### H.5 Red-first, and every mutation

**Red-first.** Each suite was run against `6d4327d66` with its fixtures in their FINAL form
before a line of the fix was written. The three file names below are written WITHOUT the
backticked citation form for one mechanical reason and it is an integration chore rather than a
judgement: `check:census-scope-coverage` counts every backticked path as a file this census
claims to grade, `CENSUS_SCOPE` in `artifacts/api-server/src/scripts/checkCensusFreshness.ts`
names this census's test files one by one, and these three are not in it yet. **They should be
— they are this section's evidence — so add all three to `CENSUS_SCOPE` in the same change that
registers them in the test script, and re-cite them here properly.** All three live in
`artifacts/api-server/src/test/`.

| suite | at `6d4327d66` | after | which cases were red |
|---|---|---|---|
| memoryProfileLocationProtection.test.ts | **5 tests, 2 pass, 3 fail** | 5 / 5 | the profile leak, the feed-vs-profile disagreement, and the fail-closed case. The two GREENS are the controls — owner bypass, and a Memory with no gem over it — and they are what stop a blanket coarsener passing |
| highlightProfilePrecisionClamp.test.ts | **6 tests, 3 pass, 3 fail** | 8 / 8 | the clamp, the unreadable/HIDDEN case, and the viewer's-own-Highlight case. **The CONTROL that passed is the important one**: `GET /highlights/active` clamps the same fixture, which is what proves the fixture resolves a policy at all. Two cases were added after the red run (see the withdrawn case below), so the counts are 6 → 8 rather than 6 → 6 |
| memoryPatchConcurrency.test.ts | **7 tests, 4 pass, 3 fail** | 7 / 7 | the delete race, the `removed` race, and the 409. Four controls passed throughout: an uncontested lifecycle PATCH, an uncontested field PATCH, the field-level merge, and the pre-existing 404 |

One fixture was corrected between the first red run and the final one, and it is named because
burying it would make the red look cleaner than it was: the 409 case originally interleaved
`state: "published"` against a `{state:"archived"}` patch, which `guardLifecycle` refuses
outright (draft → archived is not an arrow), so it failed with `invalid_state_transition` — red,
but for the wrong reason. Re-run with a legal arrow (draft → published, row turns `archived`
underneath) it is red for the right one, and the 4-pass/3-fail figure above is from that run.

**Eight mutations. All eight went red, and one of them did not the first two times it was run.**

| # | mutation | result |
|---|---|---|
| M1 | `enrichMemories` stops protecting (`safeRows = rows`) | RED — 3 of 46 across three suites |
| M2 | the owner bypass is neutered (viewer id replaced by a constant) | RED — 1 of 5 |
| M3 | the `state` precondition is deleted from the PATCH write | RED — 3 of 43 |
| M4 | the zero-row answer is downgraded from `conflict` to `db_error` | RED — 1 of 7 |
| M5 | the precondition is widened from `state` to a whole-row `updated_at` CAS | RED — 3 of 7, **and this is the mutation worth reading**: it fails the field-level case, so "a concurrent title edit must not block a caption edit" is load-bearing rather than decorative |
| M6 | the profile Highlight read stops clamping (`disclosed` → `visible`) | RED — 3 of 62 |
| M7 | a null service client answers `absent` instead of `unreadable` | RED — 1 of 55, **after** the branch was moved (below) |
| M8 | `enrichMemories` ignores the precision flag and always clamps | RED — 2 of 46 |

Every figure above is from a re-run against the FINAL committed code, not from the run that
first produced each mutation: M6 was recorded as "4 of 61" while the highlights suite was six
cases long and is "3 of 62" now that it is eight, and publishing the older number would have
been a count nobody could reproduce.

**M7 STAYED GREEN TWICE, AND THE REASON WAS A FALSE GREEN IN THIS PASS'S OWN TEST.** The first
form of the fix decided the null-client case *in the route*, and the route-level case written to
cover it passed whichever way the branch was written. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set for the test runner, so `getServiceClient()` never returns
null under the shared harness: it builds a real client pointed at a dead port, which reaches
`unreadable` by a DIFFERENT path — the probe throws. The case was asserting the right outcome
through the wrong mechanism, which is precisely the shape this document has caught four times in
other people's work. It was **withdrawn**, the decision was moved into
`readProjectionPolicies` where it can be asserted directly on the function, and M7 then went red.
The suite is two cases longer as a result and one of them is a unit test rather than a route
test, which is why the "after" count is 8 and not 6.

### H.6 The ceiling

1. **The `allowed_user_ids` half of the PATCH race is NOT closed.** `canPublishMemory` is
   evaluated on a merged row, and when the patch changes only `visibility` the merge reads the
   allow-list from `existing`. A concurrent write that empties that array can still produce a
   `custom` Memory with nobody on the list — the undeliverable audience the predicate exists to
   refuse. It fails CLOSED (nobody can see it), so it is an honesty failure and not a
   disclosure, and it was left rather than closed with an array equality filter that could not
   be rehearsed against a real PostgREST from this branch.
2. **`GET /highlights/active` and `GET /highlights/following-feed` clamp the viewer's OWN
   Highlights.** This pass matched them rather than fixing them, because the fix widens
   disclosure. It is D-H-2 below.
3. **The gem ceiling is the only live half of the Memory clamp**, and it maxes out at
   `city`/`neighborhood`. `location_city` and `location_country` are never withheld by it. A
   Memory whose CITY is the disclosure is not protected by anything today.
4. **`MemoryCompassTools` was checked against D-H-1 and is clean, for a reason rather than by
   luck**: `MEMORY_FACT_COLUMNS` selects no coordinate at all, and the gem ceiling never
   coarsens below city, so the ceiling would be a no-op there. That is the file's own stated
   argument and it survives re-reading.
5. **routes/collections.ts and routes/engagement.ts read `memories` and are not graded by any
   row in this document.** (Both are written here WITHOUT the backticked citation form on
   purpose: `check:census-scope-coverage` counts every backticked path as something this census
   claims to grade, and neither is — they are named so the next lane can look, not adopted.) Neither was changed (they are other lanes' files) and neither was
   read to the bottom. collections.ts line 502 reads `id, title` for saved-collection previews with
   no visibility predicate, and engagement.ts line 110 gates `memory_like` on
   `owner_id === viewer || visibility === 'public'` with no `state` and no block check. Whether
   either is a defect needs the write paths that populate them, which this pass did not open.

### H.7 Evidence corrected without a verdict moving

| id | was | now | the correction |
|---|---|---|---|
| H241 | C | **C** | The row's evidence names one importer, `routes/highlights.ts`, and one module. The invariant now holds on four reads across both surfaces; the two that were not enforcing it are named in H.1. Verdict unchanged and the reason is in H.4 |
| H166 | W | **W** | The row reads *"`GET /trips/:tripId/memory` returns a raw list"*. It does not and did not: `artifacts/api-server/src/routes/memories.ts:2536#memory: {` returns a single `{ memory }` object for the canonical trip Memory, scoped to the trip OWNER. The gap the row is pointing at is real — `TripMemoryProjection` builds a LIST of a trip's Memories and nothing consumes it — but the sentence describing it was wrong, and a reader checking the row would have found a shape that does not exist |
| H165 | W | **W** | E.5 declined this row on the ground that *"nothing in this repository can tell you which clients read those shapes"*. That is too strong and the next lane should not inherit it. travel-buddy-standalone/src/services/highlights.ts line 172, `fetchUserHighlights`, calls `GET /api/users/${userId}/highlights` and maps `location_name` / `location_city` / `location_country`; travel-buddy-standalone/src/services/memories.ts line 270 calls `GET /api/users/${userId}/memories`. (Client paths are given in words for the same scope-coverage reason as H.6 item 5: this census grades the API server, and citing the client would claim otherwise.) ONE client is in this tree and is measurable — the repository's own convention is to measure it, which is how `memoryCommandBus.ts` established that `updateMemory` has zero production callers. What is NOT measurable is the mobile client: `docs/architecture/mobile-reachability-ledger.md` is pinned to `22ab17151b98adcaf81b5bc976cf1502043f535f` and must not track HEAD. **The honest blocker is "one of two clients is readable", not "no client is"** |

### H.8 Files changed outside this lane, named loudly

**Three pointer repoints in two documents this lane does not own, and they are pointers rather
than judgements — no verdict in either document is touched.** All three were caused by this
pass's own line shift in `artifacts/api-server/src/routes/memories.ts` and
`.../routes/highlights.ts`, `check:doc-citations` was CLEAN at `6d4327d66` and RED with them,
and each was re-found by its EXACT ORIGINAL LINE TEXT rather than by offset:

| document | citation | original line text at `6d4327d66` | now |
|---|---|---|---|
| `docs/architecture/census-telegraph.md:1897` | routes/memories.ts line 1772, anchor `state` | `    (q as any) = (q as any).eq("state", "published");` | line **1839** |
| `docs/architecture/census-telegraph.md:1935` | the same line, anchor `state", "published` | the same line | line **1839** |
| `docs/architecture/migration-queue.md:53` | routes/highlights.ts line 480 | `    .from("highlights")` — the `POST /highlights` insert, which is what that row's claim is about ("lists its inserted columns explicitly and uses no `SELECT *`") | line **498** |

The alternative was to hand the integration owner a gate that was green before this branch and
red after it, with a note saying where to look. Repointing is two characters per pointer and is
verifiable from the table above; leaving it would have been tidier for this lane and worse for
everybody else.

**Three consequences are NOT settled from here, because they need a file this lane may not edit:**

1. **`check:census-freshness` will name `artifacts/api-server/src/routes/highlights.ts` against
   `census-telegraph.md`.** That census's own `head_commit` or
   `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` is the only place it can
   be settled, and both belong to the integration owner. This document's own staleness IS settled
   here: its `head_commit` is re-declared to the commit that carries this section's code, and the
   check then reports it FRESH with 0 counted files changed.
1b. **The acknowledgement entry for THIS census is now spent and must be deleted.** With
   `head_commit` moved to `338837b44`, `check:census-freshness` says so in its own words:
   *"CENSUS_STALENESS_ACKNOWLEDGED for census-highlights-memories.md names since=d3b19fa9, but
   that census now declares head_commit 338837b4. The census was re-measured; the acknowledgement
   is spent. Delete it."* The entry to move to `retired` is the one whose `since` is `d3b19fa9d`.
   The file is the integration owner's, so this is named rather than done — and it is the FIFTH
   consecutive section to hand that same chore on.
2. **`check:citation-targets` now reports 293 against a ceiling of 294** — a ratchet that may
   only fall, and the constant lives in artifacts/api-server/scripts/check-citation-targets.mjs,
   which this lane may not edit. **Lower it to 293 or the gain is not kept.** Six dead pointers
   this pass's line shift exposed were repointed by reading the claim
   (H1's `mapMemory`, §12's soft delete, H198's service client, the four `archived_at` pointers,
   H81/H201's `applyLocationPrecision`), and two that were already dead before this branch were
   repointed with them (H185's `memory_tags`, and §18's raw-`mediaUrl` claim).

Nothing else outside this lane was touched. Every code edit is in
`artifacts/api-server/src/routes/memories.ts`, `.../routes/highlights.ts`,
`.../services/highlights/highlightProjectionPolicy.ts`, and three new test files.

### H.9 Owner decisions this section surfaces

- **D-H-1 (NEW) — should the §10 Highlight clamp bypass for the owner's own Highlights?**
  `protectMemoryRow` bypasses for the owner on the Memory surface; `applyLocationPrecision` does
  not on the Highlight surface, on any of its three call sites. §10 governs *publishing*, and an
  owner reading their own row publishes to nobody, so the Memory reading is probably the right
  one — but changing it WIDENS disclosure on two live feeds, which is not a thing to do on one
  lane's judgement. A test pins the current behaviour so that whoever changes it has to change
  the assertion too.
- **D-H-2 (NEW) — should `PATCH /memories/:id` extend the compare-and-swap to
  `allowed_user_ids`?** See H.6 item 1. It needs an array equality filter rehearsed against a
  real PostgREST, which this branch cannot do.
- **D-C1 (OPEN, inherited) — should a client be REQUIRED to state its base?** **NARROWED, not
  closed, and the narrowing is the useful part.** C.8 posed it as a binary: strict (breaks every
  client) or optional (default stays blind last-write-wins). There is a third option and it is
  what shipped — the server pins the write to the base IT read, so no client changes and only a
  genuinely concurrent write is refused. That option covers the lifecycle field. The original
  question still stands for every other field, because for those the server has no base to pin.
- **D-F4 (OPEN, inherited) — somebody must read `StampAwardEngine`.** Partially begun here and
  handed on rather than claimed: `awardStamp` has **28 call sites across 12 files**, not the
  fifteen §F.9 estimated, and the two in `POST /trips` award `first_trip_created` and
  `trip_planner` **at creation** with `city: destinationCity` attached. `awardStamp` takes no
  `verification_level` — that field belongs to `createStamp`, so §F's layover defect does not
  transfer directly — but `artifacts/api-server/src/services/passport/StampAwardEngine.ts:481#stamp_type`
  falls back to `"city"` for a definition that does not declare one, and whether
  `first_trip_created` declares one is a `stamp_definitions` ROW, not a line of code. **H4 is
  not moved and must not be**: this is two of twenty-eight call sites and one unanswered
  question, which is exactly the partial evidence §F withdrew a green for.
- **D-C2, D6, D-D1, D-D2, D-E1, D-F1, D-F2, D-F3 (OPEN, inherited)** — unchanged, not leant on.

### H.10 The recomputed headline

Restated from `npm run -s check:census-integrity`, not counted by hand.

| figure | section G | **now** |
|---|---:|---:|
| Denominator | 266 | **266** |
| BUILT-AND-CORRECT | 55 | **55** |
| BUILT-BUT-WRONG | 131 | **132** |
| NOT-BUILT | 78 | **77** |
| CANNOT-VERIFY | 2 | **2** |
| CONSTRUCTED% | 69.9 % | **70.3 %** |
| CORRECT%, raw | 20.7 % | **20.7 %** |
| **the gap** | **49.2 points** | **49.6 points** |

**CORRECT did not move and the gap widened again.** That is the second consecutive section for
which the honest answer to "did correctness improve" is no, and the reason is the same both
times: what this branch can reach is not what this document is capped on. What it did reach was
two live disclosures on the surface a stranger lands on, one live route that could undo a
deletion, and a green in its own suite that was passing for the wrong reason. None of those is a
percentage point, and three of them were being served to users.


---

## I. The eighth Memory-creating path, and a lane that built §25 twice — 2026-09-13, the INTEGRATING LANE

*A lane was dispatched against this census and finished with three commits. Its worktree had been
cut from `014a25d5`, **315 commits behind** this branch, so it worked against a 1,185-line copy of
this document that ran to section A. **Its branch was not merged.** Two of the three defects it
found are real, still present here, and are fixed below with its test. The third of its deliverables
is a duplicate of work section B already did, and taking it would have counted one feature twice.*

### I.1 What was NOT taken, and why that is the important half

The lane built `services/memoryCertification/fixtureRegistry.ts` (20 KB) and
`certificationLedger.ts` (4.5 KB) — a §25 certification surface with twelve fixtures, nine
invariants and a blocked-entry registry.

**This census already has one.** Section B built it: `services/memoryCertification/fixtures.ts`
(`artifacts/api-server/src/services/memoryCertification/fixtures.ts:42#export const CERTIFICATION_FIXTURE_IDS`),
plus `invariants.ts`, `chaos.ts`, `world.ts` and `runCertification.ts` — 125 KB across five modules,
each fixture carrying the `census_id` of the row it IS, and §25's thirty requirements already
standing as rows **H224–H253** with 22 BAC, 7 BBW and 1 NB.

The lane's thirty ids — `HF1`–`HF12`, `HI1`–`HI9`, `HX1`–`HX9` — are not thirty new requirements.
They are the same thirty §25 requirements under a second id scheme, built by a worktree that
predated section B and could not see it. **Measured rather than asserted:** merging its census
sections took `check:census-integrity` to *"296 verdict rows parsed but the stated denominator is
266 — more rows than requirements is arithmetically impossible"*, and of the 32 ids its sections
name, 30 were absent from this document and 2 were restatements. Absent from the id list is not
absent from the census: every one of the 30 is covered by an `H224`–`H253` row.

**So the denominator does not move and neither does the row count.** Counting them would have
inflated CORRECT% by thirty rows of work that was already counted, which is the failure this
document exists to catch. The merge was aborted rather than resolved.

**What is genuinely lost by not taking it, stated so it is not forgotten.** The lane's fixtures
execute against the real routes; section B's harness is deterministic and in-memory. That is a real
difference in what a fixture proves, and it is a question worth answering — but answering it means
reconciling two surfaces into one, not carrying both, and it is recorded here as open rather than
done.

### I.2 The two defects, which are real and were still here

Both are the same class this census has now found five times: **supabase-js RESOLVES on a database
error**, so a discarded `.error` makes a failure indistinguishable from an empty result.

**(a) `POST /trips/:tripId/memory` wrote a canonical Memory with no participant.** Two reads bound
neither error. An unreadable `trips` answered `404 "Trip not found"` for a trip that exists — a claim
about the world made out of a failure to look at it. Far worse, an unreadable `trip_members` produced
`members === null`, `crewIds === []`, and **the handler went on to write** a `visibility: 'trip_crew'`
Memory with an empty crew. §22 forbids fabricating participant links; an empty crew the server never
managed to read is exactly that, and it is durable. Both reads are now bound at
`artifacts/api-server/src/routes/memories.ts:2355#if (tripErr) {` and
`artifacts/api-server/src/routes/memories.ts:2374#if (membersErr) {`, each refusing with
`degraded_unavailable` — this codebase's established answer for *"the check could not be
performed"*, as distinct from *"the check was performed and failed"*. **Nothing is written on either
arm**, so a retry yields one Memory and not a second.

**(b) `GET /trips/:tripId/memory` had the same 404-from-a-failure on its own `trips` read**, bound at
`artifacts/api-server/src/routes/memories.ts:2488#"trip-memory: trips read failed — refusing rather than answering not_found");`.

**(c) `DELETE /memories/:id/items/:itemId` discarded a storage failure into a `try/catch` that never
ran.** supabase-storage-js resolves with `{ data: null, error }` rather than throwing, so the catch
was written for an exception that never arrives and `await remove(...)` dropped its error on the
floor. The row was already gone at that point, so the failure left the item unreachable, the bytes
still publicly served, and **nothing anywhere recording that the two had diverged**. Now bound at
`artifacts/api-server/src/routes/memories.ts:1960#failureClass: "storage_object_orphaned" },` with an
error-level line carrying the storage path. The response stays 204 deliberately: the canonical
command DID succeed and re-running it would 404, so turning a storage failure into a client error
would be a lie in the other direction.

### I.3 The §17 boundary, which this route had never crossed

`POST /trips/:tripId/memory` was the one canonical-Memory write in this file that went straight to
`sc.from("memories").insert(...)`: no command id, no audit line, no idempotency key, while the other
six Memory-writing routes all read the envelope. It now dispatches through the same path as
`POST /memories` — kernel when `memory_kernel_enabled` is on, the byte-identical direct write when it
is off, an audit line either way — at
`artifacts/api-server/src/routes/memories.ts:2403#const created = await dispatchMemoryCommand<any>({`,
with `requireIdempotencyKey` read before any database access at
`artifacts/api-server/src/routes/memories.ts:2330#const idempotencyKey = requireIdempotencyKey(req, res);`
so a malformed key is refused without the server having looked at anything.

The crew tagging is guarded by `!created.duplicate` for the reason `POST /memories` already skips it:
a replayed command must not tag the crew a second time.

### I.4 Red before green, and the test asserts on the STORE

`artifacts/api-server/src/test/memoriesTripMemoryDegraded.test.ts:1#/**` was taken from the lane
unchanged and run against this tree **before** any of the above:

| | tests | pass | fail |
|---|---|---|---|
| merged tree, unfixed | 5 | **0** | **5** |
| after (a) + (c) | 5 | 3 | 2 |
| after (b) + §17 | 5 | **5** | 0 |

The outage cases assert that **no row reached `memories`** and that `taggedCount` is not a number
describing rows that do not exist — not merely that the status code was 503. A status-only assertion
passes against a route that fails closed for the wrong reason, which is why this one does not use one.

Regression beside the change, unmodified: **794 of 794** across every `memor*` and `highlight*` suite.
`npx tsc --noEmit` clean; `typecheck:tests` at its exact 864/116 baseline.

### I.5 Row moves — and the honest answer is that none of them is a move

| row | was | now | why |
|---|---|---|---|
| **H264** | `C` | **`C`** | **A THIRD FALSE GREEN, and the verdict does not move because it was already the right letter.** §28.11 forbids swallowing a failure into plausible-looking empty history without a structured error state. Rule 7 of this census grades a prohibition **on the surface where a violation would live** — and two violating paths were live on `routes/memories.ts` the whole time H264 read `C`: the POST answering `not_found` from an unreadable `trips`, and the GET doing the same. Both are closed. The letter is unchanged; what changed is that it is now true of the whole surface rather than of the branch section D happened to read. |
| **H193** | `BRANCH, with an (e) tail` | **unchanged** | §21 asks for deletion to be *"observable, retryable, dead-lettered on repeated downstream failure"*. (c) above delivers **the observable third only**. There is still no retry and no dead-letter store, so the row keeps its classification, and claiming otherwise on the strength of one log line would be the reclassification this document refuses. |
| **H190** | half (e) | **unchanged** | The media bytes still stay publicly served. (c) makes the orphan *findable*; it does not delete it. |
| **H129** | `BAC` | **`BAC`, verified for the first time** | The lane re-read the claim rather than repairing the pointer, which is what §J of the report asked for and what the integrator's note to it asked for. `forgetMemory` deletes from `compass_memories` scoped to `id` **and** `user_id`; the only two `from("memories")` in the Compass surface are `.select(` reads. It closed in the direction the row guessed — and it did not have to. |

**No verdict moves, the denominator is unchanged at 266, and CONSTRUCTED and CORRECT are exactly what
they were.** Three live defects were fixed and one row was verified for the first time. That is a
correctness pass, and a census whose numbers rise every time code is committed is not measuring
anything.

**What would turn this red:** unbind either read in `POST /trips/:tripId/memory` and the degraded
cases go from 5/5 to 3/5 with a `trip_crew` Memory in the store; drop the `!created.duplicate` guard
and a replayed command tags the crew twice; restore the bare `.remove([storagePath])` and the orphan
goes silent again.

**Owed, not done.** `head_commit` still reads `338837b44` and this section changes a file this census
counts. Re-declaring it must name the squash commit, so the declaration is not moved here; the four
files that changed under the current declaration are argued one at a time in
`CENSUS_STALENESS_ACKNOWLEDGED`, and `check:census-freshness` is green at 0 STALE.

---

## J. Five builds on the code-fixable tail, one live attribution hole, and a blocker this census filed in the wrong group — 2026-09-14, the HIGHLIGHTS & MEMORIES lane

*Worktree `/home/user/wt-483`, detached at `7d1f2d498`. Nothing here is merged and nothing here is
deployed; every migration §D.1 group (c) names is still unapplied, re-verified below against
`src/lib/capability/production-applied-migrations.json` rather than taken from the prose.*

Section D.1 grouped the W column by **the first thing standing between a row and CORRECT** and found
that only 24 of 134 rows are reachable by typing: 9 in group (a), 6 in (b), 9 in (e). This section
works that tail and nothing else. It does not touch the 107 rows capped by storage, because touching
them would not move them — which is D.1's whole finding and is still true.

### J.1 The re-execution, before anything was built

Every claim below was re-run against this tree, not inherited (rule §3 of the lane brief).

| claim | re-executed | verdict |
|---|---|---|
| `compass_feed_cache` is never invalidated on a Memory visibility change (H189) | `grep -n "CompassCacheEngine\|invalidate" src/routes/memories.ts` → **nothing**, while `routes/highlights.ts:5` imports it and `:977` calls it | **accurate** |
| the compression hierarchy and Life Chapters are called by nothing (H104, H105) | `grep -rn "buildCompressionHierarchy\|buildLifeChapters" src --include=*.ts` outside the module → only `src/test/memoryProjectionGraph.test.ts` | **accurate** |
| nothing outside `src/test/` and the certification suite imports the projection registry (§18 preamble, H163–H173) | same grep over `getProjectionDefinition` / `PROJECTION_DEFINITIONS` | **accurate at `7d1f2d498`; falsified by J.2** |
| per-Memory deletion has no named step, no report, no retry (H193) | `DELETE /memories/:id` was one `UPDATE` and a 204 | **accurate** |
| `routes/memories.ts` inserts a client-supplied `media_url` straight into `memory_items` (H181) | `addItemSchema.mediaUrl` was `z.string().url()` and nothing else | **accurate, and worse than the row says — see J.4** |
| 2338/2339/2710/2711/2720/2721/2722/2723/2730 are unapplied | not one appears in `production-applied-migrations.json`, whose newest entry is `2741_layover_session_returning_status` | **accurate** (that file is a tripwire, not an inventory — its own `$comment` says so — but a list that reaches 2741 and omits 2710 is evidence) |
| `routes/highlights.ts` still orders by `created_at` and imports neither the ranking nor the lifecycle module (H12, H99–H101) | `grep -n "highlightRanking\|highlightLifecycle" src/routes/highlights.ts` → **nothing**; the three `.order(` calls on the feeds are `created_at` | **accurate** |
| `POST /highlights` still inserts a client-supplied `mediaUrl` with no source Memory (H93) | `routes/highlights.ts:501` | **accurate** |
| `PassportConsumerProjections.ts` projects no Memory and no Highlight (H164) | both greps return **0** | **accurate** |
| `memory_relations` has no migration anywhere in the tree (H45, H62, H106, H124) | its only `.sql` appearance is a comment in `2711_memory_kernel_execute.sql` | **accurate** |

### J.2 What was built, and where

**1. §21 revocation on the Memory surface — the half H189 and H190 were left on.**
`artifacts/api-server/src/services/memory/memoryAudienceRevocation.ts:305#revokeMemoryAudienceCaches`,
wired at `artifacts/api-server/src/routes/memories.ts:1609#revokeMemoryAudienceCaches` (PATCH) and
inside the deletion lifecycle (DELETE).

THIS IS NOT THE ONE-LINE `invalidateCompassCache(sc, user.id, …)` THE HIGHLIGHTS SURFACE USES, and
the reason is the whole design: `invalidate` is keyed by ONE user, and the user whose cache holds a
Memory is almost never the user who narrowed it. Copying the highlights line would evict the owner's
feed — the one reader whose access did not change — and leave the Memory in the cache of everyone
who just lost it. So the targets are RESOLVED: the owner, both sides' allow- and hide-lists, the
accepted crew of the old and the new trip, the owner's circle, the owner's followers, and — when
either side was `public` — the people who liked, saved or were tagged.

Four properties, each because of a specific way this goes wrong:
  - **Any audience-affecting change revokes.** `audienceChanged` does not try to prove a change was
    a *narrowing*: six visibility classes are not a total order (crew and circle are incomparable),
    so any rank ladder is wrong for some pair, and being wrong here leaves a revoked Memory readable
    out of a cache. Over-invalidating costs a cache miss.
  - **`public` is not enumerable, and the report says so.** `unbounded_audience: "public"` rides on
    every report of a narrowed public Memory, and the likes/saves/tags set is labelled a bounded
    PROXY, not a revocation. **H189 keeps its W on exactly that.**
  - **A failed lookup is recorded.** supabase-js RESOLVES on a database error, so `(data ?? [])` on
    an unreadable `trip_members` yields a revocation that silently skips every crew member. Every
    read binds `.error` and a failure appends to `degraded[]`.
  - **THE LATENCY BUDGET IS PART OF THE DESIGN, AND THE FIRST DRAFT OF THIS FILE GOT IT WRONG.**
    `CompassCacheEngine.invalidate` issues THREE queries per user and this runs inside a user-facing
    PATCH. A 500-target sequential loop is 1 500 serial round trips — several seconds on a write the
    user is waiting on, which is a production incident, not a privacy win; an unbounded
    `Promise.all` over the same set opens 500 connections. The cap is **200** and the pool is a
    fixed width of **10**, the report carries `peak_in_flight`, and a test asserts both that the
    pool is wider than one and that it never exceeds the constant. The mutation that makes it
    `Promise.all(queue.length)` turns that test red.

**2. §21's five states, per Memory.**
`artifacts/api-server/src/services/memory/memoryDeletionLifecycle.ts:65#MEMORY_DELETION_STEPS` is
DELETION_REQUESTED → PUBLIC_REVOKED → DERIVATIVES_PURGED → RAW_EVIDENCE_PURGED → DELETED, run by
`:168#runMemoryDeletionLifecycle` from `artifacts/api-server/src/routes/memories.ts:1728#runMemoryDeletionLifecycle`.

**THERE ARE THREE OUTCOMES PER STEP, NOT TWO, AND THAT IS THE POINT.** Two of the five stores do not
exist: `memory_derivative_registry` is 2730 and unapplied, `memory_evidence` has no migration at all.
A step that reported `done` for them would be the decorated green this census exists to catch; a step
that reported `failed` would dead-letter every deletion forever and mean nothing. So a store that is
ABSENT — decided by PostgREST's own 42P01 / 42703 / PGRST205 / PGRST204, never by a heuristic on the
message — is `not_applicable`, attempted exactly once, and does not dead-letter. A store that could
have worked and did not is `failed`, retried to `MAX_STEP_ATTEMPTS`, then dead-lettered.
`DELETED` is a READ, not an announcement: it re-reads the row and refuses to report success while the
state is anything but `deleted`.

**`deadLetterDurable` is a hard `false` on every report.** There is no dead-letter table and this
lane may not add a migration, so a dead letter here is a log line and not a queue. **H193 keeps its W
on that third.**

**3. §13's ladder, reached.** `artifacts/api-server/src/services/memoryProjections/memoryGraph.ts:320#deriveChapterThemes`
plus `artifacts/api-server/src/routes/memories.ts:835#router.get` (`GET /memories/graph`).

`buildLifeChapters` took a `themes` argument and **nothing in this repository produced one**, so the
LIFE_CHAPTER level was structurally empty and the function was unreachable even from its own siblings.
`deriveChapterThemes` derives themes from structure alone — a place or a companion recurring across
**at least two DIFFERENT trips**, because a place visited three times on one trip is that trip, not a
chapter of a life. Labels are composed from ids; no title and no caption is copied, which is the
§28.8 property H105 states and which is asserted here on the serialized HTTP payload.

The route is owner-only and there is no `?userId=`. Time basis is DECLARED rather than assumed:
§3.1's `occurred_at` does not exist on this schema (H17/H22), so a moment is placed by `starts_at`
when the owner gave one and by `created_at` when they did not — a RECORDING time — and the response
carries `momentsOnRecordedTime` so a day bucket built from upload timestamps is never presented as a
day of someone's life. `occurred_timezone` does not exist either, so `timezoneBasis` is `"utc"`.

**4. §18's registry, consumed.** `artifacts/api-server/src/routes/memories.ts:2594#router.get`
(`GET /trips/:tripId/memories/recap`) serves `TripMemoryProjection`.

A NEW route, deliberately: `GET /trips/:tripId/memory` returns a single `{ memory }` that a shipped
client reads, and D.1 (b) recorded that changing a live response shape is not a lane's call to make.
**The projection is not the permission** — the builder filters to the scope owner's undeleted
Memories on the trip and does not run §23's ladder, and it must not be asked to. So the ladder runs
FIRST, per row, through the same `canReadMemory(…, "trip")` the sibling route uses; the builder's
owner filter then runs on top. §10's person ladder narrows `people` before the builder sees a tag,
which is what stops an APPROVED participant the viewer has blocked from being named.

**5. Batched reads that PostgREST can actually answer.** `.in()` goes in the QUERY STRING: the
graph route's companion read would have named up to 2 000 uuids — about 74 KB of URL — and the
request is rejected before it reaches the database, as a TRANSPORT error that `(data ?? [])` then
reads as "this Memory has no tags". Both new routes chunk at 200 and check every chunk's `.error`.
This was a hazard introduced by items 3 and 4 above and found by re-reading them, not by a test
failing; the test came after.

**6. The ownership leg of §20.**
`artifacts/api-server/src/services/memory/memoryMediaOrigin.ts:129#classifyMemoryMediaUrl`, refused at
`artifacts/api-server/src/routes/memories.ts:1777#classifyMemoryMediaUrl`. See J.4.

### J.3 Row moves

*Verdict cells are written as this census writes them — bare `BAC` / `BBW` / `NB` / `CV`, no
backticks — because `check:census-integrity` strips `*` and nothing else, and a backticked verdict
is a row it silently does not read.*

| id | was | now | why |
|---|---|---|---|
| H166 | BBW | **BAC** | `TripMemoryProjection` is consumed by `artifacts/api-server/src/routes/memories.ts:2594#router.get`. §18's blanket reason for the whole block — nothing outside tests imports the registry — is false as of this section, and the preamble is corrected above. **§E.5 declined this row as "risk-blocked", on the ground that it "changes a live response shape" and "nothing in this repository can tell you which clients read those shapes". That objection is answered rather than ignored: no shipped shape changes here.** `GET /trips/:tripId/memory` is byte-identical; the recap is a NEW path, and §H.7 has since measured that the one readable client calls `/api/users/:id/memories` and `/api/users/:id/highlights` and neither of those moves either. **Ceiling, stated rather than implied:** the recap is built per request and NOT registered, because H174's table is 2730 |
| H105 | BBW | **BBW** | **NOT MOVED, and the refusal is inherited rather than re-argued.** The build is real — `deriveChapterThemes` is the theme producer `buildLifeChapters` never had, without which the LIFE_CHAPTER level could only ever be empty — and `GET /memories/graph` reaches it. But §E.5 filed H104/H105 **product-blocked** with the sentence *"Inventing an endpoint to move two rows is scoring"*, and that objection applies to this endpoint exactly as written. The endpoint is offered, the evidence is corrected, and the verdict is left where a previous pass put it. **Owner decision: does the product want a §13 compression surface?** If yes, this row is a re-read away from C; if no, the code should not exist |
| H104 | BBW | **BBW** | Two reasons now, not one. §E.5's product block above, and a rung: `EPISODE` is structurally empty at this tree because no moment carries an `episode_id` (`memory_episodes` is not deployed, H8), and fabricating episodes from proximity inside a route would be the detector §7 already specifies, built in the wrong place. DAY, TRIP and SEASON are real |
| H189 | W | **W** | **HALF CLOSED, and it is the half §D.4 and §E.5 both named.** `compass_feed_cache` IS now invalidated on a Memory visibility change and on a delete, by `artifacts/api-server/src/services/memory/memoryAudienceRevocation.ts:305#revokeMemoryAudienceCaches`. §E.5 said in advance that *"closing the cache half alone does not move the row"*; it does not, and it is not moved. W stands because narrowing a `public` Memory has a losing audience nobody can enumerate, and because the Compass GRAPH derivative is still revoked only on the daily rebuild |
| H190 | W | **W** | Same half closed by the same code, and §21's five states now exist and run. W stands on the sentence unchanged since §D.4: **the media bytes stay publicly served** |
| H193 | W | **W** | **TWO OF THREE.** §21 asks for deletion that is *observable, retryable, and dead-lettered*. Observable and retryable now exist per step, with an attempt count, a `reachedState` and a three-outcome model that tells an absent store from a failed one. Dead-lettering does not: there is no table, `deadLetterDurable` is a hard `false` on every report, and §I.5 already refused to reclassify this row on the strength of a log line |
| H181 | BBW | **BBW** | The ownership leg closed (J.4) and it was a live hole, not a paper one. The STAGED PIPELINE did not: `memory_items` has no `phash`, no thumbnail and no moderation status, and adding one is a migration |
| H2 | BBW | **BBW** | **Evidence falsified.** The row reads *"`routes/stories.ts` 'save to Highlight' … still hard-codes `visibility: "public"`"*. **That is not true at this tree.** `artifacts/api-server/src/routes/stories.ts:890#resolveHighlightVisibilityForStory` refuses every Story whose audience a Highlight cannot carry faithfully, and the comment two lines above names the hard-coded `public` as the defect it replaced. The verdict does not move for §D.1's reason — §1's private-first mandate is about the AUTOMATIC path, and the candidate pipeline that would default does not exist — but a reader checking this row would have found a line that is gone. `routes/stories.ts` is another lane's file; this is a correction, not a change |
| H86 | BBW | **BBW** | **§D.1 filed this row's blocker in the wrong group.** It sits in (c) behind 2720 `highlight_resurfacing_preferences`. **Applying 2720 would not reach it.** `SENSITIVE_CATEGORY_REGISTRY_MAPPING` binds §11's categories to `protected_zones`, whose zones are GEOMETRIC — `lib/protectedLocations.ts` `zoneCovers` takes a lat/lng — and **`highlights` has no coordinate**: `0026_highlights.sql` creates `media_url / caption / visibility / expires_at / deleted_at`, and `grep -in "lat\|lng" src/migrations/*.sql | grep highlights` returns nothing. There is no value on this surface to test against a zone. The row belongs in group (e) — *needs something nobody has written* — and its first blocker is a column |
| H202 | BBW | **BBW** | Opened, and **not** built, because §E.5 already showed why: *"per-surface scoped service roles are `GRANT`s, which is a migration, and the audit trail is a table"*. §D.1 files it (a). §E.5 is right and §D.1 is wrong, and this section agrees with §E.5 rather than spending the tail of the queue on a TypeScript imitation of a `GRANT` |

### J.4 The live defect: a Memory item could claim another user's photograph

`POST /memories/:id/items` typed `mediaUrl` as `z.string().url()` and wrote it straight into
`memory_items.media_url`. No storage-origin check and no ownership check — the same unchecked client
assertion `artifacts/api-server/src/test/storyMediaOwnership.test.ts:1#/**` documents for
`POST /stories`, which that lane closed at both ends.

**MEASURED, NOT ASSUMED, BEFORE CALLING IT A LEAK.** The stories defect composed with a READ:
`lib/mediaAccess.ts` branch 3d resolved story media *by media_url* and answered
`story.visibility === "public"`, so a public story pointing at a victim's key served the victim's
bytes. That composition does **not** exist here: `grep -n "memory_items" src/lib/mediaAccess.ts`
returns nothing, so a Memory's visibility authorises no bytes at all, and
`DELETE /memories/:id/items/:itemId` already refuses to remove an object outside `memories/<owner>/`.
Both the exfiltration and the destructive primitive were already closed.

What was open is **attribution**: a public Memory of the attacker's, with the attacker's caption,
date and place, rendered with another user's photograph, on every surface that shows a Memory cover.

**ONLY THE PROVABLY-FOREIGN CASE IS REFUSED.** A path inside one of our buckets whose owner SEGMENT
is a different user id is refused before the command, so nothing is written and no audit row claims
an attachment that did not happen. An `external` URL is untouched — this route has accepted those
since it was written, and whether Memory media should be restricted to our own storage is a product
decision, not a defect, so it is named here and not taken. An object in our bucket whose owner cannot
be derived from its path is accepted and logged, because refusing on an inability to attribute would
turn a naming convention into an outage.

The match is on a path SEGMENT, never a substring: a victim's id in a FILENAME attributes nothing,
and an attacker's id in a filename does not launder a victim's directory. Both directions are
asserted, and a substring mutation turns that assertion red.

### J.5 Red-first: every mutation, and the one that survived

Fifty-six tests across five new files (13 + 10 + 10 + 11 + 12). Every one was run RED before the
fix and GREEN after, and every implementation was then mutated back to red and restored. The
mutations were applied to the SOURCE, not to the test, and the source was restored from a byte
copy and re-run green each time.

| mutation | what went red |
|---|---|
| `audienceChanged` returns `false` unconditionally | 1 unit + 3 route assertions |
| drop the likes/saves/tags proxy for a `public` audience | 4 (including the DELETE case) |
| `GET /memories/graph` query not scoped to `owner_id` | 3, including "never projects another owner's Memory" |
| swallow an unreadable `memory_tags` on the graph route | 1 — the 503 became a companion-free life |
| `deriveChapterThemes` accepts one trip as a recurrence | 1 — "one trip is a trip, not a chapter" |
| trip recap skips §23's ladder before the builder | 1 — a crew member read the owner's `only_me` Memory |
| trip recap serves the rows instead of the projection | 5, including the field whitelist and the caption |
| swallow an unreadable `memory_items` on the recap | 1 |
| `isStoreAbsent` always false | 2 — an absent store became a retryable failure |
| `DELETED` announced instead of read | 1 — a still-published Memory reported a complete deletion |
| retry cap reduced to one attempt | 2 — nothing dead-letters |
| `deadLetterDurable: true` | 1 |
| media ownership by substring instead of segment | 1 |
| bare storage keys unrecognised | 1 |
| signed URLs unrecognised | 1 |
| the media guard computed and not acted on | 1 — the route-level reachability proof |
| `IN_LIST_CHUNK` raised to 100 000, i.e. unchunked | 1 — a 450-memory graph issued one `.in()` of 450 |
| the eviction pool widened to `queue.length` | 1 — `peak_in_flight` exceeded `REVOCATION_CONCURRENCY` |

**THE ONE THAT SURVIVED, AND THE TEST THAT WAS REPLACED BECAUSE OF IT.** Passing the RAW tag rows to
`TripMemoryProjection` instead of the §10-disclosed ones changed nothing: the assertion in place was
that a PENDING participant is not named, and the builder's own `approvedTagsFor` drops a pending tag
whatever the person ladder decides. It was a test that could not fail for the reason it claimed —
§4 of the lane brief, and the `ownerId` case it cites. It was replaced with an APPROVED participant
whom the viewer has blocked: the builder keeps that tag, §10 rule 1 hides it, and the mutation now
turns red.

### J.6 The ceiling

  - **Nothing here is merged and nothing is deployed.** Two of the five things built report
    `not_applicable` on today's database and will keep doing so until 2730 lands and
    `memory_evidence` is written at all.
  - **`GET /memories/graph` and `GET /trips/:tripId/memories/recap` have no client.** They are
    reachable by an authenticated HTTP request, which is the standard this census applies to every
    other route, and they are reachable by nothing else. The mobile client cannot be measured from
    this tree (`docs/architecture/mobile-reachability-ledger.md` is pinned, per §H.7).
  - **The graph route's EPISODE rung is empty and the recap is unregistered.** Both are stated on
    the responses, not only in this document.
  - **The `public` audience is still not revocable.** A Memory that was public and is now private has
    a losing audience of everyone, and this lane evicts a proxy for it.
  - **`typecheck:tests` was not re-baselined and must not be.** `tsc --noEmit` over this package is
    clean for every file this lane wrote; the one file failing it at the end of this session is
    `src/services/airport/__tests__/layoverEnvelopeConfidence.test.ts`, which belongs to another lane
    sharing this worktree and was not touched here.

### J.7 The recomputed headline

| figure | section H | **now** |
|---|---:|---:|
| Denominator | 266 | **266** |
| BUILT-AND-CORRECT | 55 | **56** |
| BUILT-BUT-WRONG | 132 | **131** |
| NOT-BUILT | 77 | **77** |
| CANNOT-VERIFY | 2 | **2** |
| CONSTRUCTED% | 70.3 % | **70.3 %** |
| CORRECT%, raw | 20.7 % | **21.1 %** |
| **the gap** | **49.6 points** | **49.2 points** |

**ONE ROW. CONSTRUCTED did not move, and it should not have.** Nothing in this section built a new
artifact the spec names; it made two that already existed reachable, closed the half of §21 the
previous two sections had each named in advance, and closed one live hole that was never a spec
requirement at all. **The section that could most easily have scored three more rows declined all
three** — H105 and H104 to §E.5's product block, H202 to §E.5's reading that a scoped service role
is a `GRANT`. §D.1's arithmetic is unchanged and is still the finding: the largest single act
available to anyone on this document is an owner applying eight migrations.

### J.8 Cross-lane requests

  1. **`artifacts/api-server/package.json`** — five new test files must be added to the curated
     `test` script or `check:test-registration` fails them as unregistered:
     `src/services/memory/memoryAudienceRevocation.test.ts`,
     `src/services/memory/memoryDeletionLifecycle.test.ts`,
     `src/services/memory/memoryMediaOrigin.test.ts`,
     `src/services/memoryProjections/memoryGraphRoute.test.ts`,
     `src/services/memoryProjections/tripRecapRoute.test.ts`.
     They are NOT to be allowlisted — the allowlist is for pre-existing carry-overs.
  2. **`artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`** — this section changes
     `routes/memories.ts`, a file this census counts. `check:census-freshness` needs the
     re-declaration §I's closing paragraph already owes.
  3. **`artifacts/api-server/src/routes/stories.ts`** (TELEGRAPH/Stories lane) — H192's
     `trip_story_derivative` destination: `stories.saved_to_highlight_id` still points at a Highlight
     after that Highlight is deleted. The revocation cannot clear it from this lane's files.
  4. **`artifacts/api-server/src/compass/CompassCacheEngine.ts`** (Compass lane) — `invalidate`
     wraps its persisted delete and its audit insert in `try { … } catch {}` and returns `void`, so
     no caller can tell a complete purge from an L1-only one. H192's `cached_narrative` outcome and
     this section's `PUBLIC_REVOKED` step both inherit that limit, and neither can fix it.
  5. **`docs/architecture/census-telegraph.md`** (TELEGRAPH lane) — its lines 1851 and 1889 both
     anchor into `routes/memories.ts` at old line **1951**, the `state = published` filter on
     `GET /users/:userId/memories`. This section moved that line to **2403**. Those two anchors are
     in another lane's census and were deliberately NOT edited here; they rot until their owner
     repoints them. (Written in words rather than in citation syntax so this census does not itself
     carry two citations it knows to be stale.)

---

## K. Five projections reach a caller, three rows the lane graded itself green that I did not, and a World Traveler stamp for trips nobody took — 2026-09-14, the INTEGRATION OWNER

Written after cherry-picking `d6285ccff`, `59c56905c`, `d8cb78a70` and `a7fdd7cbf`. Every OLD
verdict below was read from `CENSUS_INTEGRITY_DUMP=ALL`, never from this document's prose — §J
found H52 stale by a whole section, which is exactly why.

### K.1 Eight moves

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **H163** | **W** | **C** | `MemoryTimelineProjection` consumed by `GET /memories/timeline`. Owner-scoped, §10's person ladder before the builder, the field whitelist asserted on the wire |
| **H165** | **W** | **C** | `ProfileHighlightProjection` consumed by `GET /users/:userId/memories/highlights`. Three gates in order — pair block, §23 ladder per row, builder audience filter — and `protectMemoryRow` coarsens location BEFORE the builder, so it is not the fourth unprotected profile read §H found three of. Nothing shipped changes shape: `GET /users/:userId/memories` is byte-identical |
| **H167** | **W** | **C** | `PlaceMemoryProjection` consumed by `GET /memories/places/:placeId`, matching `place_id` OR `canonical_location_id` so a §9 merge does not lose half a history |
| **H168** | **W** | **C** | `PeopleMemoryProjection` consumed by `GET /memories/people/:personId`. APPROVED tags only at both layers; a block refuses with 404 and fails closed on an unreadable `blocks`; asking about yourself is refused rather than answered with your whole timeline under a shared-history audience |
| **H66** | **W** | **C** | the never-demote rule runs in anger rather than in fixtures: every `memories` row is user-authored, so `USER_INTENT_FLOOR_APPLIED` fires on every live scoring and the route drops no row for scoring low. The mutation that filters below SUGGESTED turns four tests red |
| **H1** | **N** | **W** | five surfaces now interpose a whitelisted projection between the canonical row and the reader. Not `C`: `mapMemory` still serializes canonical rows on `GET /memories`, `/memories/:id` and `/users/:id/memories`, so the row's sentence is still true of the PRIMARY path |
| **H52** | **N** | **W** | **the row was stale by a whole section.** Its evidence reads *"Delete is a single soft-delete write"*; §J built `MEMORY_DELETION_STEPS` — §5's five states in §5's order, on the live `DELETE /memories/:id` — and never came back to H52. `W` not `C`: two of the five stores do not exist, so those steps are `not_applicable`, and `deadLetterDurable` is a hard `false` |
| **H219** | **N** | **W** | `privacy_revocation_latency` is built and emitted by BOTH revocation surfaces, with the privacy-decision instant passed from all three routes. `W` not `C` — see K.2 |

### K.2 Three rows the lane proposed as `C` and did not get, and the one rule behind all three

The lane flagged each of these itself, which is the reason its report was worth trusting on the
other eight. All three are refused on ONE rule, stated once so it stops being re-argued:

> **Declaring an absence honestly is better than defaulting it, and it is still not the capability
> the spec asked for.**

- **H219 → `W`, not `C`.** §24 asks for a metric. `privacy_revocation_latency` is emitted as a
  structured log line and **nothing aggregates it** — there is no metrics backend, so no operator
  can read it, alert on it, or see it move. That is the sample built and the metric not.
- **H63 → stays `W`.** `scoreSignificance` has a live caller over real rows, and **five of §8's
  eleven inputs are derivable on this schema.** The other six are declared absent with reasons
  rather than defaulted to false, which is the honest treatment — and §8's list is a list of
  inputs, so a scorer computing five of eleven has not implemented §8's scoring.
- **H64, H65 → stay `W`**, on the lane's own reasoning, recorded because it is the better half of
  its report: the significance strip now runs on four routes, but **on the one surface that
  publishes a score the reader is always its owner**, so the NON_OWNER branch has still never run
  against a real non-owner. And `media_quality` has no source at all, so its contribution constant
  is exercised by the unit suite only.

This is the same rule census-discovery §17.2 applies to DV-58/59 and census-layover §22.2 applies
to L110/L112. Applying it in one census and not another would make the corpus percentage a
function of which lane wrote the row.

### K.3 What all five `C` projection rows actually rest on, said once

H163, H165, H167, H168 — and **H166, which is already `C` on this basis** — are reachable by an
authenticated HTTP request and **by nothing else. No screen calls them.** The mobile-reachability
ledger is pinned per §H.7 and was not re-derived.

They are graded `C` on §J's H166 precedent, applied consistently. **If the owner's bar is "a screen
reaches it", all five move down together** — not four of them, and not this section's four while
H166 keeps a grade it was given for the same evidence.

### K.4 A live defect on a shipping screen, found and NOT fixed

Reading the `user_stamps` READERS that §F.2 declined to read:

> **A trip you planned and never took is counted on your Passport as a country you have visited.**

The chain, each link read:

1. `routes/trips.ts` `POST /api/trips` awards `first_trip_created` and `trip_planner` at
   **creation**, passing `city: destinationCity, country: destinationCountry`. No occurrence
   evidence of any kind.
2. `services/passport/StampAwardEngine.ts#awardStamp` writes that city/country into `user_stamps`.
3. `services/passport/PassportMapService.ts` `buildStats` does `if (r.country) countries.add(r.country)`
   for **every** non-revoked row. The slug buckets below it feed the plan/host/gem counts and do
   **not** filter the country and city sets.
4. Served by `routes/passportStamps.ts` and `services/passport/PassportProjectionService.ts`.
5. `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx` renders it as
   **"Countries"**, and earns the **"World Traveler — 5 or more countries visited"** watermark from
   the same number.

Plan five trips, take none, become a World Traveler.

**H4 and H239 stay `W`, and they are now `W` with a demonstrated counterexample rather than with an
unread surface.** The fix is not this lane's — `services/passport/**`, `routes/trips.ts` and the
client passport card are all outside it — and the closed reader list is handed over rather than
re-derived: 26 non-test read sites of `user_stamps` across 20 files, of which the load-bearing ones
are `PassportMapService`, `PassportJourneyService`, `SharedContextService`,
`TripPostTripProjections`, `compass/PassportRemembersService`, `compass/CompassGraphEngine`,
`compass/CompassStructuredContext`, `services/telegraph/shareables`, `routes/stampShowcase`,
`routes/postcards`, `routes/wellKnownShare`.

### K.5 A grouping this document had wrong, corrected

§D.1 group (c) files H163, H167, H168 (and H165 by §E.5) as blocked on **2730
`memory_derivative_registry`, UNAPPLIED**. They are not. They are pure projections over tables
production already has; what they needed was a caller, which is typing. §J proved this for H166 and
the grouping was never corrected, so four rows sat in the wrong group and read as migration-blocked
for two sections. H13, H162, H174 and the H110–H114 retrieval rows genuinely are behind 2730 — the
**registration** is the migration, not the projection.

### K.6 Two survivors worth more than the mutations that died

Of 26 mutations, three survived. Two are recorded here because each says something true about where
an invariant actually lives:

- **Filtering the timeline by significance TIER removes nothing**, because every live row is
  user-created and §8's floor means no live row is ever `NO_CANDIDATE`. The filter is vacuous —
  which is the never-demote rule working.
- **Removing §23's ladder from the profile route changes nothing**, and the lane checked why rather
  than assuming: for every visibility class the builder's audience filter is at least as strict, and
  the pair block check is what actually refuses. **The ladder is not what is holding that line**, and
  a reader deciding whether it is safe to touch should know which gate is.

### K.7 Tally

| figure | section J | **now** |
|---|---:|---:|
| Denominator | 266 | **266** |
| BUILT-AND-CORRECT | 56 | **61** |
| BUILT-BUT-WRONG | 131 | **129** |
| NOT-BUILT | 77 | **74** |
| CANNOT-VERIFY | 2 | **2** |
| CONSTRUCTED% | 70.3 % | **71.4 %** |
| CORRECT%, raw | 21.1 % | **22.9 %** |
| **the gap** | **49.2 points** | **48.5 points** |

Five rows to `C`, three from `N` to `W`. CONSTRUCTED moves this time — three things that did not
exist now do — and the gap closes by 0.7 points, which is what one honest section costs.

---

## L. §K.4 overstated the blast radius, and a second live instance of the same defect — 2026-09-14, the INTEGRATION OWNER

Written after cherry-picking `e291dab4e`, `dc4909918` and `6cbff1112`. **No verdict
moves.** The section exists for a correction I owe and two findings the fix turned up.

### L.1 The correction — §K.4's last link was wrong, and I wrote it

§K.4 ends: *"`PassportIdentityCard.tsx` renders it as **"Countries"**, and earns
the **"World Traveler — 5 or more countries visited"** watermark from the same
number. Plan five trips, take none, become a World Traveler."*

**The watermark cannot render.** Measured, not assumed:

- `grep -rn "PassportIdentityCard" travel-buddy-standalone/src` returns the
  component, its own tests, and one stale `jest.mock` for a module the component
  under test does not import. **No production file imports it.**
- the watermark's only input is a `countriesVisited` **prop nothing passes** —
  `grep -rn "countriesVisited=" src` → zero hits — so `(undefined ?? 0) >= 5` is
  permanently false.
- `MyWorldScreen.tsx`'s "Countries" tile is a **different number**, built by
  `buildMapPayload` over the legacy `passport_stamps` table, which carries its own
  `verification_level` and is not affected.

**What IS real and reachable** is the server's own answer: `GET /me/passport/stats`
returns the inflated `countries`, and `SharedContextService#loadStampCities` — a
function whose own comment reads *"places both have been"* — told two strangers who
had each **planned** Lisbon and taken neither that they shared a city.

So the defect is a false statement the server sends, not a badge a user can earn.
That is a smaller claim than §K.4 made, and §K.4 made it because I wrote the chain
down without reading the last link. **A five-link chain is only as verified as its
weakest link, and I verified four.**

### L.2 A SECOND live instance, found by classifying the whole vocabulary

`routes/hiddenGems.ts` awards **`hidden_gem_explorer`** to a gem's **submitter**
when an **admin approves the submission**, passing the gem's city and country.
Approval verifies the gem. It does not verify that the submitter was ever there.

A third instance is latent rather than live: `lib/stamps/criteria/metrics.ts`
computes `countries_visited` as `distinctStampField(sc, u, "country")` over the
same unfiltered rows — so planning five trips also pushes a user past the
`globe_trotter_5` threshold (*"Visit 5 different countries"*), and **the criteria
engine mints the Globe Trotter stamp from planning.** It is gated by
`stamp_criteria_engine_enabled`, seeded FALSE at `0179_stamp_criteria_engine.sql`,
and production's value was not read.

And `compass/CompassGraphEngine.ts` writes `person —visited→ city` edges for every
non-revoked stamp row carrying a city — literally the word *visited*, from a
planned trip.

### L.3 Sixty-three slugs, classified — and why it needed a new column

Thirteen slugs evidence presence: nine from `awardTripCompletionStamps` (the trip
reached `status='completed'`) and four from the GPS-verified postcard path. Fifty
do not, in four distinct shapes: awarded at **creation** (the defect), **location
attached but the gate is not presence** (`hidden_gem_explorer`, `first_postcard`),
**no place written so inert either way** (nine), and **seeded but awarded by no
writer in this tree** (thirty-seven).

**No existing column could draw the line.** `trip_planner` is category `community`
and `first_trip_created` is `trip` — and so is `first_trip_completed`.
`criteria_type` is `automatic` for both. The planned/occurred distinction cuts
straight through every column `stamp_definitions` already has, which is why 2970
adds one rather than reusing one.

The rule used, stated so it can be argued with: a slug is presence only when an
**actual award site can be named**, **its gate is evidence of having been there**,
and **it attaches the city the claim is made from**. Description text is not
enough — `first_trip` reads *"Complete your first trip"* and nothing awards it;
marking it true plants a trap for whoever writes its first writer.

**The weakest admitted link, named:** trip completion is the owner PATCHing
`status='completed'` — self-attested, not GPS. Admitted because it is the system's
own record that the journey *occurred*, which is exactly what "created" is not.
If the owner wants Countries to be GPS-only, nine of the thirteen are wrong.

### L.4 H4 and H239 stay `W`, against the lane's own proposal

The lane proposed both `W → C` and capped both itself. Taking the caps:

- **Migration 2970 has been applied nowhere** — not production, not `portava-ci`.
  Every precondition, postcondition and `RAISE NOTICE` in it is **unexecuted**. The
  column the readers now select does not exist in any database, so against a real
  one every stamp reads `undefined`.
- **The fixes are at the READER, not the WRITER.** `routes/hiddenGems.ts` still
  attaches a city to a stamp its gate cannot vouch for, and `criteria/metrics.ts`
  still makes the same claim on a flag-off path. H4 is a **prohibition**; a
  prohibition whose violation is filtered out downstream is not satisfied.

This is the rule census-discovery §17.2, census-layover §22.2, §K.2 and
census-input-intelligence §12.2 all apply. **What would move them:** 2970 applied,
and the two writers stopping rather than the readers filtering.

### L.5 Two survivors, and the one that should worry a reader most

- **B2** — swapping `trip_planner` INTO the presence list while swapping a genuine
  slug OUT keeps the count at 13 and satisfied every check. The migration's own SQL
  postcondition refuses it — **and that postcondition runs only when the migration
  is applied, which is nowhere.** A count is not an identity assertion.
- **C** — `/DEFAULT\s+false/i.test(sql)` over the whole file passed **with the DDL
  set to `DEFAULT true`**, because the header prose and the `COMMENT ON COLUMN`
  both contain the words. The assertion was matching its own documentation. Without
  the mutation the migration could have shipped defaulting `true` — the exact
  opposite of the fail-safe direction its header spends three paragraphs defending.
- **G, and the gate that did NOT catch it.** Removing `evidences_presence` from
  `buildStats`'s select was killed by **one** test — the one asserting the select
  string. All six behavioural tests passed, because the embedded
  `stamp_definitions(...)` makes the fixture helper return the whole row. Against a
  real database an unselected column reads `undefined`, every stamp reads
  non-presence, and **Countries silently becomes 0 for everyone.** A typo mutation
  (`evidences_presenc`) **survived `check:schema-references` unchanged** — that
  checker does not parse columns inside embedded resources, so its passing is not
  evidence that an embedded column reference is valid.

### L.6 A green citation gate is not evidence

`check:doc-citations` reported `RESULT clean` while **eight bare `path:N-M` spans
were already stale**. Its own output says so: 6,430 citations are UNANCHORED and
*"nothing here can tell you it is wrong"*. `check:citation-targets` judges
unanchored **single-line** spans only, so a range is covered by neither. The
checker found 3 of the 11 repoints this lane made; a person reading the claim found
the other 8.

### L.7 Tally — unchanged

| figure | section K | **now** |
|---|---:|---:|
| Denominator | 266 | **266** |
| BUILT-AND-CORRECT | 61 | **61** |
| BUILT-BUT-WRONG | 129 | **129** |
| NOT-BUILT | 74 | **74** |
| CANNOT-VERIFY | 2 | **2** |

Nothing moved. A false statement the server sends is now filtered at both readers
that make it, one more live instance and one latent instance are named with their
chains, and §K.4's overstatement is corrected in the document that made it.
