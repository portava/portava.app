# LANE REPORT — HM-SERVER

Branch `lane/hm-server`, based on `561a0a7b0`. Five commits.
Census verdicts in this report are `C` / `W` / `N` / `X`, taken from
`CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity` — **not** read out of
the document body, because that census is append-only and last-statement-wins.

---

## THE THREE QUESTIONS

### 1. Do highlight events require downstream projections? — YES. Built.

**What was true before.** `EVENT_PROJECTIONS` in
`artifacts/api-server/src/services/memoryProjections/outboxConsumer.ts` was typed
`Record<Extract<MemoryEventType, "memory.${string}">, …>`. Every one of §17's
five `highlight.*` names therefore fell through `projectionsForEventType`,
was acked with the class `unsubscribed_event_type`, and rebuilt nothing. The
code said so honestly in three places.

**What the approved specification requires.** Two sentences settle it.

* §18 (`docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:512`)
  lists **ProfileHighlightProjection**, audience **"Audience-specific profile"**.
* §12 (`:357`) opens: *"Highlights are disposable, audience-specific projections
  over one or more Memories or Episodes."*

So §18's profile row **is** the artifact a Highlight event invalidates. It had
no Highlight source, which is a gap in the builder, not a correct reading of
§18. It is a gap, not a decision.

**What I built.**

* `ProfileHighlightProjection` declares `highlights` among its `source_tables`
  and builds a second half from `public.highlights` (deployed — every column is
  in `src/lib/capability/snapshots/20260922-production-schema.json`).
  Audience-filtered (§23: `highlights` carries no allow-list, so anything not
  `public` is owner-only), archived and deleted excluded (§21 — a profile is
  browsing), pin-ordered **across both halves** (§12 *"Pinned/manual order
  always outranks automatic ordering"*).
* It carries **no** Highlight text: `caption` is not selected, not whitelisted,
  and not mapped through `title`. `expires_at` and `pinned` are **carried, not
  applied** — §12's expiry is read-time, and a builder that read a clock could
  not be replayed (§28.12).
* `HIGHLIGHT_EVENT_PROJECTIONS` subscribes all five names, total over them by
  construction. `eventSubjectOf` routes on the event **type**, never on which id
  happens to be non-null.
* The 2993/2994 defect the brief names is **not regressed and is now covered by
  an assertion**: `projectionsForEventType` is still asked before any aggregate
  is read, and the null-subject guard moved *into*
  `readHighlightProjectionScope`, which answers `highlight_absent` with **no
  database call**. A test records every `.eq` the consumer issues and asserts
  none carried `null`/`undefined`.
* `sourceVersionOf` folds the Highlight half in under a `v2` tag and stays
  **byte-identical to `v1`** when there are none — a registration written before
  this change must not be reported STALE on the first pass after deploy.

**What is still not true on any live database, and the code says so.**
`memory_event_outbox.highlight_id` is migration 2993's and the claim function is
2994's; neither is applied anywhere. Today the drain answers `claim_unavailable`
before any of this runs, and a `highlight.*` row claimed from a database without
2993 is acked `highlight_absent` rather than handed a null.

**Verdicts moved: H158 `N → W`, H159 `N → W`** (see the table). H155/H156/H157
stay `N`: a subscriber for an event nobody emits is not the event.

### 2. Can hide/unhide and replay semantics diverge? — YES, permanently. Built.

**Measured.** `POST /highlights/:id/archive` is §17's `HIDE_HIGHLIGHT` and
emits `highlight.hidden` (`artifacts/api-server/src/routes/highlights.ts:2070`).
`DELETE /highlights/:id/archive` — the half that makes §21's Archive
**reversible** rather than a second delete — was a bare
`.from("highlights").update({ archived_at: null })`
(`artifacts/api-server/src/routes/highlights.ts:2120`): no command id, no
idempotency key, no audit row, no sequence, **no event**. The log's last word on
a hidden-then-unhidden Highlight is `highlight.hidden` while the row is visible,
so a §18 consumer rebuilding from the log withholds a Highlight its owner
restored — permanently, because nothing later contradicts the hide.

**What the specification requires.** §17 names `HIDE_HIGHLIGHT` and no inverse
— but it names `PIN_HIGHLIGHT` and `UNPIN_HIGHLIGHT` as a pair, so the omission
is an asymmetry in §17, not a ruling that Archive is one-way. §21 settles it:
Archive is what it is *because it can be undone*, so the undo is a canonical
write, and §17's first sentence — *"All canonical writes should cross an
explicit command boundary"* — applies whether or not §17 named it.

**What I built.**

* `UNHIDE_HIGHLIGHT` declared as an **EXT** in
  `artifacts/api-server/src/lib/memoryCommandBus.ts`, on the `UPDATE_MEMORY`
  precedent: `COMMAND_SUBJECT → "highlight"`, `COMMAND_CAPABILITY → "owner"`,
  `COMMAND_EVENT → "highlight.hidden"` (sharing the §17 name exactly as
  `UNPIN_HIGHLIGHT` shares `highlight.pinned`, because a consumer cannot
  subscribe to a name §17 does not list).
  `MEMORY_COMMAND_TYPES_NOT_DECLARED` is untouched — including `MERGE_MEMORY`'s
  load-bearing `no memory_relations table` string.
* `artifacts/api-server/src/services/memoryProjections/highlightEventReplay.ts`
  — the §25 fold, and the divergence as an executable assertion. It reads
  `payload_json.command_type`, **not** the event name, because on this aggregate
  a name is not a transition: a fold over names collapses PIN+UNPIN to pinned
  and HIDE+UNHIDE to hidden, which is the same defect reached by another route.
  Order comes from `sequence` only. A duplicate sequence, a missing
  `command_type`, an unknown command, a name that is not the one its command
  emits, and a stream mixing two Highlights are each a discriminated **refusal**,
  never a best-effort state. A Highlight with **no** events is `not_replayable`,
  never "agrees" — an aggregate whose whole history is direct writes agrees with
  the empty fold only by accident.

**The SQL half is a measured, audited gap, and there is a test that fails when
it closes.** `src/migrations/2993_highlight_command_boundary.sql:386` refuses
any type outside `('PIN_HIGHLIGHT','UNPIN_HIGHLIGHT','HIDE_HIGHLIGHT')` with
`MEMORY_COMMAND_UNKNOWN_TYPE` and writes an audit row — so a dispatched
`UNHIDE_HIGHLIGHT` is a clean rejection, never a wrong write.
`src/test/highlightEventReplay.test.ts` pins that fact in both directions.

**Exactly what HM-API must call** is in NOT DONE (a) below.

### 3. Schedulers and consent gates — which obligations have none?

Measured, then built where it was inside my ownership.

| obligation | needs | measured state |
|---|---|---|
| §21 *"dead-lettered if a downstream cleanup repeatedly fails"* | a sweep | **BUILT this lane**, over `highlight_revocation_log` (2724, **applied** 20260915054107). Not wired — see (a). |
| §21 *"observable"*, durably | a writer for 2724 | **BUILT this lane** (`recordRevocationAttempt`). The table had **never had a row**: the only TypeScript naming it was the test asserting it is deployed. Not wired — see (a). |
| §12 expiry → §17 `highlight.expired` | a sweep **and** an emitter | **NEITHER EXISTS.** No writer emits `highlight.created`, `highlight.published` or `highlight.expired` (grepped over `src/**` and `src/migrations/**`); expiry is still a read-time predicate. The emitter belongs inside 2993's kernel. |
| §11 resurfacing suppression | nothing — read-time | Correct as built: `CONTROL_EFFECTS` is applied on the live proactive feeds. |
| §21 retention / raw-evidence purge | a sweep | `memory_sweep_expired` (2185) exists behind flag `memory_projection`, which reads **off** in production. |
| §10 consent: STORE, PERSONALIZE, CONTRIBUTE_TO_AGGREGATE_INTEL | a gate on a real path | **STILL ABSENT**, and `consentEnforcement()` in `services/highlights/highlightPublicProjection.ts` *derives* that rather than listing it. `mayProject` has no production caller. Those paths (Compass, personalization, aggregate intel) are outside this lane. |
| §10 consent + precision on the NEW §18 derivative | a gate | **BUILT this lane** — and it is a gate I would otherwise have *removed*; see below. |

**The gate I nearly removed by accident, and closed.** The live profile read of
`public.highlights` already enforces §10: `publicProjectionVerdict` withholds on
an explicit `consent_share = false` and `resolveLocationDisclosure` clamps the
location to the owner's rung. The §18 derivative I added in question 1 is a
**second path to the same rows**. Without a gate it would have carried a
Highlight its owner had un-shared and a city its owner had hidden — §28.6's
failure arriving through a new door. So:

* `ProjectionInput.highlights` is `{ rows, policies }` — **one field**, so the
  compiler refuses a build from Highlights whose §10 policy was never read. An
  absent policy set is not "no policy"; it is a read that did not happen.
* `readHighlightSources` reads `highlight_projection_policies` (2721, applied
  20260915055812) in the **same step**, and an unreadable policy table is a
  **refusal** — §10's ladder is a publication limit and an unreadable limit must
  never be served as an absent one.
* The builder **imports** `clampLocationToPrecision`, `consentFromRow` and
  `isLocationPrecision` rather than restating the ladder.
* EXPLICIT-FALSE-ONLY, deliberately not `!mayProject`: `unknown` is the state
  nearly every Highlight is in. The owner is never clamped or withheld from
  their own row. A stored rung the ladder does not contain clamps to HIDDEN.
* `sourceVersionOf` folds the policies in **by content** (precision + share), so
  an owner narrowing their own publication cannot leave the wider artifact
  reading FRESH.


---

## ROW TABLE

179 rows. **Two verdicts move: H158 `N → W` and H159 `N → W`.** 45 more I
re-measured and report unchanged, 14 of those with a reason I found FALSE (see
STALE EVIDENCE). The remaining rows are carried forward and are labelled as
carried forward — I did not re-open them, and I am not claiming otherwise.

| row | current | mine | evidence |
|---|---|---|---|
| H1 | W | W | carried forward unchanged — census line 4081. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H2 | W | W | carried forward unchanged — census line 3928. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H3 | W | W | carried forward unchanged — census line 4348. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H4 | W | W | carried forward unchanged — census line 3048. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H6 | W | W | carried forward unchanged — census line 335. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H7 | W | W | carried forward unchanged — census line 795. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H8 | W | W | carried forward unchanged — census line 796. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H9 | W | W | carried forward unchanged — census line 797. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H10 | W | **W** | reason PARTIALLY STALE (2720/2721 applied); verdict holds on the faculties that do not exist |
| H11 | W | W | carried forward unchanged — census line 340. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H12 | W | W | carried forward unchanged — census line 798. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H13 | W | **W** | reason STALE — 2730 IS applied (`production-applied-migrations.json` `2730_memory_derivative_registry` @20260915080116); W holds on the rest |
| H14 | N | N | carried forward unchanged — census line 343. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H15 | W | W | carried forward unchanged — census line 344. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H16 | N | N | carried forward unchanged — census line 345. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H17 | W | W | carried forward unchanged — census line 351. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H18 | N | N | carried forward unchanged — census line 352. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H19 | N | N | carried forward unchanged — census line 353. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H20 | N | N | carried forward unchanged — census line 354. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H21 | W | W | carried forward unchanged — census line 355. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H22 | W | W | carried forward unchanged — census line 1211. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H23 | N | N | carried forward unchanged — census line 1212. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H24 | N | **N** | unchanged. `memory_evidence` is in no applied entry and no snapshot table list — unapplied storage is N by this census's own precedent |
| H25 | W | W | carried forward unchanged — census line 1214. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H26 | N | N | carried forward unchanged — census line 1215. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H27 | N | N | carried forward unchanged — census line 1216. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H28 | N | N | carried forward unchanged — census line 1217. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H29 | W | **W** | unchanged. `memory_command_receipts` deployed; `memory_kernel_enabled` has NO ROW in production ⇒ fail-closed ⇒ no receipt is ever written |
| H30 | W | **W** | unchanged. `memory_event_outbox` deployed; the producer is behind the kernel flag and 2994's claim fn is unapplied |
| H31 | W | W | carried forward unchanged — census line 1220. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H33 | N | N | carried forward unchanged — census line 1222. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H34 | W | **W** | unchanged. registry deployed and reached by `services/memory/memoryDeletionLifecycle.ts`; §18 reads still serve per-request builds (`routes/memories.ts:3320#registered: false`) |
| H35 | N | N | carried forward unchanged — census line 1224. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H36 | N | N | carried forward unchanged — census line 1225. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H37 | N | N | carried forward unchanged — census line 1226. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H38 | W | W | carried forward unchanged — census line 366. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H46 | W | **W** | reason STALE — 2723 IS applied @20260915080401 and `lifetime_class` is on the deployed `highlights`; W holds because nothing WRITES it |
| H47 | W | W | carried forward unchanged — census line 803. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H48 | W | W | carried forward unchanged — census line 376. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H49 | W | W | carried forward unchanged — census line 377. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H50 | W | W | carried forward unchanged — census line 860. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H51 | W | W | carried forward unchanged — census line 5693. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H52 | W | W | carried forward unchanged — census line 4082. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H54 | W | W | carried forward unchanged — census line 1232. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H55 | W | W | carried forward unchanged — census line 1233. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H56 | W | W | carried forward unchanged — census line 1234. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H57 | W | W | carried forward unchanged — census line 1235. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H58 | W | W | carried forward unchanged — census line 1241. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H59 | W | W | carried forward unchanged — census line 1242. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H60 | W | W | carried forward unchanged — census line 1243. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H61 | W | W | carried forward unchanged — census line 1244. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H62 | W | W | carried forward unchanged — census line 1245. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H63 | W | W | carried forward unchanged — census line 804. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H64 | W | W | carried forward unchanged — census line 805. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H65 | W | W | carried forward unchanged — census line 806. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H67 | W | W | carried forward unchanged — census line 408. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H68 | W | W | carried forward unchanged — census line 414. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H71 | N | N | carried forward unchanged — census line 417. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H72 | N | N | carried forward unchanged — census line 418. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H73 | N | N | carried forward unchanged — census line 419. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H75 | W | **W** | unchanged; census reason at :5250 already correct. Re-measured: `consentEnforcement()` derives that STORE/PERSONALIZE/CONTRIBUTE are read by nothing |
| H76 | W | W | carried forward unchanged — census line 427. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H79 | W | **W** | unchanged; census reason at :2150 already correct |
| H80 | N | N | carried forward unchanged — census line 431. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H81 | W | W | carried forward unchanged — census line 809. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H82 | W | W | carried forward unchanged — census line 810. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H84 | W | W | carried forward unchanged — census line 3051. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H86 | W | W | carried forward unchanged — census line 3929. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H87 | W | W | carried forward unchanged — census line 443. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H88 | W | W | carried forward unchanged — census line 444. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H90 | W | W | carried forward unchanged — census line 4879. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H91 | W | W | carried forward unchanged — census line 814. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H92 | W | W | carried forward unchanged — census line 4880. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H93 | W | **W** | unchanged; census reason at :5459 already correct. Re-measured: `linkHighlightSources` is called from `routes/highlights.ts:899` and 2722 is applied |
| H98 | N | N | carried forward unchanged — census line 4885. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H99 | W | W | carried forward unchanged — census line 815. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H100 | W | W | carried forward unchanged — census line 816. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H101 | W | W | carried forward unchanged — census line 817. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H103 | W | W | carried forward unchanged — census line 856. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H104 | W | W | carried forward unchanged — census line 3923. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H105 | W | W | carried forward unchanged — census line 3922. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H106 | W | W | carried forward unchanged — census line 2450. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H112 | W | W | carried forward unchanged — census line 1269. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H113 | W | W | carried forward unchanged — census line 1270. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H114 | W | **W** | unchanged. `derivativeRegistry.ts#revokeDerivativesForMemory` empties `payload_json` and deletion reaches it; the embedding half is NOT_CONFIGURED |
| H123 | W | W | carried forward unchanged — census line 1709. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H124 | W | W | carried forward unchanged — census line 1710. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H126 | W | W | carried forward unchanged — census line 1712. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H130 | W | **W** | unchanged. Blocker is `memory_kernel_enabled` reading false, NOT absent storage — 2710/2711 are applied. Checked that the flag gates THIS row's subject: it gates the receipt, the audit row and the emit |
| H131 | W | W | carried forward unchanged — census line 1316. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H132 | W | W | carried forward unchanged — census line 1317. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H133 | W | W | carried forward unchanged — census line 1318. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H134 | N | N | carried forward unchanged — census line 1319. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H135 | N | N | carried forward unchanged — census line 1320. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H136 | W | W | carried forward unchanged — census line 1321. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H137 | W | W | carried forward unchanged — census line 1322. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H138 | W | W | carried forward unchanged — census line 1323. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H139 | W | W | carried forward unchanged — census line 1324. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H140 | W | W | carried forward unchanged — census line 1325. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H141 | W | W | carried forward unchanged — census line 1326. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H142 | W | W | carried forward unchanged — census line 5689. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H143 | W | W | carried forward unchanged — census line 5690. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H144 | W | W | carried forward unchanged — census line 5692. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H145 | W | W | carried forward unchanged — census line 5691. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H146 | N | **N** | reason STALE — 2720 IS applied @20260915054221. Real reason now in `lib/memoryCommandBus.ts#MEMORY_COMMAND_TYPES_NOT_DECLARED.SET_RESURFACING_POLICY`: `subject_type` is one of four kinds, the event tables carry one of (memory_id, highlight_id) |
| H147 | W | W | carried forward unchanged — census line 1332. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H148 | W | W | carried forward unchanged — census line 1333. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H149 | W | W | carried forward unchanged — census line 1334. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H150 | N | N | carried forward unchanged — census line 1335. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H151 | N | N | carried forward unchanged — census line 1336. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H152 | W | W | carried forward unchanged — census line 1337. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H153 | W | W | carried forward unchanged — census line 1338. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H154 | W | W | carried forward unchanged — census line 1339. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H155 | N | **N** | unchanged. It now has a §18 SUBSCRIBER (`outboxConsumer.ts#HIGHLIGHT_EVENT_PROJECTIONS`) and still no writer: no command maps to it, 2993's kernel does not emit it. A subscriber for an unemitted event is not the event |
| H156 | N | **N** | unchanged, same measurement as H155 |
| H157 | N | **N** | unchanged. No expiry sweep and no emitter; the new projection CARRIES `expires_at` rather than applying it, so expiry is still read-time |
| H158 | N | **W** | **N -> W.** Two of four clauses FALSE: PIN/UNPIN both map to `highlight.pinned` (`lib/memoryCommandBus.ts#COMMAND_EVENT`), and `highlights.pinned_at` is deployed with routes at `routes/highlights.ts:1463,1517` crossing the boundary. Now also subscribed. Never emitted (emit is in unapplied 2993) — exactly H147-H154's W |
| H159 | N | **W** | **N -> W.** Same measurement. HIDE_HIGHLIGHT is declared, maps to `highlight.hidden`, dispatched at `routes/highlights.ts:2070`; this lane adds its EXT inverse and a §18 subscriber. Never emitted: 2993 unapplied |
| H160 | W | **W** | unchanged; blocker already corrected at census :4860 (2710/2711 applied, flag false) |
| H161 | W | **W** | unchanged. The consumer now covers BOTH aggregates; still claims nothing anywhere — `memory_outbox_claim` is 2994's and 2994 is unapplied |
| H162 | W | **W** | unchanged. `rebuildProjection` is now called for `highlight.*` too, but no event is ever claimed |
| H164 | W | **W** | unchanged. Only its whitelist was refactored (`PROFILE_FIELDS` spreads it), field-for-field identical; `PassportConsumerProjections.ts` still projects Passport artefacts |
| H169 | W | **W** | unchanged. Defined; no Compass tool reads it |
| H170 | W | **W** | unchanged. Eight-field whitelist, no coordinate, no significance |
| H171 | N | **N** | unchanged. NOT_CONFIGURED and refuses; asserted that no event subscribes to it |
| H172 | N | **N** | unchanged. NOT_CONFIGURED |
| H173 | W | **W** | unchanged |
| H174 | W | **W** | reason STALE — 2730 IS applied. W holds on the row's own words: `routes/memories.ts:3320` answers `registered: false`, so not EVERY derivative is registered |
| H175 | W | **W** | unchanged; blocker already corrected at census :4860 |
| H178 | W | W | carried forward unchanged — census line 3459. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H179 | N | N | carried forward unchanged — census line 542. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H180 | N | N | carried forward unchanged — census line 543. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H181 | W | W | carried forward unchanged — census line 3927. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H182 | N | N | carried forward unchanged — census line 550. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H183 | W | W | carried forward unchanged — census line 551. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H184 | N | N | carried forward unchanged — census line 552. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H187 | W | **W** | reason STALE — 2720 IS applied. W holds on the clause still true: no such control exists on a Memory |
| H188 | W | **W** | reason STALE, same as H187 |
| H189 | W | W | carried forward unchanged — census line 3924. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H190 | W | W | carried forward unchanged — census line 3925. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H192 | W | **W** | unchanged. `REVOCATION_DESTINATIONS` is §21's eight; seven are not_applicable/not_implemented. This lane makes the RECORD durable (2724, applied) and adds no destination |
| H193 | W | **W** | unchanged, and this is question 3's row. Its reason *"there is no table"* is FALSE — 2724 applied @20260915054107. Built here: writer + dead-letter classifier + sweep (`lib/memoryRevocationDeadLetter.ts`, 24/24). NOT MOVED: no feature-surface caller — `src/index.ts` and `routes/highlights.ts` are other lanes'. A `lib/` capability called by nothing is N for that capability |
| H198 | W | W | carried forward unchanged — census line 2616. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H200 | W | **W** | unchanged; census reason at :5249 already correct |
| H201 | W | **W** | unchanged. NOTE: `memory_location_precision_enabled` is a SCHEMA gate for 2338, which IS applied, so it gates nothing for this row — the live blocker is that the ladder does not reach a Memory's `location_lat`/`location_lng` |
| H202 | W | W | carried forward unchanged — census line 3930. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H203 | N | N | carried forward unchanged — census line 583. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H208 | W | **W** | unchanged; same flag note as H201 |
| H210 | W | **W** | unchanged. Re-measured: `consentEnforcement()` in `services/highlights/highlightPublicProjection.ts` DERIVES that PERSONALIZE is stored and read by nothing |
| H211 | N | N | carried forward unchanged — census line 1402. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H212 | N | N | carried forward unchanged — census line 1403. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H213 | N | N | carried forward unchanged — census line 1404. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H214 | N | N | carried forward unchanged — census line 1405. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H215 | N | N | carried forward unchanged — census line 1406. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H216 | N | N | carried forward unchanged — census line 1407. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H217 | N | N | carried forward unchanged — census line 1408. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H218 | N | N | carried forward unchanged — census line 1409. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H219 | W | W | carried forward unchanged — census line 4083. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H220 | W | W | carried forward unchanged — census line 5627. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H221 | N | **N** | reason STALE — 2720 IS applied. N holds: nothing counts a violation |
| H222 | N | N | carried forward unchanged — census line 1413. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H223 | W | W | carried forward unchanged — census line 2149. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H238 | N | **N** | reason STALE — 2722 IS applied and `highlightSources.ts#linkHighlightSources` is called from `routes/highlights.ts:899`. N holds on the half still true: `POST /highlights` accepts a client-supplied `mediaUrl` with no source |
| H242 | W | W | carried forward unchanged — census line 1446. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H243 | W | W | carried forward unchanged — census line 1447. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H244 | W | **W** | reason STALE on BOTH counts — 2710 applied and `outboxConsumer.ts` exists. W holds because 2994's claim function is unapplied, so the consumer claims nothing on any database |
| H249 | W | **W** | unchanged. Merge half still no surface; `MEMORY_COMMAND_TYPES_NOT_DECLARED.MERGE_MEMORY`, its `no memory_relations table` string, `chaos.ts:296` and `memoryCertificationChaos.test.ts:150` all untouched, and `memory_relations` is absent from the 20260922 snapshot |
| H252 | W | **W** | unchanged |
| H254 | W | **W** | reason PARTIALLY STALE — those eight migrations ARE applied; the unapplied ones are 2992/2993/2994. W holds |
| H255 | W | W | carried forward unchanged — census line 1469. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H256 | W | W | carried forward unchanged — census line 1470. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H257 | W | **W** | reason STALE — 2723 IS applied. W holds: the profile projection now exists (this lane) but nothing serves it from the registry and nothing reorders |
| H258 | W | W | carried forward unchanged — census line 2151. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H259 | N | N | carried forward unchanged — census line 1473. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H260 | W | **W** | unchanged; census reason at :4857 already correct |
| H261 | W | W | carried forward unchanged — census line 1475. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H262 | N | N | carried forward unchanged — census line 1481. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H265 | N | N | carried forward unchanged — census line 1484. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |
| H266 | W | W | carried forward unchanged — census line 4349. NOT re-opened this pass: my build does not bear on it and I did not measure it, so I am not claiming it was re-verified |

---

## BUILT

| path | what | rows it bears on |
|---|---|---|
| `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts` | `HighlightSourceRow`, `HighlightPolicyRow`, `ProjectionInput.highlights = {rows, policies}`, `PROFILE_FIELDS`, the §12 Highlight half of `ProfileHighlightProjection` (`highlightHalf`), §12 pin ordering (`orderProfileHighlights`), §10 clamp (`clampHighlightLocation`), `sourceVersionOf` over highlights + policies | H155–H159, H162, H165, H174, H244, H257 |
| `artifacts/api-server/src/services/memoryProjections/derivativeRegistry.ts` | `readHighlightSources` — `highlights` + `highlight_projection_policies` read in ONE step, both refusing rather than returning empty; `readsHighlights` derives the read from `source_tables`; staleness uses the same source set | H34, H114, H162, H174, H244 |
| `artifacts/api-server/src/services/memoryProjections/outboxConsumer.ts` | `HIGHLIGHT_EVENT_PROJECTIONS` (total over the five), `eventSubjectOf`, `readHighlightProjectionScope`, `SUBSCRIBED_HIGHLIGHT_EVENT_TYPES`, the two-aggregate drain branch | H155–H161 |
| `artifacts/api-server/src/services/memoryProjections/highlightEventReplay.ts` **(new)** | §25 fold over `command_type`, ordered by `sequence`; `replayAgreesWithRow`; `HIGHLIGHT_COMMAND_EFFECTS` total over the Highlight commands | H159, H175, H178, H244 |
| `artifacts/api-server/src/lib/memoryCommandBus.ts` | `UNHIDE_HIGHLIGHT` declared EXT + its three map entries | H130–H145, H159 |
| `artifacts/api-server/src/lib/memoryRevocationDeadLetter.ts` **(new)** | `recordRevocationAttempt` (the first writer 2724 has ever had), `classifyRevocationBacklog` (pure; dead letter DERIVED from the insert-only log), `readRevocationBacklog`, `sweepRevocationDeadLetters` | H192, H193 |
| `artifacts/api-server/src/services/memoryProjections/outboxDrainRunner.ts` | header: the "no Highlight worker" claim superseded, and what is still untrue on a live database | H161, H162 |
| `artifacts/api-server/src/test/highlightEventReplay.test.ts` **(new, registered)** | 22 tests | Q2 |
| `artifacts/api-server/src/test/memoryRevocationDeadLetter.test.ts` **(new, registered)** | 24 tests | Q3 |
| `artifacts/api-server/src/test/memoryOutboxConsumer.test.ts` | Highlight-aggregate drain: rebuild, all five names, hard-deleted, unreadable table, the NO-NULL-`.eq` regression guard, "never looked up in `memories`" | Q1 |
| `artifacts/api-server/src/test/memoryProjectionRegistry.test.ts` | the Highlight half: whitelist, no caption, §23 audience, §21 archived/deleted, §12 pin order, carried expiry, staleness on a highlight AND on a policy, refusals, `source_memory_ids` unaffected, §10 consent + ladder + fail-closed rung | Q1, Q3 |
| `artifacts/api-server/src/test/memoryCommandBus.test.ts`, `src/test/highlightCommandBoundary.test.ts` | extensions pinned **by name**; four declared Highlight commands | Q2 |
| `artifacts/api-server/package.json` | registered the two new test files (`check:test-registration` names this file as the fix) | — |

**No migration was written.** Everything above runs against schema that is
already applied to production. Migration prefix `2979_*` is unused by this lane.

---

## TEST EVIDENCE

Failing-first, both corrections, watched RED then green:

```
# Q2 — with lib/memoryCommandBus.ts reverted to 561a0a7b0:
$ git stash push -- artifacts/api-server/src/lib/memoryCommandBus.ts
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test src/test/highlightEventReplay.test.ts
not ok 1 - §21 Archive is reversible, so the command boundary has an inverse for HIDE_HIGHLIGHT
# tests 20
# pass 17
# fail 3
# ...and with it restored:
# tests 22
# pass 22
# fail 0

# Q1 — with services/memoryProjections/projectionRegistry.ts reverted:
$ git stash push -- artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test src/test/memoryOutboxConsumer.test.ts src/test/memoryProjectionRegistry.test.ts
    not ok 3 - every subscriber declares `highlights` among its source tables
    not ok 1 - a claimed highlight event rebuilds ProfileHighlightProjection and is acked
    not ok 6 - THE HIGHLIGHT HALF IS PROJECTED, and the whitelist is what it carries
    not ok 8 - §23: a non-owner viewer sees only the PUBLIC Highlights
    not ok 10 - §12: a pinned Highlight outranks a NEWER Memory
    not ok 11 - expiry is CARRIED, not applied — the builder reads no clock
    not ok 12 - a Highlight change moves the SOURCE VERSION
    not ok 13 - with NO highlight rows the digest is byte-identical to the memories-only one
    not ok 14 - an UNREADABLE highlights table refuses
    not ok 15 - an ABSENT highlights table refuses and says a retry will not help
# tests 89
# pass 78
# fail 11
```

Green, at the final commit:

```
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test $(ls src/test/memory*.test.ts src/test/highlight*.test.ts \
      src/services/memoryProjections/*.test.ts src/services/memory/*.test.ts src/lib/memory*.test.ts \
      | grep -v 'Live.test.ts')
# tests 1227
# pass 1227
# fail 0

$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test src/test/highlightEventReplay.test.ts src/test/memoryRevocationDeadLetter.test.ts
# tests 46
# pass 46
# fail 0
```

Checks, at the final commit:

```
npm run typecheck                    PASS
npm run check:doc-citations          PASS — 0 anchored / 0 backticked dead (see NOT DONE (d) note)
npm run check:memory-certification   PASS — fixtures 12/0, invariants 8 held / 0 violated / 1 no-surface,
                                            chaos 7 tolerated / 0 broken / 2 partial
npm run check:schema-references      PASS — no NEW undeclared column references
npm run check:not-null-writes        PASS
npm run check:silent-supabase-writes PASS
npm run check:deletion-coverage      PASS
npm run check:data-rights            PASS
npm run check:test-registration      PASS — 1420 registered, 33 allowlisted
npm run check:memory-table-ownership FAIL — 2 problems, BOTH PRE-EXISTING at 561a0a7b0, neither mine to fix
npm run check:write-path-columns     CANNOT RUN — needs live credentials (NOT DONE (c))
```

`check:memory-table-ownership` fails identically at `561a0a7b0` and at my HEAD,
on `migrations/2993_highlight_command_boundary.sql` and
`test/highlightCommandBoundary.test.ts`. Verified by reverting my changes and
re-running. See NOT DONE (a).

Full curated suite, at the final commit:

```
$ npm test
# tests 25293
# suites 6053
# pass 25275
# fail 18          <- see note
# cancelled 0 / skipped 0 / todo 0
# duration_ms 1918542
```

**The TAP stream contains exactly TWO `not ok` lines**, both from
`src/test/wallPerformance.test.ts` (the leaf and its suite rollup), and exactly
two `ERR_TEST_FAILURE` records. The summary's `# fail 18` does not correspond to
eighteen reported failures and I am reporting what the stream shows rather than
reconciling node's counter. The failing test is:

```
not ok 6 - the first page's serialized round-trip depth stays inside its ratchet
   "the first page now waits on ~130 serialized database round trips, over the
    recorded ratchet of 110"
```

**Not mine, and load-sensitive.** Re-run in isolation at this same HEAD it
PASSES — `first page modelled at 4ms/round-trip: 434ms (cpu 8.5ms + ~106
serialized round trips; ratchet 110)`. Under the fully parallel run the same
model measured `cpu 15.6ms + ~130`. It is a Wall route (`/wall?mode=for_you`);
nothing in this lane is on it, and my only added reads
(`highlights`, `highlight_projection_policies`) fire solely inside
`deriveProjection` for `ProfileHighlightProjection`.

**Baseline honesty.** My first attempt at a pre-change baseline was SIGTERM'd at
~41 minutes and showed three unrelated failures
(`flagSchemaPrerequisites`, `suggestionSeenCache`, `guardReachability`). None of
the three recurs in this clean completed run, so those were artefacts of the
kill / load, not a real baseline.

---

## NOT DONE AND WHY

### (a) needs a file another lane owns

1. **`artifacts/api-server/src/routes/highlights.ts` — route `DELETE /highlights/:id/archive`.**
   Replace the bare direct write with a command dispatch. Exactly:

   ```ts
   const idempotencyKey = highlightIdempotencyKey(req, res);
   if (idempotencyKey === null) return;
   const outcome = await dispatchMemoryCommand<{ id: string; archivedAt: null }>({
     sc: client,
     commandType: "UNHIDE_HIGHLIGHT",   // declared in lib/memoryCommandBus.ts
     memoryId: null,
     highlightId: id,
     actorUserId: user.id,
     idempotencyKey,
     payload: {},
     fromKernelResult: () => ({ id, archivedAt: null }),
     legacy: async () => { /* the existing .update({ archived_at: null }) body, verbatim */ },
   });
   if (!outcome.ok) { sendHighlightCommandFailure(req, res, outcome); return; }
   res.status(200).json(outcome.body);
   ```

   With `memory_kernel_enabled` off (production: **no row**) this takes the
   `legacy` branch and behaves byte-identically to today, plus an audit line
   marked `durable:false`. **That route file is ~2856 lines and is cited by line
   number; the block above is 15 lines and the block it replaces is 13, so it
   needs two lines paid for elsewhere in that file to stay line-neutral.**

2. **`artifacts/api-server/src/routes/highlights.ts` — persist revocation.**
   After `executeRevocation(...)` in each §21 handler, call
   `recordRevocationAttempt(client, { attemptId: randomUUID(), operation,
   subjectId: id, actorId: user.id, outcomes: report.outcomes })` from
   `lib/memoryRevocationDeadLetter.ts`. Without this
   `public.highlight_revocation_log` (deployed since 2026-09-15) still has no
   row and §21's "observable" is a log line rather than a record.

3. **`artifacts/api-server/src/index.ts` — start the sweep.** One import plus
   one call, beside the other schedulers, for a runner around
   `sweepRevocationDeadLetters`. Until then the dead-letter capability is a
   `lib/` module with no feature-surface caller, which this census scores `N`,
   and H193 does not move. I deliberately did **not** hang it off
   `lib/memoryProjectionScheduler.ts`: that file is cited by line number at
   `census-highlights-memories.md:213` and `outboxDrainRunner.ts`'s header
   records the cost of having moved it once already.

4. **`artifacts/api-server/src/scripts/checkMemoryTableOwnership.ts`** — add
   `migrations/2993_highlight_command_boundary.sql` and
   `test/highlightCommandBoundary.test.ts` to its `KERNEL_SIDE` set (line 114).
   Both name `public.memory_domain_events` and both are genuinely kernel-side.
   **This failure PRE-DATES my branch** — identical at `561a0a7b0`, verified by
   reverting.

### (b) needs unapplied schema

5. **`src/migrations/2993_highlight_command_boundary.sql`** must learn
   `UNHIDE_HIGHLIGHT`. 2993 is unapplied on every database, so amending it in
   place is legitimate. Two edits:
   * `:386` — `IF v_type NOT IN ('PIN_HIGHLIGHT', 'UNPIN_HIGHLIGHT',
     'HIDE_HIGHLIGHT', 'UNHIDE_HIGHLIGHT') THEN`
   * a new `CASE` arm beside `HIDE_HIGHLIGHT`:
     ```sql
     WHEN 'UNHIDE_HIGHLIGHT' THEN
       UPDATE public.highlights SET archived_at = NULL WHERE id = v_highlight_id;
       v_event_type := 'highlight.hidden';
       v_result := jsonb_build_object('id', v_highlight_id, 'archived_at', NULL);
       v_to := CASE WHEN v_pinned IS NOT NULL THEN 'PINNED'
                    WHEN v_expires IS NOT NULL AND v_expires <= v_now THEN 'EXPIRED'
                    ELSE 'ACTIVE' END;
     ```
     (the `v_to` shape is UNPIN_HIGHLIGHT's at `:495`, which already answers the
     same question). Its header at `:165` must also drop *"There is no UNHIDE
     command … keeps its direct write."*
   `src/test/highlightEventReplay.test.ts` asserts the current gate in BOTH
   directions, so it goes red the moment this lands and cannot be forgotten.
   I could not write this as `2979_*.sql`: 2979 sorts **before** 2993, so the
   function it defined would be replaced by 2993's.

6. **`highlight.created` / `highlight.published` / `highlight.expired`** have a
   §18 subscriber and no emitter. Creation and expiry do not cross the command
   boundary at all; §12's expiry additionally needs a sweep. Both belong in
   2993's kernel plus a scheduler.

7. **The whole outbox drain is inert until 2994** (`memory_outbox_claim`) and
   **2993** (`highlight_id` on the four kernel tables) are applied. `2992`,
   `2993`, `2994` appear in no entry of
   `src/lib/capability/production-applied-migrations.json` and
   `memory_relations` is absent from the 20260922 snapshot. Re-verified.

8. **`memory_kernel_enabled` has no row in production**, so `isFlagEnabled` is
   fail-closed and every Memory and Highlight command takes its legacy direct
   write. Checked per row before resting a verdict on it: the flag gates
   idempotency, the receipt, the audit row and the event emit — authorization
   and invariants run flag-off — so it is the right blocker for H130–H145 and
   H175, and it is **not** a blocker for anything else I graded.

### (c) needs an external credential / service

9. `npm run check:write-path-columns` and the three `*Live.test.ts` suites
   (`memoryKernelTransactionLive`, `memoryLifecycleLive`,
   `memoryProjectionLifecycleLive`) refuse before running: `KNOWN_PROD_PROJECT_REF`
   and `CI_SUPABASE_PROJECT_REF` are unset here, and the guard is in the
   execution path rather than in YAML. This is an environment limitation, not a
   result — I did not run them, and I am not reporting them as passing.
10. `scripts/local-db/up.sh` would replay 2993/2994 into a throwaway PostgreSQL
    and is the only way to exercise the Highlight outbox path end-to-end
    against real SQL. I did **not** run it: it would not change any verdict
    (production still lacks both migrations) and disk here is tight. Named so
    the next lane can decide differently.

### (d) out of scope / declined

11. **I did not repoint a single census citation, and I did not need to.** My
    first three commits moved 11 anchored citations in
    `census-highlights-memories.md` — a file this lane may not edit. Commit 5
    makes every edit **line-neutral above every cited anchor** instead:
    `check:doc-citations` is back to `0 / 0`, exactly as at `561a0a7b0`. The
    technique and the anchor list are in that commit message. New declarations
    now sit at the bottom of three files with a header explaining why, so the
    next reader does not tidy them back.
12. §21's other seven revocation destinations (H192). The sweep makes their
    status durable; it does not create a destination that does not exist.
13. `MERGE_MEMORY` / `SPLIT_MEMORY` (H249). `memory_relations` is absent from
    the 20260922 snapshot; the bus's reason string, its consumer at
    `services/memoryCertification/chaos.ts:296` and the assertion at
    `memoryCertificationChaos.test.ts:150` are untouched.

---

## STALE EVIDENCE FOUND

Every row below is one whose stated reason I RE-TESTED and found FALSE. **No
verdict moves on any of them** — in each case the verdict stands on a different
clause, which is exactly the distinction worth recording: an unapplied migration
needs a deploy, a false flag needs an audited flip, and a census that names the
wrong one sends the next reader to the wrong remedy.

The whole class has one cause. **2710, 2711, 2720, 2721, 2722, 2723, 2724 and
2730 were ALL applied to production on 2026-09-15** — verified against
`src/lib/capability/production-applied-migrations.json` (versions 20260915054107
through 20260915083533) and `snapshots/20260922-production-schema.json`
(watermark 20260922155706). Only **2992, 2993, 2994** remain unapplied.

| row | the claim I re-tested | measured |
|---|---|---|
| H13 | "the projections it reads have no registry rows because **2730 is unapplied**" | FALSE. `2730_memory_derivative_registry` @ 20260915080116; `memory_derivative_registry` has all 19 columns in the snapshot. |
| H46 | "`highlights.lifetime_class` does not exist (**2723 unapplied**)" | FALSE on both halves. 2723 @ 20260915080401; `lifetime_class` is on the deployed `highlights`. Verdict holds because nothing WRITES it. |
| H146 | "`highlight_resurfacing_preferences` is **2720, unapplied**" | FALSE. 2720 @ 20260915054221. The real reason is structural and is now in the bus: `subject_type` is one of four kinds and the event tables carry exactly one of (memory_id, highlight_id). |
| H174 | "The table is **2730, unapplied**" | FALSE. Verdict holds on the row's own words — `routes/memories.ts:3320` answers `registered: false`, so not EVERY derivative is registered. |
| H187 / H188 | "Storage unapplied (**2720**)" | FALSE. Verdict holds on "still no such control on a **Memory**". |
| H193 | "**there is no table**" for dead-lettering | FALSE. `2724_highlight_revocation_log` @ 20260915054107, with the partial index `highlight_revocation_failed_idx … WHERE status = 'failed'` built for exactly this question. What WAS true: **nothing had ever written a row** — the only TypeScript naming the table was the test asserting it is deployed. |
| H221 | "with **2720 unapplied** the suppression set is `absent`" | FALSE. Verdict holds: nothing counts a violation. |
| H238 | "`highlight_sources` is **2722, unapplied**, with no writer" | FALSE on both halves. 2722 @ 20260915055904, and `services/highlights/highlightSources.ts#linkHighlightSources` is called from `routes/highlights.ts:899`. Verdict holds on the half still true: `POST /highlights` accepts a client-supplied `mediaUrl` with no source. |
| H244 | "there is no consumer — `memory_event_outbox` is **2710, unapplied**" | FALSE on both halves. 2710 @ 20260915060104 and `outboxConsumer.ts` exists. Verdict holds because **2994**'s claim function is unapplied, so the consumer claims nothing anywhere. |
| H254 | "The schema is **eight unapplied migrations**" | FALSE. Those eight are applied; the unapplied ones are 2992/2993/2994. |
| H257 | "**2723 is unapplied**" | FALSE. |
| H10 | its follow-up files three of five faculties behind **2720/2721** | Both applied. |
| H158 | "no command maps to it **and there is no pin**" | FALSE on both. PIN/UNPIN both map to `highlight.pinned`; `pinned_at` is deployed and `routes/highlights.ts:1463,1517` write it. → **N → W**. |
| H159 | "Same" (as H155's "no command maps to it") | FALSE. HIDE_HIGHLIGHT maps to `highlight.hidden` and `routes/highlights.ts:2070` dispatches it. → **N → W**. |

**A tooling note for whoever owns the census.** Several of these rows were
already corrected by a later section that spelled the verdict out —
`| H93 | BUILT-BUT-WRONG | … |` at `:5459`, and likewise H75 `:5250`, H91
`:5245`, H99 `:5461`, H100 `:5462`, H103 `:4858`, H112 `:5463`, H200 `:5249`,
H201 `:4854`, H210 `:4856`, H260 `:4857`. `checkCensusIntegrity.ts:157#VERDICT_ALIASES`
accepts short tokens only, so the tool reports those rows' OLDER short-form cell
and its OLDER reason. Every bucket agrees, so no count is wrong; the rows above
are the ones with **no** later restatement at all.

