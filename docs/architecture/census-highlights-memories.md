# Census — Highlights / Memories Development Architecture Spec v1

**Spec under census:** `docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt`
(byte-compared against the `.docx`: the `.txt` is a faithful extraction — the only diff is a
leading blank line and a trailing newline, so the two agree and either may be read.)

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
| 9 | `memory_event_outbox` | **No** | Zero occurrences. The only outbox in the repo is the trip-reminder two-phase outbox (`lib/tripReminderScheduler.ts:9`). |
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
    (`routes/memories.ts:449-465`), a real tag-consent model that refuses co-ownership
    (`routes/memories.ts:838-880`), a media-delete path that removes the storage object while the
    Memory survives (`routes/memories.ts:758-786`), a genuine private-by-default suggestion
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
| H1 | Canonical Memory facts independent of viewer layout and AI narrative | NB | `memories` rows are read and serialized straight to the client (`routes/memories.ts:1254`); there is no fact layer beneath a projection | |
| H2 | Automatic Memories private-first; publishing always a separate projection decision | BBW | `routes/stories.ts:585-620` — "save to Highlight" hard-codes `visibility: "public"` regardless of the source Story's audience (close-friends, allow-lists). Publishing is not a decision; it is a side effect | pre |
| H3 | AI may summarize supported evidence but may not manufacture historical facts | NB | No AI path over Memories exists; no guard exists either | |
| H4 | Planned/saved/nearby never represented as "experienced" without occurrence evidence or user confirmation | **BAC** | `routes/geofence.ts:634-676` (a stamp requires an actual check-in, then only a *suggested* memory) and `routes/location.ts:334-374` (GPS city stamp → *suggested* memory). Suggestions are inert until explicit acceptance (`services/passport/PassportMemoryService.ts:150`). Matches §6's "GPS proximity: weak alone; typically candidate-level only" | pre |
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
| H79 | Public search queries only public derivatives, never private canonical storage plus post-query filtering | BBW | `routes/memories.ts:423-465` — the discovery feed reads canonical `memories` through the **service client** (RLS bypassed), applies `.limit()` **before** block filtering, then post-filters blocks in TypeScript. This is precisely the pattern §10 and §28.6 forbid | pre |
| H80 | Media visibility independent from Memory visibility | NB | `memory_items` has no visibility of its own; it inherits the memory's | |
| H81 | Publishing location must never exceed the owner's selected precision | NB | There is no owner-selected precision on a Memory; the only clamp is the gem ceiling | |
| H82 | Temporary operational location must not leak into durable public Highlights | NB | `routes/highlights.ts:141-148` persists `location_name`/`city`/`country` verbatim with no precision control and no TTL distinct from the media's | |
| H83 | Being tagged or referenced does not make another user a co-owner | **BAC** | `routes/memories.ts:838-880` — a tagged user may only approve/remove **their own** tag (`userId !== user.id → 403`); no edit, no visibility, no delete rights accrue. Owner-only checks at `:606-608`, `:665-670` | pre |
| H84 | Blocking and account deletion suppress future social resurfacing and unlink identity | **BAC** | Memories feed fails **closed** on a block-lookup error rather than serving an unfiltered feed (`routes/memories.ts:449-465`); highlights filter both directions (`routes/highlights.ts:872-880`, `:38-49`); deletion reaches `memories`/`memory_likes`/`memory_saves` (`lib/deletionDispositions.ts:152`), the derived family (`:192`) and every highlight table (`:352`), executed at `services/accountDeletion/AccountDeletionService.ts:964-975` | pre |
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
| H115–H122 | `getMemory`, `searchMemories`, `getSharedMemories`, `getPlaceHistory`, `getTripMemories`, `getMemoryEvidence`, `createMemoryDraft`, `suggestMemoryCorrection` | NB ×8 | `compass/CompassTools.ts:62-210` defines 11 tools: `get_user_profile`, `get_current_trip`, `search_places`, `search_events`, `get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`, `get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`. **None** is memory-facing | |
| H123–H128 | LLM boundary: may summarize supported evidence · may propose merge/split/correction · may ask a minimal clarifying question · may not invent states/participants/identity/attendance/outcomes · may not bypass privacy policy · may not use stale history as current truth | NB ×6 | No memory-facing LLM path exists to constrain; no boundary is encoded. (`2221_compass_ai_writing_default_off.sql` is the adjacent posture, for Compass prose generally) | |
| H129 | Compass must not mutate canonical Memory facts through prose | **BAC** | The tool set at `compass/CompassTools.ts:62` contains no Memory mutation; the only write-shaped tool is `add_to_trip` (`:158`). `routes/compass.ts:2150` `forgetMemory` writes `compass_memories` (a chat store), not `memories` | — |

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
| TripMemoryProjection | BBW | `routes/memories.ts:1093` returns a raw list for a trip | pre |
| PlaceMemoryProjection | NB | | |
| PeopleMemoryProjection | NB | | |
| CompassMemoryProjection | BBW | `compass/ProjectedMemoryPrompt.ts:110-125` feeds Compass from `memory_rediscover`/`memory_retrieve` — derived preferences, not Memory facts | pre |
| PublicMemoryProjection | BBW | `routes/memories.ts:423` is a canonical read, not a derivative (see H79) | pre |
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
| H178 | Concurrent edits resolve at command/field level, not blind row last-write-wins | NB | `routes/memories.ts:609-640` builds a partial patch but applies it unconditionally; no version, no `If-Match`, no conflict detection | |
| H179 | Late evidence may raise confidence but must not overwrite explicit edits | NB | No evidence and no confidence exist | |
| H180 | Cross-device uploads/notes converge on one Memory/Episode | NB | | |

### §20 Media pipeline (5)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H181 | Staged pipeline: ingest metadata → fingerprint → cheap association → thumbnail → expensive analysis | BBW | A staged pipeline exists for `post_media` (`2046_phash_dedup.sql`, moderation/processing status guarded at `2158_post_media_write_boundary.sql:41`). **Memory media bypasses all of it**: `routes/memories.ts:708-716` inserts a client-supplied `media_url` straight into `memory_items` with no `media_assets` row, no fingerprint, no moderation state | pre |
| H182 | Distinct original / viewer / card / tiny signed renditions | NB | `lib/mediaAssets.ts:151` carries `thumbnail_path`/`thumbnail_url` only — two tiers, not four | |
| H183 | Perceptual fingerprints detect duplicate imports without filename dependence | BBW | `2046_phash_dedup.sql` implements pHash — for `post_media`. `memory_items` has no `phash` column and never enters that path | pre |
| H184 | Video scenes as logical segments without duplicating originals | NB | `highlights.video_duration_seconds` is a length cap (`routes/highlights.ts:128-138`), not segmentation | |
| H185 | Face recognition must not be a dependency for People Memories | **BAC** | People on a Memory are `memory_tags` — an explicit social-graph primitive with consent (`routes/memories.ts:392-402`, `:838`). No face-recognition code exists in the repo | — |

### §21 Deletion, forgetting and revocation (8)

| id | Requirement | Bucket | Evidence / divergence | Attr |
|---|---|---|---|---|
| H186 | Archive: retain canonical, remove from normal browsing | **BAC** | `0067_memories.sql:22` permits `archived`; PATCH accepts it (`routes/memories.ts:244`); the feed filters `state='published'` (`:427`) so archived drops out of browsing while single-fetch by the owner still returns it (`:520` filters only `state != 'deleted'`) | pre |
| H187 | Do not resurface (retain + search privately, suppress proactive resurfacing) | NB | No such control on a Memory | |
| H188 | Do not personalize (retain, exclude from inference) | NB | | |
| H189 | Make private: revoke public derivatives and public indexing, retain the Memory | BBW | PATCH visibility works (`routes/memories.ts:613`) but revokes nothing — there are no derivatives or indexes to revoke, and no cache invalidation on the memories path (contrast `routes/highlights.ts:5`, which does invalidate the Compass cache) | pre |
| H190 | Delete Memory: revoke derivatives, remove indexes/embeddings, purge canonical/eligible evidence | BBW | `routes/memories.ts:672` writes `state:"deleted"` and stops. The media bytes stay publicly served — documented in the repo's own words at `services/accountDeletion/AccountDeletionService.ts:565-570` | pre |
| H191 | Delete media asset: remove asset and derivatives; the Memory survives | **BAC** | `routes/memories.ts:758-786` deletes the row first, then removes the storage object, and refuses any path outside the owner's `memories/{userId}/` prefix. The Memory is untouched | pre |
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
| H206 | `canEditMemory(userId, memoryId)` | **BAC** | `routes/memories.ts:606-608` — owner-only, checked against a fresh read, before any patch is composed | pre |
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
| §28.11 | Never swallow projection/schema failures into plausible-looking empty history without structured error state | **BAC** | `routes/memories.ts:449-465` — a block-lookup error returns `db_error`, explicitly rejecting `data ?? []` because that "yields an empty set → nothing filtered → blocked content leaks". `loadMemoryGemContext` (`:66-78`) records `determined:false` and coarsens rather than silently passing | pre |
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
  `routes/geofence.ts:658`, `routes/location.ts:357`) all gate live behaviour. Every verdict above
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
2. **The discovery feed is the exact anti-pattern §10 and §28.6 name.** `routes/memories.ts:423-465`
   reads canonical storage through a service client, limits before filtering, and post-filters in
   TypeScript. It is also a correctness bug independent of the spec: the `.limit(n)` runs before the
   block filter, so a page shrinks by however many blocked owners it contained.
3. **`save to Highlight` silently escalates audience to public** (`routes/stories.ts:609`). That
   violates §1 ("publishing is always a separate projection decision") and §10 ("publishing must
   never exceed the owner's selected precision") in a single insert.
4. **Memory media bypasses the media pipeline entirely.** `memory_items` takes a client-supplied
   URL with no `media_assets` row, no pHash, no moderation state (`routes/memories.ts:708-716`),
   while `post_media` has all three. §20 assumes one pipeline.
