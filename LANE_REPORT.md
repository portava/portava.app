# LANE HM-API — highlights/memories route surface

Worktree `/home/user/wt-hm-api`, branch `lane/hm-api`, from `561a0a7b0`.
Census: `docs/architecture/census-highlights-memories.md` (5787 lines, append-only,
LAST-STATEMENT-WINS). Vocabulary is this census's: **BAC / BBW / NB / CV** = C / W / N /
CANNOT-VERIFY.

**Verdicts below are DERIVED FROM THE TOOL, not read out of the document body:**

```
cd artifacts/api-server
CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity 2>/dev/null | grep '^highlights-memories|'
```

266 rows, matching the denominator, each as `<id>|<verdict>|<line of its LAST statement>`.
The `line` column in my row table is that line. This lane changes no file under `docs/`, so
the before-dump and the after-dump are byte-identical and the diff is empty — which is the
mechanical statement that **this section moves no row**, rather than my belief that it does
not.

**This corrected two things I had wrong from reading the body.** I had cited H50 as a stale
row on the strength of line 383; its LAST statement is line 860, and that one is accurate —
the entry is withdrawn below. And five rows (H93, H99, H100, H101, H103) I had anchored on
later *standing* restatements in §K.4/§P.7/§Q.6, which carry no verdict cell; they are
re-anchored on the last statement the parser actually takes.

**Memory routes live in `artifacts/api-server/src/routes/memories.ts`** — the file exists,
it is the one the census cites, and it is treated as mine. `src/routes/telegraphMemory.ts`
also exists and is a Telegraph surface, NOT a §17 Memory route; it was not touched.

**Headline: no verdict moves.** One API-level defect is fixed and one silent gap is made
observable, but every row in my set sits behind a gate this lane cannot reach —
`memory_kernel_enabled` FALSE on production, or a migration nobody has applied.
**Twenty-three rows' LAST-STATEMENT reasons are FALSE at HEAD** — re-tested, not inferred — and are
listed under STALE EVIDENCE FOUND with the still-true reason that holds each one where it
is. None of the corrections moves a bucket. One piece of census PROSE (§U.2) is also
falsified, and it is the one this lane was sent to settle.

---

## THE ASSIGNED QUESTION — `DELETE /highlights/:id/archive`

### What the approved specification requires

1. §17's first sentence is **unconditional over canonical writes**: *"All canonical writes
   should cross an explicit command boundary for authorization, invariants, idempotency,
   audit, and downstream event generation."* The seventeen names beneath it are a list,
   not the requirement. Clearing `highlights.archived_at` is a canonical write.
2. §5's Highlight lifecycle draws `PINNED ---- HIDDEN` — the diagram's one **undirected**
   edge — so a reversal out of HIDDEN is a transition the specification has, not one this
   product invented. (`docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:214-217`)
3. §17's COMMAND list names `HIDE_HIGHLIGHT` and no inverse. Its EVENT list names
   `highlight.hidden` and no inverse.
4. The tree already resolves **both** omissions, in two established ways:
   * a missing EVENT name → share the pair's event and discriminate in the payload
     (`COMMAND_EVENT.UNPIN_HIGHLIGHT === "highlight.pinned"`,
     `artifacts/api-server/src/lib/memoryCommandBus.ts:442`; the ADD_MEDIA/REMOVE_MEDIA
     precedent 2711 set);
   * a missing COMMAND name → declare an **EXT** command with a written reason.
     `UPDATE_MEMORY` is exactly that, at
     `artifacts/api-server/src/lib/memoryCommandBus.ts:318`, declared because *"§17 names
     no command for a plain field edit; a PATCH that touches neither lifecycle, place nor
     audience needs a name to cross the boundary at all."*

**Determination.** The specification requires the un-hide to cross the boundary, as an
EXT command (`UNHIDE_HIGHLIGHT`) emitting `highlight.hidden` with a payload discriminator.
§U.2's reasoning — that naming it *"would have put a command in the vocabulary that §17
does not define, which is the opposite of what a command boundary is for"* — is
**contradicted by the tree's own `UPDATE_MEMORY` precedent**, which was declared for that
exact reason. Leaving the write outside the boundary is not the conservative choice; it is
the choice that leaves §17's first sentence false on this route.

### Why that is not implemented here

The vocabulary is `src/lib/memoryCommandBus.ts` (HM-SERVER's `lib/**`) and the executing
arm is `src/migrations/2993_highlight_command_boundary.sql`, which is not my migration
prefix and which **refuses an undeclared type** with `MEMORY_COMMAND_UNKNOWN_TYPE`
(`2993_highlight_command_boundary.sql:386`). Declaring the name in TypeScript without the
SQL arm would turn every un-hide into a rejection the moment the kernel is enabled. Both
halves are one change; the exact request is under **NEEDS FROM HM-SERVER**.

### What IS implemented, consistently, in my file

`artifacts/api-server/src/routes/highlights.ts:2120` — the handler is unchanged in effect
and changed in two ways that are measurable:

1. **§19 envelope parity.** `artifacts/api-server/src/routes/highlights.ts:2128` now reads
   the envelope through the same `highlightIdempotencyKey` its three siblings use
   (`:1471`, `:1525`, `:2064`). Before this, three of the four writes on one aggregate
   answered **400** for an `Idempotency-Key` outside 1-200 characters and the fourth
   answered **200 and applied the write**. That divergence is not the one §17 causes; it
   was hiding behind it. The key is validated and deliberately **not honoured** — honouring
   it needs the receipt row only a command writes — and the suite asserts the replay still
   applies twice, so "validated" can never be read as "idempotent".
2. **The divergence is announced when it is real.**
   `artifacts/api-server/src/routes/highlights.ts:2144` — after the write and only if it
   succeeded, and only when `memory_kernel_enabled` is TRUE, the route logs a structured
   warning naming `COMMAND_EVENT.HIDE_HIGHLIGHT` as the event it did not emit, with the
   Highlight id, the owner and the idempotency key. With the flag FALSE — production today
   — no Highlight write crosses the boundary, nothing diverges and nothing is logged. The
   one extra `feature_flags` read is the same one every sibling write already pays through
   `memoryKernelClient`, and `requireUser` hands back the service client
   (`artifacts/api-server/src/lib/http.ts:293`), so the read has the same fail-closed
   behaviour as the siblings'.

### What was deliberately NOT done, with the reason

* **No `boundary` / `idempotent` field was added to the 200 body.** The consumer of the
  gap is an operator and a §18 replay, not the HTTP caller; a wire field with no required
  consumer is the incompleteness this census's own grading rule penalises.
* **No transition guard was added.** `DELETE …/archive` on a row that is not archived
  returns 200, and `POST …/archive` on a row that is already archived re-stamps and
  returns 200 — and 2993's `HIDE_HIGHLIGHT` arm
  (`2993_highlight_command_boundary.sql:500-509`) is unguarded in the same way. Guarding
  one half and not the other would make the pair **less** consistent, and the other half
  is a migration I may not edit. Recorded below as an owner decision.
* **No refusal when the kernel is ON.** Refusing the un-hide at flag-flip would keep the
  event stream honest by removing a user-facing reversal §21 promises. That trades a
  logging gap for a product regression and was not taken.

---

## THE FLAG TRAP, AUDITED PER ROW

A flag seeded FALSE makes a row `W` only when the flag gates **the thing the row is
about** — not when it gates a caller standing in front of an already-correct pipeline. I
checked each flag I leaned on rather than applying the rule by reflex.

| flag | value in the 2026-09-22 capture | what it actually gates | rows I rest on it | verdict |
|---|---|---|---|---|
| `memory_kernel_enabled` | `false` | `memoryKernelClient` returns null, so `dispatchMemoryCommand` takes the `legacy` branch. With it off, §17's five obligations split: **authorization ✓** and **invariants ✓** still run (`guardLifecycle`, `src/routes/memories.ts:1647`, flag-independent), but **idempotency ✗** (no receipt row — my own RED-first case proves a replayed key applies twice), **audit ✗** (`auditCommand(… durable: false)` is a log line, not a row) and **event generation ✗**. | H130–H141, H142, H143, H145, H175 | **gates the row's subject — W is correct** |
| `highlights_feed_bounded_enabled` | `false` | `src/routes/highlights.ts:2668` — the following-feed's `.limit()` and cursor are applied ONLY when it is true, so the feed is literally unbounded on production. | H103 | **gates the row's subject — W is correct** |
| `memory_public_feed_projection_enabled` | `false` | `src/routes/memories.ts:647` — chooses between the §18 projection RPC (a derivative) and a PostgREST read over canonical `memories`. Off ⇒ canonical storage, which is precisely what H79 forbids. | H79 | **gates the row's subject — W is correct** |
| `memory_location_precision_enabled` | `false` | a SCHEMA-PRESENCE gate for migration 2338 — and **2338 IS applied**, `memories.location_precision` IS in the capture, so the flag is now lagging its own precondition. | **none** | **does NOT decide any row of mine.** H201 and H208 rest on code facts instead, and I removed the flag clause from both rather than leave a verdict resting on something that does not gate it |

## ROW TABLE

`current` is the tool's answer — `CENSUS_INTEGRITY_DUMP=ALL` — with the line of the row's
LAST statement beside it, so every cell is checkable with one grep and none of it is my
reading of the body. `mine` is what I measured at `561a0a7b0` plus this lane's two commits.
**All 56 rows agree with the tool; zero mismatches.**

| row | current (tool) | mine | one-line evidence |
|---|---|---|---|
| H12 | W (line 798) | **W** | ranking IS now wired — `artifacts/api-server/src/routes/highlights.ts:1285#rankHighlightRows`; no service BUILDS a Highlight, `POST /highlights` still inserts a client `mediaUrl` (`:740`) |
| H13 | W (line 799) | **W** | both stated clauses false (caller at `artifacts/api-server/src/routes/memories.ts:943#runMemorySearch`, 2730 applied); held W — SHARED_CREW unreachable, `artifacts/api-server/src/services/memory/memorySearchService.ts:118` |
| H21 | W (line 355) | **W** | 4 of the 9 named fields are now on production; `source_memory_ids`/`starts_at`/`ranking_score`/`reason_codes`/`audience_policy_id`/`presentation_json` are not — `artifacts/api-server/src/lib/capability/snapshots/20260922-production-schema.json` |
| H31 | W (line 1220) | **W** | same capture, same six absent |
| H38 | W (line 366) | **W** | `memories.state` CHECK still `draft/published/archived/deleted/removed` — `docs/migrations/0067_memories.sql:22` |
| H46 | W (line 802) | **W** | "`lifetime_class` does not exist (2723 unapplied)" FALSE — column present in the 2026-09-22 capture; PERMANENT still unstorable (H98) |
| H50 | W (line 860) | **W** | "no transition guard" FALSE — `artifacts/api-server/src/routes/memories.ts:1647#guardLifecycle`; W stands on §5's four unstored states (H38) |
| H51 | W (line 5693) | **W** | §T unchanged: PINNED and HIDDEN have witnesses, DRAFT and PUBLISHED are unstorable |
| H52 | W (line 4082) | **W** | already moved at §K.1; `artifacts/api-server/src/routes/memories.ts:1938#runMemoryDeletionLifecycle` runs §5's five states, `memory_evidence` still ABSENT from the capture |
| H79 | W (line 2150) | **W** | flag-off path still reads canonical `memories` through the service client — `artifacts/api-server/src/routes/memories.ts:664#.from("memories")`; `memory_public_feed_projection_enabled` is `false` in the capture |
| H81 | W (line 809) | **W** | unchanged by this lane |
| H93 | W (line 855) | **W** | `sourceMemoryIds` is `.optional()` — `artifacts/api-server/src/routes/highlights.ts:736` |
| H98 | N (line 4885) | **N** | `2975_highlights_permanent_lifetime` absent from `artifacts/api-server/src/lib/capability/production-applied-migrations.json` |
| H99 | W (line 815) | **W** | "NO caller" FALSE — `artifacts/api-server/src/routes/highlights.ts:1285`; W stands, `RANKING_FACTORS_MEASURED_ON_ROW` is `["recency"]` alone |
| H100 | W (line 816) | **W** | "No pin column, no pin route, no pin in the client" all FALSE; §12's order is now RENDERABLE on all four reads (this lane shaped the last two) but APPLIED on two — profile `:996#pinnedFirst`, active `:1285` |
| H101 | W (line 817) | **W** | "Unreachable" FALSE — diversity runs inside `:1285`; `UNRESOLVABLE_DIVERSITY_DIMENSIONS` is still `["activity","trip"]` |
| H102 | N (line 463) | **N** | no DO THIS / SAVE / ADD TO TRIP / VIEW PLACE / ASK / MEET verb anywhere in `artifacts/api-server/src/routes/highlights.ts` |
| H103 | W (line 856) | **W** | `highlights_feed_bounded_enabled` reads `false` in the capture's `flags` block |
| H107 | N (line 1259) | **N** | the repo-wide grep now returns 3 lines in 2 files, all of them a metric NAME and the comment that asserts the absence (`artifacts/api-server/src/services/memory/memoryKernelMetrics.ts:88-89`) — no feature |
| H108 | N (line 1260) | **N** | same grep, same three lines, no feature |
| H112 | W (line 1269) | **W** | `privacy_eligibility` still a gate, not a weight — unchanged |
| H113 | W (line 1270) | **W** | unchanged |
| H114 | W (line 1271) | **W** | unchanged; §Q.7's half still open |
| H120 | W (line 3052) | **W** | `memory_evidence` ABSENT from the capture's `tables` |
| H130 | W (line 1315) | **W** | "2710 unapplied" FALSE — `2710_memory_command_kernel_tables` IS applied; ceiling is `memory_kernel_enabled: false` |
| H131 | W (line 1316) | **W** | declared and dispatched — `artifacts/api-server/src/routes/memories.ts:1711` via `commandTypeForPatch` |
| H132 | W (line 1317) | **W** | `guardLifecycle` runs flag-independently — `artifacts/api-server/src/services/memory/MemoryDomainService.ts:355` |
| H133 | W (line 1318) | **W** | "§21's five-step deletion lifecycle does not exist" FALSE — `artifacts/api-server/src/routes/memories.ts:1938` |
| H136 | W (line 1321) | **W** | `artifacts/api-server/src/routes/memories.ts:2010#commandType: "ADD_MEDIA"` |
| H137 | W (line 1322) | **W** | `artifacts/api-server/src/routes/memories.ts:2102#commandType: "REMOVE_MEDIA"` |
| H138 | W (line 1323) | **W** | `artifacts/api-server/src/routes/memories.ts:2298` selects ADD_PERSON, authorized at `MemoryDomainService.ts#authorizeParticipantCommand` |
| H139 | W (line 1324) | **W** | same site selects REMOVE_PERSON |
| H140 | W (line 1325) | **W** | `commandTypeForPatch` — `artifacts/api-server/src/services/memory/MemoryDomainService.ts:261` |
| H141 | W (line 1326) | **W** | same selector |
| H142 | W (line 5689) | **W** | §T's two gates unchanged; this lane touched neither |
| H143 | W (line 5690) | **W** | same pair, same gates |
| H144 | W (line 5692) | **W** | `routes/stories.ts` is not this lane's file; the undeclared reason at `artifacts/api-server/src/lib/memoryCommandBus.ts:400` re-read and still accurate |
| H145 | W (line 5691) | **W** | the hide crosses the boundary behind two gates; the un-hide still does not — this lane's subject, and no move |
| H146 | N (line 1331) | **N** | census reason ("2720, unapplied") FALSE; the real reason is already in the code at `artifacts/api-server/src/lib/memoryCommandBus.ts:412` and still holds |
| H175 | W (line 818) | **W** | "receipt table is 2710, unapplied" FALSE; no receipt is written because the flag is FALSE |
| H178 | W (line 3459) | **W** | field-level CAS on `state` only — `artifacts/api-server/src/routes/memories.ts:1751` |
| H189 | W (line 3924) | **W** | unchanged |
| H190 | W (line 3925) | **W** | media bytes still publicly served |
| H192 | W (line 821) | **W** | unchanged |
| H198 | W (line 2616) | **W** | `requireUser` returns the SERVICE client (`artifacts/api-server/src/lib/http.ts:293`); 23 `getServiceClient()` sites in `memories.ts`, 15 in `highlights.ts` |
| H200 | W (line 822) | **W** | unchanged |
| H201 | W (line 823) | **W** | line 823's *"unenforced until 2721 lands"* is FALSE (2721 applied); the SAME statement's surviving clause is the whole W — the ladder still does not reach a Memory's `location_lat` / `location_lng`. NOT a flag verdict |
| H202 | W (line 3930) | **W** | unchanged |
| H208 | W (line 588) | **W** | the cited symbol `gemProtectMemoryRow` is GONE from `routes/memories.ts` (dead citation); `artifacts/api-server/src/lib/memoryLocationPrecision.ts:213#canSeeExactLocation` exists and has NO non-test caller. That, not a flag, is the W |
| H210 | W (line 825) | **W** | unchanged |
| H254 | W (line 1468) | **W** | "eight unapplied migrations" FALSE — 2338/2339/2710/2711/2720/2721/2722/2723/2730 are ALL applied; 2975/2992/2993/2994 are not |
| H255 | W (line 1469) | **W** | "no correction path" FALSE (`commandTypeForPatch`); default visibility is still `friends_only` (`docs/migrations/0067_memories.sql:12`) |
| H256 | W (line 1470) | **W** | MERGE/SPLIT still undeclared, `memory_episodes` ABSENT from the capture |
| H257 | W (line 1471) | **W** | "2723 is unapplied" FALSE — pin is live; the audience-specific projection and the reorder are still absent |
| H258 | W (line 2151) | **W** | "§15's retrieval is still 2730" FALSE — 2730 is applied; W stands on H112/H113/H114 |
| H259 | N (line 1473) | **N** | same grep as H107/H108 |

**Moves: none.** I measured no row out of its bucket.

---

## BUILT

| path | what | rows it bears on |
|---|---|---|
| `artifacts/api-server/src/routes/highlights.ts` | §19 envelope parity on `DELETE /highlights/:id/archive` (`:2128`); the §17 boundary-gap warning, kernel-gated, after the write (`:2144`); two imports sharing an existing line (`:69`). **LINE-NEUTRAL: the file is 2856 lines before and after, and `router.delete("/highlights/:id/archive"` is still on line 2120.** | H145, H175, H51 — none moves |
| `artifacts/api-server/src/test/highlightsApiUnhideBoundary.test.ts` | NEW. 9 cases: envelope parity across all four writes on the aggregate, the un-hide still crossing no boundary, §23 refusal parity between the two halves of Archive, and the warning present-with-kernel-on / absent-with-kernel-off / absent-on-refusal | H145, H175 |
| `artifacts/api-server/src/routes/highlights.ts` | **Two raw-row list reads, shaped.** `GET /highlights/archived` (`:2182`) answered `{ highlights: rows }` — raw PostgREST rows — and `GET /highlights/following-feed` (`:2837`) pushed author + counts and no lifetime fields. Both now call the same `describeLifetimeFields` the other two list reads call (`:1103`, `:1353`). Reported by HM-CLIENT, re-measured here first. **Also line-neutral** | H100 (renderability half), H46, H51 — none moves. H94–H97 are already `C` and are untouched |
| `artifacts/api-server/src/test/highlightsApiListShaping.test.ts` | NEW. 6 cases across all four list reads, asserting the five §3.5/§5 keys AND their provenance, `pinnedAt` round-tripping a real timestamp, and `lifecycleState === "HIDDEN"` on an archived row — the one row whose derived state is not ACTIVE, so a route that hard-coded ACTIVE fails here and nowhere else | H100, H46, H51 |
| `artifacts/api-server/package.json` | registers both new tests in the curated `test` script (required by `npm run check:test-registration`) | — |

### The two list-read defects, stated before the fix

`GET /users/:id/highlights` and `GET /highlights/active` have ended their map with
`...describeLifetimeFields(h, <projection>.classProjected)` since that helper existed. The
other two reads did not. Measured consequence on the archive screen: **`pinnedAt` is
`undefined` even when `pinned_at` is populated**, and no lifetime or lifecycle field is
readable at all, because the payload is snake_case and carries no provenance.

HM-CLIENT deliberately did NOT fall back to reading the snake_case columns, and that
refusal is the right call: without `lifetimeProvenance` a client cannot tell *"the owner
chose LIVE"* from *"nobody assigned a class"* from *"this deployment cannot hold one"*, so
the fallback would invent a distinction only the server can make. That is why the fix is on
this side and why the test asserts **provenance**, not just the value — a suite checking
only `lifetimeClass` would pass against a route emitting `null` for all three cases.

**This does not move H100.** §12's pinned order is now RENDERABLE on all four surfaces; the
server still APPLIES it on two (profile `:996`, active `:1285`), and the following-feed
stays deliberately unranked because its `created_at` cursor is derived from the last row of
the page — asserted at `artifacts/api-server/src/test/highlightFeedRanking.test.ts:276`,
which I did not weaken. Renderable is not ordered, and grading the row on the half I fixed
would be scoring.

### The line-number trap, which I fell into and then fixed

`routes/highlights.ts` is cited **by line number** from `census-highlights-memories.md`
in roughly thirty places. My first two commits added a two-line import and expanded the
handler's header comment, which shifted every one of them: `check:doc-citations` and
`src/test/docCitations.test.ts` went RED, naming `:100#archived_at`, `:265#function`,
`:332#applyLocationPrecision`, `:982#archived_at`, `:1919#router.delete(`,
`:2120#/highlights/:id/archive` and about two dozen more. **I had not measured that check
before editing.**

The fix was to make the change occupy exactly the lines it replaced: the two new named
imports share the existing `sendMemoryCommandRejection,` line; the header comment stays
exactly 13 lines and the handler exactly 27; the long determination moved out of the
header into the test file and this report, where it costs nobody a line number; and two
`sendError(…); return;` pairs are joined, which is the one-line form this file already
uses for `if (!UUID.test(id))`. The file is **2856 lines, exactly as it was**, all 24
named anchors re-verified individually, and `check:doc-citations` is green. Behaviour is
unchanged — red-first was re-measured against the final handler (3 of 9 fail without the
envelope check and the warning, 9 of 9 with them).

The rule this lane learned, for anyone editing a heavily-cited file: **measure
`check:doc-citations` BEFORE the edit, and spend no net lines above the last cited
anchor.**

The test file deliberately **does not name** `memory_domain_events` / `memory_event_outbox`
/ `memory_command_receipts`. `check:memory-table-ownership` requires any file naming one to
be classified in `lib/memoryTableOwnership.ts`'s `KERNEL_SIDE`, and that file is
HM-SERVER's. Instead the fixture seeds no kernel table and the assertion is
`kernelTablesTouched(app)` — every `memory_*` key the fake materialised — which is
strictly stronger than a four-name list, because a FIFTH artifact added later is caught by
it.

---

## NEEDS FROM HM-SERVER

**One change, two halves. Neither half alone is safe:** declaring the type without the SQL
arm makes every un-hide a `MEMORY_COMMAND_UNKNOWN_TYPE` rejection the moment
`memory_kernel_enabled` is turned on
(`artifacts/api-server/src/migrations/2993_highlight_command_boundary.sql:386`).

**1. `artifacts/api-server/src/lib/memoryCommandBus.ts`** — declare the EXT command, with
the four total maps kept total:

```ts
// in MEMORY_COMMAND_TYPES, beside HIDE_HIGHLIGHT:
"UNHIDE_HIGHLIGHT",   // EXT — highlights.archived_at = NULL. §17 names
                      //       HIDE_HIGHLIGHT and no inverse, and §17's first
                      //       sentence is unconditional over canonical writes;
                      //       same reason UPDATE_MEMORY is declared. §5 puts
                      //       HIDDEN inside the reversible cycle.

COMMAND_SUBJECT.UNHIDE_HIGHLIGHT    = "highlight";
COMMAND_CAPABILITY.UNHIDE_HIGHLIGHT = "owner";
COMMAND_EVENT.UNHIDE_HIGHLIGHT      = "highlight.hidden";  // §17 lists no
                                     // highlight.unhidden; the payload
                                     // discriminates, exactly as
                                     // UNPIN_HIGHLIGHT does on highlight.pinned
```

**2. `artifacts/api-server/src/migrations/2993_highlight_command_boundary.sql`** (unapplied
everywhere, so an in-place edit is legitimate — the file's own header records that 2994 was
edited in place for the same reason). Two edits:

```sql
-- line 386, the type gate:
IF v_type NOT IN ('PIN_HIGHLIGHT','UNPIN_HIGHLIGHT','HIDE_HIGHLIGHT','UNHIDE_HIGHLIGHT') THEN

-- a new arm in the APPLY CASE, beside 'HIDE_HIGHLIGHT':
WHEN 'UNHIDE_HIGHLIGHT' THEN
  UPDATE public.highlights SET archived_at = NULL WHERE id = v_highlight_id;
  v_event_type := 'highlight.hidden';
  v_result := jsonb_build_object('id', v_highlight_id, 'archived_at', NULL);
  v_to := CASE
    WHEN v_pinned  IS NOT NULL THEN 'PINNED'
    WHEN v_expires IS NOT NULL AND v_expires <= v_now THEN 'EXPIRED'
    ELSE 'ACTIVE' END;
```

and the payload must carry `command_type` and a `hidden` boolean so the two directions are
distinguishable on one event name — the shape the `UNPIN_HIGHLIGHT` arm already writes
(`2993_highlight_command_boundary.sql:486-497`).

**3. One assertion WILL go red and must be widened, not deleted.**
`artifacts/api-server/src/test/memoryCommandBus.test.ts:151` is
`assert.deepEqual(extensions, ["UPDATE_MEMORY"])` — where `extensions` is every declared
command that is NOT one of §17's seventeen names. `UNHIDE_HIGHLIGHT` is a second
extension, so that line becomes `["UNHIDE_HIGHLIGHT", "UPDATE_MEMORY"]` (sorted). The
assertion is the one that stops the vocabulary drifting, so it must be widened by NAME and
never relaxed to a length or a predicate.

**4. The client's contract for the inverse, forwarded verbatim from HM-CLIENT and
honoured in the design above.** If `UNHIDE_HIGHLIGHT` ships as a command, the route the
client wants is `POST /api/highlights/:id/unhide`, `Idempotency-Key` 1-200 chars, body
`{}`, answering `200 { id, archivedAt: null, lifecycleState, lifecycleProvenance }` with
409 / 403 `feature_disabled` / 404 / 503 for the rest. Two requirements I endorse after
measuring them:

* **`lifecycleState` MUST travel with its `lifecycleProvenance`.** §5 makes HIDDEN →
  EXPIRED legal and HIDDEN → ACTIVE not, so un-hiding a Highlight whose `expires_at` has
  passed lands on EXPIRED. A client cannot compute that without a second copy of
  `describeHighlightLifecycle`, which is the duplicated vocabulary this codebase keeps
  refusing. My `v_to` sketch in item 2 already derives exactly this.
* **`DELETE /highlights/:id/archive` must keep working until the client migrates** — the
  restore button on `app/highlights/archived.tsx` is wired to it and tested. Nothing in
  this lane removes or changes that endpoint's contract: the 200 body is still
  `{ id, archivedAt: null }`, the 404s are unchanged, and the ONLY new refusal is a 400
  for an `Idempotency-Key` outside 1-200 characters, which a client that sends no key or
  a sane key never sees. **I am not asking for it to go.**

**5. A hazard I hit, passed on before you hit it.** `src/lib/memoryCommandBus.ts` is cited
BY LINE NUMBER from this census (`:279#assertLifecycleTransition` at census line 1317,
`:412` at 851, `:578`/`:440` at 818, and more), exactly as `routes/highlights.ts` is.
Inserting `"UNHIDE_HIGHLIGHT",` into `MEMORY_COMMAND_TYPES` and four map entries below it
will shift every one of them and turn `check:doc-citations` red — which is how my own first
two commits broke ~30 anchors. Either spend the lines on EXISTING lines, or repoint the
citations in the same change (you can edit the census; this lane cannot). **Measure
`npm run check:doc-citations` before and after.**

**When those land**, `DELETE /highlights/:id/archive` becomes a five-line change on my
side: swap the direct write for `dispatchMemoryCommand({ commandType: "UNHIDE_HIGHLIGHT",
memoryId: null, highlightId: id, … , legacy: <the current write, verbatim> })`, delete the
warning, and repoint
`artifacts/api-server/src/test/highlightsApiUnhideBoundary.test.ts`'s case 2 (which is
written to go RED the day the inverse is declared, precisely so nobody has to remember).
That change must be line-neutral too, for the reason in item 5 — the handler currently sits
at lines 2120-2146 and `router.get("/highlights/archived"` must stay on 2157.

**Two owner decisions this lane surfaces and does not take:**

* **Neither half of Archive guards its transition.** `POST …/archive` on an already-hidden
  row re-stamps `archived_at` and emits a SECOND `highlight.hidden`; `DELETE …/archive` on
  a live row returns 200 for a transition that did not happen. §5 has no HIDDEN→HIDDEN
  edge. Guarding needs the 2993 arm and the route changed together.
* **§U.1 stands unchanged**: no §18 projection in `projectionRegistry.ts` is keyed on a
  Highlight, so even a correct `highlight.hidden`/un-hide pair rebuilds nothing. Closing
  the command gap does not by itself make the stream useful.

---

## TEST EVIDENCE

All targeted runs carried the env: `SUPABASE_URL=http://127.0.0.1:9
SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test <file>`.

**RED FIRST — the new suite against the tree WITHOUT the route change.** Measured twice:
once before the first commit, and AGAIN against the FINAL line-neutral handler, by
deleting just the envelope check and the warning from it.

```
node --import tsx/esm --test src/test/highlightsApiUnhideBoundary.test.ts
# tests 9
# pass 6
# fail 3
not ok 1 - §19 envelope — the four Highlight writes answer one malformed key the same way
not ok 4 - §18 — an un-hide that leaves highlight.hidden unanswered says so at runtime
```
The three reds, named: `DELETE …/archive refuses a key outside 1-200 characters`
(expected 400, actual 200), `all four writes … give the SAME answer to the SAME malformed
key` (expected 400, actual 200), and `with the kernel ON the successful un-hide warns`
(expected a warning, none logged).

**GREEN — the same suite after the change, on the final tree:**

```
node --import tsx/esm --test src/test/highlightsApiUnhideBoundary.test.ts
# tests 9
# pass 9
# fail 0
```

**The new suite + the §17 boundary suite + the citation corpus, one process, final tree:**

```
node --import tsx/esm --test src/test/highlightsApiUnhideBoundary.test.ts \
     src/test/highlightCommandBoundary.test.ts src/test/docCitations.test.ts
# tests 72
# pass 72
# fail 0
```

**RED FIRST — the list-shaping suite, against the tree WITHOUT the shaping fix:**

```
node --import tsx/esm --test src/test/highlightsApiListShaping.test.ts
# tests 6
# pass 1
# fail 5
not ok 1 - GET /highlights/archived — the owner's archive is shaped like every other list
not ok 2 - GET /highlights/following-feed — the grouped feed is shaped too
ok   3 - the two reads that were already correct are still correct
```
with the failure naming every missing key verbatim: *"the archive read is still emitting
raw rows; missing lifetimeClass, lifetimeProvenance, lifecycleState, lifecycleProvenance,
pinnedAt"*. **Case 3 passing in the same run is the control**: the defect is isolated to
the two named reads, not a suite that cannot see any of them.

**GREEN after the fix:**

```
node --import tsx/esm --test src/test/highlightsApiListShaping.test.ts
# tests 6
# pass 6
# fail 0
```

**Baseline, before any edit** — `src/test/highlightCommandBoundary.test.ts`:
`# tests 20 / # pass 20 / # fail 0`.

**Neighbours, after the change** — `highlightCommandBoundary` + `highlightLifetimeAndPin` +
`highlightFeedRanking` + `highlightsReadFailures` + `highlightsSpecArchitecture` +
`verifyFlowHighlightControls`, one process:

```
# tests 146
# pass 146
# fail 0
```

**Static checks** (from `artifacts/api-server`), all re-run on the FINAL tree:

| check | result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run check:route-auth-gate` | PASS — 166 route files, no state-changing handler verifies its own JWT |
| `npm run check:guard-coverage` | PASS — 122 Supabase-reaching files: 57 guarded, 4 runtime-target-gated, 61 exempt |
| `npm run check:async-handlers` | PASS |
| `npm run check:route-shadowing` | PASS |
| `npm run check:api-prefix` | PASS |
| `npm run check:test-registration` | PASS — my file registered |
| `npm run check:doc-citations` | **PASS** — RED on my first two commits, fixed by the line-neutral rewrite; see the trap above |
| `npm run check:census-integrity` | PASS |
| `npm run check:memory-table-ownership` | **2 problems, both PRE-EXISTING and neither mine** |
| `npm run check:authorization-contract` | **REFUSED — needs a live non-production Supabase credential** |
| `npm run check:write-path-columns` | **REFUSED — same credential** |

`check:memory-table-ownership` was red before this lane: it names
`migrations/2993_highlight_command_boundary.sql` and `test/highlightCommandBoundary.test.ts`
as unclassified in `KERNEL_SIDE`. Neither is modified here. My first draft of the new test
added a THIRD error; the test was rewritten to name no kernel table and the count is back
to the pre-existing 2.

`check:authorization-contract` and `check:write-path-columns` both fail before constructing
any client, on `CI_SUPABASE_PROJECT_REF is empty or not configured`. Re-run with
`KNOWN_PROD_PROJECT_REF` supplied from `.github/workflows/live-db.yml:212` to confirm it is
the credential and not the diff: they still refuse, on `CI_SUPABASE_PROJECT_REF`. This
session has no Supabase credential of any kind.

**One piece of debris I made and cleaned.** Killing the first (now-stale) full-suite run
left `src/lib/__guardCoverageProbe.ts` on disk — a fixture the guard-coverage self-test
writes and deletes in teardown — which made `check:guard-coverage` fail on a file nobody
wrote. Removed; the check is green and the file is not in any commit.

**FULL SUITE** — `npm test`, and I am reporting this exactly as it happened rather than
rounding it up.

Three full runs were started. **None of the three printed a grand total**: each was
terminated by the environment (SIGTERM, `exit=143`) after roughly 45 minutes, before node's
own `# tests / # pass / # fail` summary. What each one DID produce is a per-suite TAP
stream, and that is what I am reporting.

| run | tree | top-level suites reached (of 1416 files) | `^not ok` |
|---|---|---|---|
| 1 | first two commits | 1821 | **1** — `the real corpus — every covered citation resolves and every anchor holds` (`src/test/docCitations.test.ts`), the line-shift defect |
| 2 | after the line-neutral fix | ~1270 before termination | 0 |
| 3 | FINAL tree, all four commits | **1797** | **0** |

Run 3 is the one that matters and it passed **suite 1550 — `the real corpus — every covered
citation resolves and every anchor holds`** — the exact test run 1 failed. Grepped from the
log by name, not inferred.

**What I did NOT verify, stated plainly:** no run reached node's summary line, so I cannot
quote a `# pass` figure for the whole suite, and roughly the last 1% of suites after 1797
went unexercised in run 3. Every suite that DID run in run 3 passed. The targeted runs above
cover this lane's own files exhaustively, and `npm run typecheck` plus nine static checks
are green on the final tree.

---

## NOT DONE AND WHY

**(a) needs another lane's file**

* `UNHIDE_HIGHLIGHT` declared and executed — `src/lib/memoryCommandBus.ts` and
  `src/migrations/2993_highlight_command_boundary.sql`. The whole of the assigned question's
  substantive half. Request above.
* A transition guard on either half of Archive — same two files.
* Classifying `test/highlightCommandBoundary.test.ts` and `migrations/2993_*.sql` in
  `src/lib/memoryTableOwnership.ts`'s `KERNEL_SIDE`, which is what
  `check:memory-table-ownership` asks for.
* **Repointing the census citations into `routes/highlights.ts` is NOT needed** — the
  change is line-neutral, so nothing needs repointing. Recorded here because the obvious
  alternative fix was to edit `census-highlights-memories.md`, which is a forbidden file
  for this lane, and the line-neutral rewrite exists precisely to avoid needing it.
* H100 / H99's remaining surfaces: a CLIENT flow is the required consumer for a curated,
  reorderable Highlight rail, and the client is another lane's file. `GET
  /highlights/following-feed` is deliberately unranked and that decision is asserted at
  `artifacts/api-server/src/test/highlightFeedRanking.test.ts:276` — I did not weaken it.
* H144 `PUBLISH_HIGHLIGHT` lives in `src/routes/stories.ts`.

**(b) needs unapplied schema — named**

* `2993_highlight_command_boundary.sql` — adds `highlight_id` to the four kernel tables.
  Unapplied everywhere, absent from the 2026-09-22 capture. Until it applies, NO
  `highlight.*` event row can be written at all, so H142/H143/H145/H51 cannot move
  whatever the code does.
* `2994_memory_relations_and_outbox_consumer.sql` — `memory_relations` and the outbox
  claim/ack functions. Unapplied (H27, H161).
* `2975_highlights_permanent_lifetime.sql` — `expires_at` is still `NOT NULL`, so H98's
  PERMANENT class is structurally impossible.
* `memory_evidence` and `memory_episodes` have no `CREATE TABLE` in this tree at all
  (H120, H256, and the `RAW_EVIDENCE_PURGED` step of H52's lifecycle).

**(c) needs an external credential / service / device — named**

* **A full `npm test` run to completion.** Three attempts were each terminated by the
  environment at ~45 minutes (`exit=143`, SIGTERM) before node printed its summary. The
  last ~1% of suites past 1797 is therefore unexercised on the final tree. This needs a
  runner that will not reap a long job, not a code change.

* `npm run check:authorization-contract` needs `CI_SUPABASE_PROJECT_REF` plus a live
  non-production Supabase project. Not available in this session.
* Every "deployed verification" claim: `memory_kernel_enabled` is FALSE in
  `20260922-production-schema.json` and I cannot flip it or observe a real kernel run.
  **Everything in BUILT is implementation-verified only.** No traveller has met any of it.
* Whether `memory_derivative_registry` holds any rows on production (H13's residual) is a
  live-data question — **CV**, not a code verdict.

**(d) out of scope**

* H102 / H107 / H108 / H259 — the executable-action surface. Nothing exists; building it is
  a feature, not a correction, and needs a client.
* H198 / H202 — replacing `getServiceClient()` with a user-scoped client on every memory and
  highlight read is a re-verification of every fail-closed branch in two 3000-line routers,
  and §E.5 already ruled the audit-trail half a migration.

---

## STALE EVIDENCE FOUND

Rows whose **LAST-STATEMENT** reason — the one the parser takes, not the first one in the
body — I re-tested at `561a0a7b0` and found **FALSE**. Each was measured, not inferred.
**None moves a verdict**: in every case a different, still-true reason holds the row where
it is, and that reason is given.

**One entry was WITHDRAWN on re-derivation.** I had listed H50 here, quoting *"accepts any
of `draft/published/archived` on PATCH with no transition guard"* from line 383. That is
H50's FIRST statement. Its LAST is line 860, which already says the opposite — *"`assert
LifecycleTransition` … runs on every PATCH regardless of the kernel flag … so an illegal
transition is now refused in production"* — and is accurate. H50 is not stale; my reading
of it was. It stays `W` on the reason line 860 gives.

**The dominant failure mode, named once.** Thirteen of the entries below are the same
mistake: the census says a migration is *unapplied* when it IS applied. Re-verified with
the coordinator's own one-liner against
`artifacts/api-server/src/lib/capability/production-applied-migrations.json` —
**2338, 2339, 2710, 2711, 2720, 2721, 2722, 2723 and 2730 are ALL applied to production;
only 2975, 2992, 2993 and 2994 are not.** In every case the verdict still stands, but for a
DIFFERENT blocker — usually `memory_kernel_enabled` reading false. That distinction is the
point: one is fixed by a flag flip, the other by a migration, and the census currently
points at the wrong one.

| row | the census sentence that is false | what I measured | what now holds the row |
|---|---|---|---|
| H99 | last statement **line 815**: *"No `ranking_score` column (2723) and no route calls it — `routes/highlights.ts` still orders by `created_at`"*; §Q.6 (5461, no verdict cell) restates it as *"has NO caller"* | `artifacts/api-server/src/routes/highlights.ts:1285#rankHighlightRows` — added by commit `69171bb3f` at 16:30 on 2026-09-22, **75 minutes AFTER** the §Q text was committed (`ead1a38e8`, 15:14). The census never came back. | only `recency` of §12's seven is measurable on a `highlights` row (`RANKING_FACTORS_MEASURED_ON_ROW`) |
| H100 | last statement **line 816**: *"No pin column, no pin route, no pin in the client"*; §Q.6 (5462) restates it as *"`pinnedFirst` runs on ONE of the four read surfaces"* | `pinned_at` is on production, `POST /highlights/:id/pin` writes it, two surfaces order on it (profile `:996`, active `:1285`), and after this lane all four EMIT `pinnedAt` | the server still ORDERS on two of four. The following-feed is deliberately unranked — its `created_at` cursor comes from the last row of the page — and `/highlights/archived` orders by `archived_at`. Renderable is not ordered |
| H101 | last statement **line 817**: *"`DIVERSITY_DIMENSIONS` … applied inside `rankHighlights`. Unreachable."* | reached on every `GET /highlights/active` via `:1285` | 2 of 4 dimensions unkeyable — `UNRESOLVABLE_DIVERSITY_DIMENSIONS = ["activity","trip"]` |
| H130, H175 | *"No durable receipt (2710 unapplied)"* / *"The receipt table is 2710, **unapplied**"* | `2710_memory_command_kernel_tables` IS in `production-applied-migrations.json` and all four tables are in the 2026-09-22 capture | `memory_kernel_enabled` is FALSE, so the kernel never runs and no receipt is ever written |
| H133 | *"§21's five-step deletion lifecycle does not exist"* | `artifacts/api-server/src/routes/memories.ts:1938#runMemoryDeletionLifecycle` runs all five, named, on every `DELETE /memories/:id` | `RAW_EVIDENCE_PURGED` runs against `memory_evidence`, which exists nowhere |
| H146 | *"`highlight_resurfacing_preferences` is 2720, unapplied"* | 2720 IS applied, the table IS in the capture, and `setResurfacingControl` (`src/services/highlights/highlightControlWrites.ts:235`) writes it | the reason already corrected IN CODE at `src/lib/memoryCommandBus.ts:412`: the policy's subject is one of four kinds and the event tables carry exactly one of (memory_id, highlight_id) |
| H46 | *"`highlights.lifetime_class` does not exist (2723 unapplied)"* | the column is in the 2026-09-22 capture; 2723 applied 2026-09-15 | PERMANENT is still unstorable (2975) — H98 |
| H208 | *"`routes/memories.ts:87-107` `gemProtectMemoryRow`"* | **the symbol does not exist in that file at all** — a dead citation. The named accessor is `artifacts/api-server/src/lib/memoryLocationPrecision.ts:213#canSeeExactLocation` | it has no non-test caller, and the precision siblings that ARE wired are gated on `memory_location_precision_enabled`, `false` in the capture |
| H21, H31 | *"Missing `source_memory_ids`, `highlight_type`, `lifetime_class`, `lifecycle_state`, `ranking_score`, `reason_codes`, `audience_policy_id`, `presentation_json`, `renderer_version` — 9 of 13"* | four of the nine — `highlight_type`, `lifetime_class`, `lifecycle_state`, `renderer_version` — are on production | six of §3.5's thirteen are still absent, counting `starts_at`, which the row never listed |
| H254 | *"The schema is eight unapplied migrations"* | 2338, 2339, 2710, 2711, 2720, 2721, 2722, 2723 and 2730 are ALL applied | 2975, 2992, 2993, 2994 are not, and the kernel flag is FALSE |
| H255 | *"there is still no correction path"* | `commandTypeForPatch` (`src/services/memory/MemoryDomainService.ts:261`) selects CHANGE_PLACE / CHANGE_VISIBILITY / CONFIRM_MEMORY / UPDATE_MEMORY on PATCH | default visibility is still `friends_only`, not private |
| H257 | *"The projection, the curation, the pin and the reorder do not — 2723 is unapplied"* | 2723 applied; `pinned_at` live; `POST /highlights/:id/pin` writes it; §12 ranking runs on `/highlights/active` | the audience-specific projection (H93) and the reorder still do not exist |
| H258 | *"W stands because §15's retrieval is still 2730"* (§D.11, line 2151) | `2730_memory_derivative_registry` IS applied and the table IS in the capture | H112 / H113 / H114 |
| H13 | *"Test-only; the projections it reads have no registry rows because 2730 is unapplied"* | non-test caller at `src/routes/memories.ts:943`; 2730 applied | SHARED_CREW is declared unreachable in the module itself (`src/services/memory/memorySearchService.ts:118`) — a bounded service that cannot serve one of its three namespaces |
| H93 | last statement **line 855**: *"`highlight_sources` … is migration 2722, written, **unapplied**, and has no TypeScript writer"* | 2722 IS applied and `linkHighlightSources` writes it — the same fact §Q.4 moved H32 to `C` on. §Q.6 (5459, no verdict cell) already restates the reason correctly | `POST /highlights` still accepts a sourceless create (`sourceMemoryIds` is `.optional()`, `src/routes/highlights.ts:736`) |
| H103 | last statement **line 856**: *"`highlights_feed_bounded_enabled` (migration 2339), which is **not in the applied list**"* | 2339 IS applied, so the flag ROW exists. §O.3 (4858, no verdict cell) already corrects this | the flag reads `false` in the 2026-09-22 capture, and it gates EXACTLY this row's subject — `src/routes/highlights.ts:2668` makes the `.limit()` conditional on it, so the following-feed is genuinely unbounded on production |
| H201 | last statement **line 823**: *"it is unenforced until 2721 lands"* | 2721 IS applied and `highlight_projection_policies` is in the capture; §P.2 wired the writer | the SAME statement's other clause survives and is the whole W: *"It does not reach a Memory's `location_lat` / `location_lng`"* |
| H12 | *"the two that would build and rank a Highlight are not [wired]"* | ranking IS wired (`:1285`) | no service builds a Highlight: `POST /highlights` still takes a client `mediaUrl` with an optional source list |
| H107, H108, H259 | *"a repository-wide grep … returns nothing at all — not a fixture, **not a comment**"* | the grep now returns 3 lines in 2 files — a metric name and the comment that ASSERTS the absence (`src/services/memory/memoryKernelMetrics.ts:88-89`, `src/test/memoryKernelMetrics.test.ts:181`) | the substance is unchanged: no do-again feature exists. Recorded only because the row's evidence is stated as an exact grep result |
| §U.2 (prose, not a row) | *"Inventing `UNHIDE_HIGHLIGHT` … would have put a command in the vocabulary that §17 does not define, which is the opposite of what a command boundary is for"* | `MEMORY_COMMAND_TYPES` already carries `UPDATE_MEMORY` as an EXT command declared for exactly that reason (`src/lib/memoryCommandBus.ts:318`) | the argument is inconsistent with the tree's own precedent; see THE ASSIGNED QUESTION above |

**A measurement I checked and did NOT turn into a defect.** Neither half of Archive
invalidates the Compass feed cache, while `DELETE /highlights/:id` and the two control
writes do. I looked for the leak and there is none: no Compass surface reads
`public.highlights` — the only `highlights` occurrence under `src/compass/` is a comment in
`MemoryCompassTools.ts:22` recording that the grep finds nothing. Reporting it as a defect
would have been a plausible sentence with no fact under it.
