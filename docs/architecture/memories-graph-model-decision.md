# Memories graph-model migration: decision and plan

Date: 2026-10-10. Branch `claude/memories-graph-model-20261010`. Lane H's migration band, numbers 3674 to 3676.
Spec: `docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt` §3.4, §3.6, §4, §5, §17, §22, §24, §25.
Census: `docs/architecture/census-highlights-memories.md`. The rows in scope are H20, H26, H27, H39, H134, H135, H150, H151, H194, H195, H196, H213 and H214. H35, H71 and H72 were read and are not built (see §9).

Nothing here is applied to any database by this branch. CI applies the migrations after the lead merges. Production is the owner's press. Every flag is seeded OFF. **Cutover is the owner's call**, made after the shadow comparison has produced data in a real environment (§7).

## 1. Current state, measured on `origin/main` 7a4aa2571

| What | Where | What it means for this work |
| --- | --- | --- |
| A Memory's links are scalar columns: `trip_id`, `event_id`, `place_id`, `canonical_location_id` | `artifacts/api-server/baseline/20260819_baseline_structure.sql:7383` | One trip, one event, one place per Memory. There is no row to hang a second link, a confidence or a provenance on. |
| People are `memory_tags` rows with a consent status (`pending` / `approved` / `removed`) | `artifacts/api-server/baseline/20260819_baseline_structure.sql:7450` | The status is the participant's consent. Only `approved` is a link the person agreed to. |
| `memory_relations` already exists as a design. It is polymorphic: MEMORY or EPISODE source; PERSON / PLACE / TRIP / EVENT / STAMP / MEMORY / WORLD_CONTEXT_SNAPSHOT / EPISODE target; §4's nine relation types plus `POSSIBLE_DUPLICATE`; a unique edge key; an owner-matches-source trigger; RLS owner-select | `artifacts/api-server/src/migrations/2994_memory_relations_and_outbox_consumer.sql:179` | Applied on portava-ci, NOT on production (`artifacts/api-server/src/scripts/checkProductionDrift.ts:228`). It has no writer anywhere. |
| `memory_relations` has no stated deletion fate | `artifacts/api-server/src/lib/deletionDispositions.ts` (absent from every bucket) | Its `owner_id` cascades from `profiles`, and account deletion keeps a profiles tombstone, so that cascade never fires. Its `source_id` / `target_id` are not foreign keys. A row would survive account deletion. |
| The command bus refused to declare MERGE_MEMORY / SPLIT_MEMORY | `MEMORY_COMMAND_TYPES_NOT_DECLARED` at `artifacts/api-server/src/lib/memoryCommandBus.ts:405` (line 381 on 7a4aa2571; both entries are removed by this work) | The reasons it gave (no relation store, nothing to split between) are what this work removes. |
| The event vocabulary already names `memory.merged` / `memory.split`, and the outbox consumer already maps both to every surface | `artifacts/api-server/src/lib/memoryOutbox.ts:118`, `artifacts/api-server/src/services/memoryProjections/outboxConsumer.ts:134` | An emitter is all that is missing. |
| 31 readers filter Memories with `.neq("state", "deleted")` | `routes/memories.ts`, `routes/collections.ts`, `compass/MemoryCompassTools.ts`, `services/memory/*` | **A new stored state (for example `merged`) would show up in all 31 of them.** This is the fact the design is built around. |
| The owner's graph is derived per request from the scalar columns and approved tags | `artifacts/api-server/src/routes/memories.ts:1118` (GET `/memories/graph`) | This is the one reader the shadow comparison and the cutover switch apply to first. |
| §21's per-Memory deletion lifecycle, with derivative rebuild (H-5), evidence purge, corrections purge (H-13) and durable dead letters (3670) | `artifacts/api-server/src/services/memory/memoryDeletionLifecycle.ts:173` | A merged-away Memory must leave every derivative exactly the way a deleted one does. It is reused, not copied. |
| The candidate split and merge rates were refused by name | `MEMORY_METRICS_NOT_MEASURABLE` at `artifacts/api-server/src/services/memory/memoryKernelMetrics.ts:81` (line 79 on 7a4aa2571; both entries are removed by this work) | They become computable once the two commands exist. |

## 2. Options considered

**A. Two new tables, `memory_entity_links` and a fresh `memory_relations`, as §3.6 lists them.** Rejected. 2994 already defines `memory_relations` with entity targets (§3.4's own `MemoryRelation` has PERSON / PLACE / TRIP / EVENT targets). A second table for the same edges forks the schema, which is the failure `lib/memoryTableOwnership.ts` exists to prevent.

**B. Reuse 2994's `memory_relations` for both Memory-to-Memory and Memory-to-entity edges. Expose §3.6's `memory_entity_links` as a `security_invoker` view over its entity rows.** CHOSEN. One store, one owner check, one deletion fate. Both names in §3.6 resolve to something real.

**C. Merge by adding a `merged` value to `memories.state`.** Rejected. All 31 `.neq("state","deleted")` readers would show a merged-away Memory next to the Memory it was merged into. That is a duplicate in every feed and a privacy surprise. Every reader would have to change first.

**D. Merge by moving the absorbed Memory's content into the survivor, then soft-deleting the absorbed row and recording a redirect.** CHOSEN. Every existing reader already treats the absorbed row as gone. No reader changes for correctness. The redirect keeps the old ID and URL resolving.

**E. Backfill inside the schema migration, or in a scheduler.** A separate data migration (3675) was chosen. It calls a re-runnable, idempotent SQL function. The function stays installed for re-runs, and the postcondition recomputes completeness from the data. A scheduler would add a 62nd boot job and pinned coverage counts, and it would buy nothing: the mirror triggers (§4.3) keep the graph current after the one-time backfill.

## 3. The chosen design (smallest safe)

### 3.1 Data model

| Object | Migration | Shape |
| --- | --- | --- |
| `memories.source_mode` | 3674 | `text NOT NULL`, CHECK in §4's `MemorySourceMode` (`AUTO_PRIVATE`, `SUGGESTED`, `USER_CREATED`, `SHARED_CONFIRMED`, `IMPORTED`, `LEGACY_IMPORTED`). It is added with the constant default `LEGACY_IMPORTED`, which PostgreSQL stores as the column's missing value: no row is rewritten, no row trigger fires, `updated_at` moves on no row, and every pre-existing row reads `LEGACY_IMPORTED`. The default is then changed to `USER_CREATED`, so a row inserted afterwards by any of today's writers reads `USER_CREATED`. Every writer today is an explicit user action: POST `/memories`, POST `/trips/:tripId/memory`, POST `/memories/from-layover/:sessionId` and the kernel's CREATE_MEMORY. |
| `memory_relations.source_mode` | 3674 | Nullable, same CHECK. It records how the EDGE came to exist. `LEGACY_IMPORTED` means it was mirrored from the legacy scalar or tag model. `USER_CREATED` means an explicit owner command (the split lineage edge). NULL means a pre-3674 row, unknown. |
| `memory_entity_links` (view) | 3674 | `WITH (security_invoker = true)`. It is the MEMORY-sourced rows of `memory_relations` whose target is PERSON, PLACE, TRIP or EVENT. Client roles are revoked. |
| `memory_id_redirects` | 3674 | `old_memory_id` PK FK → memories ON DELETE CASCADE; `new_memory_id` FK → memories ON DELETE CASCADE; `owner_id` FK → auth.users ON DELETE CASCADE; `reason` CHECK (`merged`); `command_id`; `created_at`. RLS on, every client role revoked, service_role only. |
| `memory_graph_shadow_daily` | 3674 | `(day, surface)` PK; counts only: `compared`, `mismatched`, per-field mismatch counts, `graph_read_failures`. **No user column, no Memory id, no content.** Written by `memory_graph_shadow_record(...)` (an atomic increment). service_role only. |
| Flags | 3674 | `memory_merge_split_enabled`, `memory_graph_shadow_read_enabled`, `memory_graph_read_cutover_enabled`. All three are seeded FALSE. |

Legacy edges use the relation type `RELATED`, the weakest of §4's nine. Their confidence is **0.500**, a fixed conservative value below any "very high confidence" (§8 AUTO_PRIVATE) a future detector would need to act on. `detector_version` is `legacy-mirror@1`, and `reason_code` names the source column (`LEGACY_TRIP_ID`, `LEGACY_EVENT_ID`, `LEGACY_PLACE`, `LEGACY_APPROVED_TAG`). These details matter:

- The PLACE edge's `target_id` is `coalesce(canonical_location_id::text, place_id)`. That is the identity rule GET `/memories/graph` already uses, so the two paths are comparable.
- Corrections (3673) are NOT folded into the edge. Readers apply them on top for both paths, through `placesThroughCorrections` (H-16 / H-17).
- PERSON edges are mirrored from `approved` tags ONLY. A `pending` or `removed` tag is not a consented link and is never imported. §22: "never fabricate ... participant links".
- Memories in `deleted` or `removed` state carry no legacy edges.

### 3.2 Merge (`MERGE_MEMORY`)

`POST /memories/merge { survivorId, absorbedIds[] }`. It runs behind `memory_merge_split_enabled`, through the command bus with an `Idempotency-Key`, and executes in `public.memory_graph_kernel_execute` (3676).

The kernel function is one transaction. It writes the canonical change, the `memory.merged` event, the outbox row, the receipt and the audit row together, the 2711 shape.

Refusals, all fail-closed (the canonical change is never partial):
- `MEMORY_NOT_FOUND`: any Memory absent or deleted.
- `MEMORY_AUTH_NOT_OWNER`: any Memory not the actor's.
- `MEMORY_MERGE_INVALID`: the survivor appears among the absorbed, there are duplicates, there is no absorbed id, or there are more than 20.
- `MEMORY_LIFECYCLE_TERMINAL`: any Memory `removed`.
- **`MEMORY_MERGE_AUDIENCE_MISMATCH`**, the privacy rule. Every Memory must have the same `state`, `visibility`, allow-list and hide-list (compared as sets). If the visibility is `trip_crew`, `trip_id` must also match, because the crew IS the audience. The content of a narrower Memory therefore never reaches a wider audience through a merge. A draft is never published by being merged into a published Memory. The owner widens or narrows first, with PATCH, which stays the one place visibility changes (H-7).

What moves, under `FOR UPDATE` locks on every row, in id order (no deadlock between two concurrent merges of overlapping sets):
- `memory_items`: appended after the survivor's last position. Each keeps its 3672 `visibility`.
- `memory_tags`: the survivor's existing row wins on a conflict. A person's own status is never upgraded.
- `memory_likes` and `memory_saves`: deduplicated. A viewer's save keeps working.
- `memory_resurfacing_preferences` (3671): copied. The UNION of controls, so every control the owner set on any part still holds on the whole.
- `memory_evidence` link rows (2320, when deployed): repointed, so the candidate episode stays linked to the Memory that now holds its photos.
- Earlier redirects into an absorbed Memory are repointed to the survivor. Every redirect is one hop.

Then the absorbed rows go to `state='deleted'`, a redirect row is written for each, and the event payload carries ids only. After the command returns, the route runs §21's deletion lifecycle for each absorbed Memory. Its derivatives are rebuilt without it (H-5), Compass caches that held it are evicted, its remaining place corrections are purged (H-13), and a failure dead-letters (3670). The survivor's own projections are rebuilt by the outbox consumer from `memory.merged`.

### 3.3 Split (`SPLIT_MEMORY`)

`POST /memories/:id/split { itemIds[] }`, same flag, same kernel. The listed items move to a NEW Memory, and these properties hold:
- **The same audience.** The new Memory copies `state`, `visibility`, the allow and hide lists and `trip_id`, so a split never widens anything.
- **The same place, time and owner.** It also gets `source_mode = USER_CREATED`.
- **The owner's negative constraints carry over.** The source's place corrections (3673) are copied append-only, so a place the owner rejected is not re-matched for the new Memory.
- **The source's resurfacing controls are copied.**
- **No people.** Tags are NOT copied: a split never names a person on a Memory they were not tagged on. The owner may re-tag.

Refusals:
- an item that is not the source's;
- every item selected, which would leave an empty source; the owner should delete instead;
- no items.

A `DERIVED_FROM` edge (new → source, `source_mode = USER_CREATED`) records the lineage. The event is `memory.split` on the source; its payload carries both ids and the moved item ids. The route then rebuilds the source's derivatives through the narrowing reprojection (reason `memory_split`).

### 3.4 Stable IDs and URLs

- The survivor of a merge and the source of a split keep their ids. No id is ever reused.
- GET `/memories/:id` on a merged-away id resolves the redirect and serves the survivor through the full read ladder: blocks, `canReadMemory`, item visibility and place corrections. The response carries `redirectedFrom`. A viewer who may not read the survivor gets the same 404 as any unknown id, so a redirect is never an existence oracle. A redirect read that fails is that same 404, logged.
- **Redirect resolution is not behind the merge flag.** Turning merges off must not break a URL a merge already moved.
- Writes on a merged-away id are 404, as on any deleted Memory. A client follows `redirectedFrom` / `id` to the canonical id.

### 3.5 Privacy model

1. **Relations never grant access.** Every reader of a Memory still runs `canReadMemory` + `isBlocked` + item visibility + `placesThroughCorrections`. The graph is owner-scoped: RLS is owner-select on `memory_relations`, and the view is `security_invoker`. Neither the shadow path nor the cutover path widens the response of GET `/memories/graph`, which is owner-only and reads only the caller's own Memories.
2. **A relation never outlives what it describes.** 3674 adds deletion triggers:
   - A Memory hard-deleted (account deletion sweeps every Memory) takes every relation it sources or targets.
   - A tag deleted (account deletion clears tags by `tagged_user_id`), or moved out of `approved`, takes its PERSON edge in the same statement. **This path is not error-swallowing**: if the edge cannot be removed, the tag write fails, which is fail-closed for consent.
   - A soft-deleted Memory loses its legacy edges.
   - An episode delete (2320, when deployed) takes its EPISODE relations.
   - `memory_relations` and `memory_id_redirects` are added to `ERASED_BY_CASCADE` in `deletionDispositions.ts` with that mechanism stated.
3. **No content in any new store or log.** Event payloads, redirects, shadow counts and log lines carry ids, counts and reason codes only (§24).
4. **Failed reads fail closed.**
   - A failed graph read in shadow mode is counted as a read failure, and the legacy answer is served.
   - In cutover mode, a failed graph read or an unreadable gate serves the legacy answer, never an empty graph.
   - A failed redirect read is a 404.
   - No failed read is ever followed by a write.

### 3.6 Mirror (dual-write)

The legacy writers are unchanged. After 3674, AFTER triggers on `memories` and `memory_tags` keep the legacy edges equal to the scalar and tag model.

The INSERT half of the mirror is wrapped so that it can never fail a legacy write. On an error it raises a WARNING and skips, and the shadow comparison then measures the drift. The DELETE half is not wrapped (§3.5.2).

This is what makes "comparison clean" achievable and meaningful. The comparison checks that the graph equals the legacy answer on the live read path, not that a backfill once ran.

## 4. Migrations, each with its rollback

| # | What | Rollback (db/rollback/) | Rollback refuses when |
| --- | --- | --- | --- |
| 3674 | schema, view, redirects, shadow table and record function, mirror and erasure triggers, flags OFF | `2026-10-10-3674-memory-graph-model-rollback.sql` drops the triggers, functions, view, the two tables, both `source_mode` columns and the three flags | any redirect row exists (a merged URL would break), or any `USER_CREATED` relation exists (split lineage would be lost) |
| 3675 | backfill legacy edges as `LEGACY_IMPORTED` through `memory_graph_mirror_memory()`, all Memories, keyset batches | `2026-10-10-3675-memory-graph-backfill-rollback.sql` deletes `source_mode='LEGACY_IMPORTED'` edges. They are derived and re-derivable, so nothing is lost | never |
| 3676 | `memory_graph_kernel_execute` (MERGE_MEMORY, SPLIT_MEMORY) | `2026-10-10-3676-memory-graph-kernel-rollback.sql` drops the function | never (it holds no data; merges already made keep their redirects) |

Every `$pre$` and postcondition recomputes from the catalog and the data. None reads session state or a temp table (COMMON 2026-10-08 07:55Z). Every new table gets `REVOKE ALL ... FROM PUBLIC, anon, authenticated` in the same file (rule 4).

## 5. Rollout phases and flags

| Phase | Action | Flag | Who |
| --- | --- | --- | --- |
| 0 | Apply 2993 → 2994 → 3674 → 3675 → 3676 | none (schema only; triggers start mirroring) | CI after merge; production is the owner's press |
| 1 | Shadow: GET `/memories/graph` keeps serving the legacy answer. After the response it reads `memory_entity_links` for the same Memories, compares trip, place and people per Memory, and records counts | `memory_graph_shadow_read_enabled` | owner |
| 2 | Merge / split available to owners | `memory_merge_split_enabled` | owner (independent of 1 and 3) |
| 3 | Cutover: GET `/memories/graph` reads entity links from the graph | `memory_graph_read_cutover_enabled` AND the gate (§6) | owner |
| 4 | Later, not this branch: the other scalar readers (place history, people history, trip recap), then decommissioning of the scalar writers per §22 step 9 | — | — |

## 6. The cutover gate ("comparison clean")

All of the following must hold, over the trailing **7 complete UTC days** (yesterday and the six before it), on surface `memories_graph`:
- at least **500** Memory comparisons in total;
- **zero** mismatches;
- **zero** graph read failures;
- comparisons on **at least 5 of the 7 days**, so one busy day cannot certify a week.

If the gate cannot be read, it is closed. With the cutover flag ON and the gate closed, the route serves the legacy answer and logs why. Turning the flag on early is therefore harmless. The gate is a pure function (`evaluateCutoverGate`) over the daily rows, tested at every boundary.

## 7. What the owner must do to cut over (not done by this branch)

1. Apply 2993, 2994, 3674, 3675 and 3676 to production, after CI's live-DB run is green on main with them.
2. Turn `memory_graph_shadow_read_enabled` ON.
3. Wait at least 7 days of real traffic. Then read `memory_graph_shadow_daily` (or GET `/admin/memory-graph/shadow`): it must show the gate `open: true`.
4. Turn `memory_graph_read_cutover_enabled` ON. The gate is re-checked on every request, so a later mismatch closes it again by itself.
5. Rollback is turning the cutover flag OFF. It is instant, because the legacy path never stopped being written.

## 8. Verification plan (per step)

- **Data loss**
  - Merge: the item, tag, save, like and control counts after equal the union before (PGlite probe).
  - Split: source + new = original, and the source is never emptied.
  - Rollbacks refuse while they would drop a redirect or a lineage edge.
- **Privacy**
  - An audience mismatch is refused, whatever the direction.
  - The redirect answers 404 to a viewer who cannot read the survivor, and to a blocked one.
  - A non-approved tag never becomes an edge, and a withdrawn tag removes it.
  - Account deletion and Memory hard-delete remove every relation and redirect.
  - Shadow records carry no id.
- **Regressions**
  - With every flag OFF, GET `/memories/graph`, GET `/memories/:id` and the deletion lifecycle answer byte-identically to today.
  - The existing memory suites pass.
- **Idempotency**
  - The same Idempotency-Key returns the original merge result.
  - The backfill run twice inserts nothing the second time.
- **Mutants**: every rule above has a mutant that a test kills.

## 9. Not built here, and why

| Row | Why it stays where it is |
| --- | --- |
| H35 `memory_snapshots` | Not needed. Merge and split are replayable from `memory_domain_events` + receipts + redirects + the `DERIVED_FROM` edge, and nothing else in this work needs a versioned snapshot. |
| H71 entity merges repoint identity, keeping occurrence-time display text | The place catalog's merge chain is already followed at read time (H-17c). But no Memory stores occurrence-time display text separately from the current place row, and the legacy edge stores ids only. A `display_name_at_occurrence` column is the missing piece. |
| H72 entity splits re-resolve from retained evidence | No entity-split operation exists in the place catalog to trigger it. |
| AI-provider rows (H14, H171, H172, H203, H262, H265) | Not touched. Nothing here chooses or calls a model. |
