# Portava Telegraph — Requirement Census (v1 and v1.1)

| Field | Value |
| --- | --- |
| **Specs** | `docs/specs/Portava_Telegraph_Design_Architecture_Developer_Spec_v1.txt` (30 sections) and `..._v1_1.txt` (32 headings). The `.docx` originals are authoritative and were extracted and compared; see §2. |
| **Tree censused** | `claude/portava-continuation-uqta94`, working tree at `ebe72b34`. Sibling agents committed the shared tree during this pass (HEAD is now `feedfb0a`); `git diff ebe72b34..feedfb0a` over every path cited below touches exactly one file — `routes/safeReturn.ts`, +43 lines, an unrelated Passport contact projection appended after `:817` plus two imports — so every verdict holds at HEAD, with that file's post-`:26` citations renumbered. Censused state is **main**: open PRs #460 and #472 are read but never scored into a bucket; see §9. |
| `head_commit` | `1fe72289b` — RE-DECLARED 2026-09-15 at the squash merge of PR #482. The previous value was `80a8d655a`, a commit on the pre-merge branch. **The squash made it an orphan**: it still exists in a clone that fetched the branch, but it is on no line of history leading to `main`, and `check:census-freshness` refuses an orphan because the check would pass locally and fail in a fresh clone. Nothing about this census was re-measured and NO verdict moves — `1fe72289b` is the commit its previous declaration's tree became, so zero counted files have changed since it. The prior declaration and its reasoning follow. — RE-DECLARED 2026-09-14 by §23, replacing `42aeac38`. §23 re-derived T70 (`W → C`) and recorded fourteen membership gates that moved no verdict by §20.6's own rule. Nine counted files changed. It does **NOT** certify the other 229 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `42aeac38` — DECLARED 2026-09-11. It **starts a clock; it does not certify a past.** Read the next row before quoting it. |
| **What that declaration does and does not say** | `42aeac38` is #476's squash — where this document itself reached `main`. The 451 verdicts were taken at working tree `ebe72b34` (and re-checked at `feedfb0a`), both of which squash-merge orphaned: they resolve in no clone, so **nobody can diff `ebe72b34..42aeac38`, and this declaration does not claim that interval was empty.** What it claims is mechanically checked: `git diff --name-only 42aeac38..HEAD` over the 26 paths in `CENSUS_SCOPE["census-telegraph.md"]` returns **0 files**, and from here any change to one of them ages this census. Before it, `check:census-freshness` reported this document as CANNOT BE CHECKED — the weakest of the three states. FRESH means *no counted file has moved since `42aeac38`*; it does **not** mean the rows were re-read, and none has been. **The scope deliberately excludes `src/scripts/` and `src/test/`**, which supply 40 of this census's 84 resolved citations: those are the guards and suites it used as EVIDENCE, not the surface it measures, and scoping them would age Telegraph on every unrelated lane's guard work until someone switched the check off. Declared by the Trips lane while recounting the sibling census; if the Telegraph lane disagrees, reverting costs only the check. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a file:line that was opened and read. Matches `census-sensing.md` and `census-wall.md`. |
| **Database** | Not queried. Storage facts are the ones supplied as ground truth — **independently corroborated in-tree** by `artifacts/api-server/baseline/20260907_production_tables.txt`, committed during this pass, which lists exactly seven Telegraph tables (`message_reports`, `message_requests`, `message_thread_members`, `message_threads`, `message_translations`, `messages`, `thread_reports`) and contains no `unsent` column anywhere. |
| **Prior census** | **None. Telegraph has never been censused.** There is no earlier number to agree or disagree with; this is the first. |

Backend paths are relative to `artifacts/api-server/src/` unless prefixed
`travel-buddy-standalone/`, `docs/` or `pr/472:`.

---

## 1. Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements) — v1.1** | **451** |
| — of which shared with v1 | 378 |
| — of which v1.1-only (§30A Addendum + §31) | 73 |
| BUILT-AND-CORRECT | **209** |
| BUILT-BUT-WRONG | **176** |
| NOT-BUILT | **51** |
| CANNOT-VERIFY | **3** |
| **CONSTRUCTED%** = (209+176)/451 | **85.4 %** |
| **CORRECT%** (raw) = 209/451 | **46.3 %** |
| **CORRECT% (spec-attributable)** = 0/451 | **0.0 %** (rows citing this spec; the rest are attribution-UNKNOWN — §4) |
| CANNOT-VERIFY share | 3 / 451 = 0.7 % |

> **RESTATED A THIRD TIME 2026-09-12 BY THE INTEGRATOR, from the rows and not by
> addition: 149 → 209 CORRECT, 183 → 176 WRONG, 98 → 51 NOT-BUILT. CONSTRUCTED
> 73.6 % → 85.4 %, CORRECT 33.0 % → 46.3 %.** Three Telegraph lanes worked in
> three separate worktrees, none able to see the others, and each closed with a
> tally of the WHOLE document as it saw it: §10 (§1–§11) at C=158 W=165 N=110,
> §11 (§12–§22) at C=123 W=184 N=121, §12 (§23–§31) at C=124 W=171 N=134.
> **Those three numbers are not added and adding them would be nonsense** — each
> counts the entire census, so any two of them overlap almost completely. The
> figures above are `check:census-integrity`'s count of the merged rows under
> last-statement-wins, cross-checked against an independent tallier that agrees
> exactly: **C=209 W=176 N=51 X=3 across 439 verdict rows**, the remaining 12 of
> 451 being requirements this census states in prose rather than in a verdict
> table. Each lane's closing line stays at the end of its own section as the
> record of what that lane measured; **this paragraph is the document's last
> statement and the one to quote.**
>
> **The v1 / v1.1-only split table beneath this one is STILL NOT restated** and
> still reads 86 / 12 / 135 / 37 / 154 / 24. No lane attributed its moves to the
> two versions, so splitting 209 across them would be an invention. Read the
> split as describing the census before §10, §11 and §12; the four numbers above
> describe it now.
>
> **What this number is not.** It is a BRANCH census: verdicts read against
> `claude/sweet-fermat-fmx7up`, which is not merged, not deployed and not flag
> enabled. Migrations 2810–2813 exist in no database and every flag they add is
> seeded FALSE, so a large part of the 176 W is capped there and cannot move
> without the owner's deploy. On every live deployment today, reported content is
> still destroyed when its author deletes it, and every message request still
> carries no origin.

Scored against **v1 alone** and against the **v1.1-only** addendum separately:

| Measure | v1 (378) | v1.1-only (73) | v1.1 total (451) |
| --- | --- | --- | --- |
| BUILT-AND-CORRECT | 86 | 12 | 98 |
| BUILT-BUT-WRONG | 135 | 37 | 172 |
| NOT-BUILT | 154 | 24 | 178 |
| CANNOT-VERIFY | 3 | 0 | 3 |
| CONSTRUCTED% | 58.5 % | 67.1 % | 59.9 % |
| CORRECT% | 22.8 % | **16.4 %** | 21.7 % |

The two versions score similarly on *construction* and differ on *correctness*,
and the reason is worth stating: the v1.1 addendum is largely a list of
production concerns for which this repository has a **partial analogue built
for some other programme** — a media pipeline, a notification taxonomy, a
device registry, a trust system, a deletion ledger. Those analogues earn
BUILT-BUT-WRONG in volume (37 of 73) and BUILT-AND-CORRECT rarely (12 of 73).
The addendum is 67 % constructed and 16 % correct: almost everything it asks
for has something nearby that is not quite it.

**CANNOT-VERIFY is only 3.** That is unusually low against the sibling censuses
(the Wall's was 9 of 205) and it is not a shortcut: Telegraph's gaps are
overwhelmingly hard absences — a table that is not in the schema, a route that
is not registered, a tool name that returns nothing — and those are decidable
by reading. Only three requirements genuinely need a device or a runtime.

### The one-paragraph reading

**Portava has a competent, hardened messenger. It does not have Telegraph.**
Direct and group threads, message requests, blocking, per-recipient
translation, media messages, SSE realtime with cross-instance HMAC-signed
broadcast, calls, mentions, E2EE key exchange, meetup polls with RSVP, and an
in-thread AI suggestion tray that converts conversation into confirmed plans —
all of that exists, is read, and is largely correct. What is missing is the
part of the specification that makes Telegraph *Telegraph*: the Shared Context
Rail (§3), Nearby & Available (§4), the universal share contract with
revocation (§5), the four-state delivery lifecycle and unsend (§7),
Coordination Mode (§9), the message sequence and outbox (§12–§13), history
windows (§14.3), the content drawer and object-aware search (§6.4, §21), and
the entire v1.1 production-completion addendum. The messenger is a solid
*substrate* for the spec and a small fraction of its *content*.

### Three findings that outrank the percentages

1. **A group-add reads the whole back history.** `GET /threads/:threadId/messages`
   (`routes/messaging.ts:1577-1585`) filters on `thread_id` and active
   membership and **nothing else** — there is no `joined_at` bound, no
   `visible_from_sequence`, no history window of any kind. `syncTripChatMembers`
   (`services/groupChatSync.ts:9-13`) adds every newly-accepted trip member to
   the trip thread, and that member can immediately page back through every
   message sent before they joined. §14.3 and §29 both forbid exactly this.
   This is a live privacy divergence, not a missing feature.
2. **`saved_messages` is write-only.** Both client surfaces offer "Save"
   (`travel-buddy-standalone/app/messages/[id].tsx:2227`,
   `src/components/GroupChatScreen.tsx:1064`), the server persists it
   (`routes/messaging.ts:2691`) — and **nothing in the repository ever reads the
   table back.** Settled by reading call sites, not by grepping `from("…")`:
   the only other reference anywhere is the account-deletion cascade
   (`lib/deletionDispositions.ts:432`). There is no saved-messages screen and no
   route. §10.2's "save as a private Memory draft" persists into a hole.
3. **`message_reports` and `thread_reports` are dead tables.** The ground-truth
   scan was right and this census can say why: both report handlers write to the
   **unified `reports` table** instead (`artifacts/api-server/src/routes/messaging.ts:3855#router.post('/threads/:threadId/report', async (req, res) => {` for threads,
   `:2708` for messages). The two legacy tables have no writer *and no reader*
   anywhere in application code — their only appearances are the RLS disposition
   ledger (`scripts/rlsDispositions.ts:310,456`), the frozen-migration list
   (`scripts/frozenLegacyFiles.ts:45-46`), the deletion cascade
   (`lib/deletionDispositions.ts:370,441`) and generated types. Two of
   production's seven Telegraph tables are orphans.

---

## 2. The superset claim, tested mechanically

Migration `2325_telegraph_unsend_before_seen.sql` (**in open PR #472 — not on this branch**, per `merge-and-migration-collision-audit.md`), lines 8-10, asserts:

> *"Both Telegraph specification versions (v1 and v1_1 — v1_1 is a strict
> superset of v1 and its shared body is byte-identical)…"*

**The claim holds. It is exactly true, at both the `.txt` and the authoritative
`.docx` level, with no whitespace normalisation required.**

### 2.1 Evidence

`.txt` — v1 is 562 lines; v1.1 is 664. The first 562 lines of v1.1 are the
whole of v1, byte for byte:

```
md5sum Portava_Telegraph_Design_Architecture_Developer_Spec_v1.txt
  → 0cc57775bc736be2f2fb02c2a46f8832
head -n 562 Portava_Telegraph_Design_Architecture_Developer_Spec_v1_1.txt | md5sum
  → 0cc57775bc736be2f2fb02c2a46f8832
diff v1.txt <(head -n 562 v1_1.txt)   → empty
```

`.docx` — **the authority**. Both `word/document.xml` payloads were extracted,
split on `</w:p>`, tag-stripped and HTML-unescaped. v1 yields 563 paragraphs,
v1.1 yields 665:

```
prefix identical (b[:len(a)] == a): True
first divergence within common length: none
```

So the shared body is byte-identical in the originals too, and v1.1 adds
**102 paragraphs** appended after v1's last one. The `.docx` authority clause
never had to be exercised, and the two `.txt` transcriptions were separately
verified to be identical to their `.docx` sources after whitespace
normalisation (both: `TXT == DOCX: IDENTICAL`).

### 2.2 Consequence for this census

The claim being true is what licenses a single census document. Everything in
§§1–30 of v1 is required by both versions verbatim, so those verdicts are
version-independent. The v1.1-only requirements are flagged **`1.1`** in the
table and are all in §30 Addendum and §31.

### 2.3 The section count — briefed as 30 / 32, and the brief is right, with a caveat

Sibling censuses found their briefed section counts wrong. This one is
**correct as a count**: v1 has exactly 30 top-level numbered headings, v1.1 has
exactly 32.

But v1.1's numbering is **broken**. Its headings run 1…30, then **30 again**,
then 31:

```
519: 30. Definition of Done              ← v1's last section
564: 30. Production Architecture Completion Addendum   ← v1.1 addendum, ALSO numbered 30
658: 31. Updated Architecture Summary
```

There are two §30s. Anything citing "Telegraph §30" is ambiguous between
*Definition of Done* and the *Production Architecture Completion Addendum*.
This census disambiguates by writing **§30-DoD** and **§30A** (with §30A.1 …
§30A.20 for its subsections), and reserves §31 for the summary.

---

## 3. Denominator: how 451 was counted

One requirement = one independently testable assertion — something that could
be **falsified by reading this tree**. The rule, applied identically to both
versions and matching the sibling censuses:

- **A bullet asserting a required property, behaviour or prohibition = 1.**
- **A table row naming a required artifact, condition or behaviour = 1.**
  §12's eighteen table rows are eighteen; §19's six priority rows are six;
  §22's seven control rows are seven; §26's ten RLS cases are ten.
- **A named enumeration of artifacts in a code block = 1 each.** §6.2's thirteen
  message kinds, §8.1's fourteen native actions, §13.1's eighteen commands,
  §13.2's eighteen events, §18.3's eight Compass tools. These are lists of
  things that must exist, and they are *differently* satisfied — `SEND_MESSAGE`
  exists and `CREATE_COORDINATION_SESSION` does not — so collapsing them would
  destroy the information the census exists to produce.
- **A declared TypeScript interface = 1 for the contract**, unless a member
  carries independent enforcement, in which case it counts separately. §14.1's
  ten `ConversationCapabilities` booleans are ten, because each names a distinct
  authorization decision. §4.1's `AvailabilitySignal`, §5.1's
  `TelegraphShareable`, §12.1's `Message`, §15.1's `LocationShare` and §18.1's
  `MessageTranslation` are one each.
- **A named phase, projection, test family or SLO = 1.** §25.2's nine migration
  phases, §24's six projections, §27.2's twelve adversarial fixtures, §28's
  nine metrics.
- **Narrative, rationale, ASCII mockups and diagrams = 0.**

### Not counted, and why

- **The Document Map** (six Part rows) is navigational. 0.
- **§2.1's and §2.2's ASCII screen mockups** are concept art. §2.1 contributes
  only its stated rule ("the inbox is not a generic notification feed"); §2.2
  contributes only the conversation-header requirement, because its other four
  regions (Shared Context Rail, Coordination Panel, Message Stream, Composer)
  each own a section where they are counted. Merged, not double-scored.
- **The Primary Invariant** ("Telegraph must never invent or silently mutate
  canonical truth owned by Trips, Plans, Events, Memories, Buddy, Safety, Map")
  is restated as §29's *"No direct mutation of canonical Trip/Plan/Event/Buddy
  terms from message prose"* and again in §23 and §30A.19. Counted **once**, at
  T360.
- **Appendix A's twenty schema names** are explicitly *"architectural names, not
  permission to create duplicate tables if equivalent canonical structures
  already exist."* A list the spec itself declines to require is not a
  requirement. Appendix A contributes exactly **1** — its actual directive,
  *"Use existing repository naming conventions where established."*
- **Appendix B's T0–T8 PR breakdown** is process. It is not falsifiable from a
  tree (a tree cannot show how work was sliced). 0.
- **§31** is a restatement of §30A.19 and of the whole spec; counting it in full
  would double-score. It contributes **1** — the five-responsibility
  decomposition it names.
- **Duplicates are merged to a single id.** §7.4's unsend rule (T75) and §27.1's
  *"any eligible recipient seen → unseen-unsend impossible"* (T327) are the same
  assertion, but the §27 instance asks whether a **property test** exists, which
  is a different question, so both are kept and each row says which question it
  answers.

### Per-section contribution

§1 7 · §2 5 · §3 9 · §4 13 · §5 12 · §6 22 · §7 13 · §8 20 · §9 15 · §10 6 ·
§11 15 · §12 21 · §13 38 · §14 17 · §15 7 · §16 7 · §17 12 · §18 14 · §19 8 ·
§20 10 · §21 6 · §22 7 · §23 4 · §24 7 · §25 15 · §26 10 · §27 25 · §28 9 ·
§29 15 · §30-DoD 8 · AppA 1 = **378 (v1)**

§30A.1 3 · §30A.2 3 · §30A.3 4 · §30A.4 3 · §30A.5 3 · §30A.6 4 · §30A.7 3 ·
§30A.8 4 · §30A.9 3 · §30A.10 3 · §30A.11 3 · §30A.12 3 · §30A.13 4 ·
§30A.14 3 · §30A.15 4 · §30A.16 3 · §30A.17 4 · §30A.18 3 · §30A.19 3 ·
§30A.20 9 · §31 1 = **73 (v1.1-only)**

**Total 451.**

### The rule for prohibitions

Much of §29 and parts of §2, §5, §7 and §21 are prohibitions. Applied
uniformly, and identically to `census-sensing.md`:

- A prohibition is **BUILT-AND-CORRECT** when a concrete artifact makes the
  violation unrepresentable or refuses it — a CHECK constraint, a type, an
  explicit refusal branch, a fail-closed gate. Citation required.
- A prohibition whose forbidden path simply **does not exist**, with nothing
  guarding against it being added, is **NOT-BUILT** — annotated *unguarded
  absence*. The guarantee is not constructed; it is merely currently
  unviolated.

**Twenty-one** NOT-BUILT verdicts are unguarded absences rather than missing
machinery; they are marked `∅` in the table (T1, T18, T19, T26, T67, T118,
T120, T122, T212, T275, T317, T358, T366, T367, T393, T404, T405, T406, T408,
T416, T446). **This census does not credit them**, and that ruling is
unchanged — an absence nothing guards is not a constructed guarantee.

**ARITHMETIC CORRECTED 2026-09-22; THE DEFINITION IS NOT TOUCHED.** This
paragraph used to say that crediting the twenty-one "gives CORRECT% =
119/451 = 26.4 % and CONSTRUCTED% = 291/451 = 64.5 %". Both numbers were
**stale and internally impossible**: 119 is LOWER than this census's own
BUILT-AND-CORRECT count, so the alternative reading came out *worse* than the
reading it was offered as a concession to. For 119 to be right, C would have to
be 98 — which is what it was before the 257 row recounts this document records.
The paragraph was never updated with them.

Recomputed from the current rows, which `check:census-integrity` independently
counts as **231 C / 159 W / 58 N / 3 X of 451** (220 non-correct):

| reading | C | CORRECT% | CONSTRUCTED% |
| --- | --- | --- | --- |
| this census (does NOT credit unguarded absences) | 231 | **51.2 %** | **86.5 %** |
| a reader who credits all 21 | 252 | 55.9 % | 91.1 % |

So the concession is worth **3.7 points**, not the 24.8-point collapse the old
sentence implied. Stating it correctly makes the ruling *easier* to defend
rather than harder, which is the argument for fixing arithmetic rather than
leaving a number that flatters the position by being wrong in its favour.

### Method caveat, inherited

`src/scripts/checkWriterlessReads.ts:39-41` declares that a dynamic
`.from(expr)` anywhere makes writer attribution **INCOMPLETE** and that the
check errs toward silence. A `from("table")` grep also misses variable and RPC
access. **Every "nothing writes/reads X" claim in this census was settled by
reading the call sites**, and the two dynamic `.from(table)` sites in the tree
(`services/media/MyWorldMemoryService.ts:614`,
`services/media/MediaProjectionService.ts:1502#const { data } = await (sc as any).from(table).select("*").eq(ownerCol, ownerId).limit(1000);`) were opened and confirmed to be
gem- and media-scoped helpers whose callers cannot pass a messaging table name.

---

## 4. Attribution: 0.0 %, and the reason is decisive

The brief notes that both completed sibling censuses returned 0.0 %
spec-attributable and asks that it be tested rather than assumed. It was
tested, three ways, and the answer here is not merely 0.0 % — it is **0.0 % for
a reason that admits no exception in HEAD**.

**1. Nothing in the tree cites this specification.**

```
grep -rliE "Telegraph (Design )?(Architecture|Developer|Spec)|Telegraph_Design_Architecture|Telegraph spec|Telegraph §" \
  --include=*.ts --include=*.tsx --include=*.sql --include=*.md \
  artifacts/api-server/src travel-buddy-standalone/src docs
→ travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts
```

One hit, and it is a false positive.
`fieldPolicy.ts:24` reads *"action_assisted : typing surfaces actions, not text
(telegraph §54)"* — but neither Telegraph spec has a §54 (v1 stops at 30, v1.1
at 31). It resolves to the **Global Input Intelligence** spec, whose §54 is
literally titled *"Example: Telegraph Message"*
(`docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt:481`),
and the file's own header says so: *"Mirrors PGIIA spec §6 (Field Policy
Contract) EXACTLY"* (`fieldPolicy.ts:1-8`). It cites a different document that
happens to use Telegraph as an example.

**2. The code predates the spec's presence in the repository.**

> **THIS PILLAR IS WITHDRAWN AS EVIDENCE, 2026-09-14 — it proves nothing about attribution.**
> The measurement below is correct and is kept: every Telegraph-adjacent file in HEAD was
> present at `a745ba11` on 2026-09-05, and the eleven specs were committed at `ebe72b34` on
> 2026-09-07. What does not follow is the sentence that closes it. A specification can be
> written, circulated and worked from for months before anyone commits it to this repository;
> "no file in HEAD could have been written against a document that was not in the repository"
> assumes the repository is where authors get their documents, which is an assumption about
> process and not a fact about these files. The owner has ruled this inference out. Pillars 1
> and 3 do not depend on it — pillar 1 is a measurement of citations and pillar 3 is positive
> evidence of other programmes' authorship — so the section's conclusion stands on those two,
> with the scope limits noted under pillar 3. See `docs/architecture/attribution-method.md`.

The eleven architecture specs were added at `ebe72b34` — *"Put the eleven
architecture specs in the repository"*, **2026-09-07**. Every Telegraph-adjacent
file in HEAD was already present at `a745ba11` (**2026-09-05**), the 5,099-file
/ 1,428,440-line import commit:

```
git log --diff-filter=A --format='%ad %h' --date=short -1 -- routes/messaging.ts
  → 2026-09-05 a745ba11
… identical for routes/telegraph.ts, routes/groupChat.ts, routes/telegraphCommands.ts,
  routes/telegraphStream.ts, lib/telegraphEvents.ts,
  travel-buddy-standalone/src/services/telegraph.ts
```

No file in HEAD could have been written against a document that was not in the
repository until two days after it landed.

**3. Every Telegraph-adjacent artifact that cites *a* spec cites a different one.**

| Artifact | What it cites | Programme |
| --- | --- | --- |
| `routes/calls.ts:1` | *"the canonical /api/calls* endpoints (spec §10)"* | Calls / Rent-a-Buddy |
| `migrations/2260_availability_windows.sql:3` | *"Open-to-Plans / Temporary Intent (**Passport spec §8**, TABLE 7/8/10)"* | Passport |
| `services/passport/SharedContextService.ts:2` | *"§17 'Shared Context ME ↔ THEM' and §18 'See What You Could Do'"* | Passport |
| `travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts:1` | *"Mirrors PGIIA spec §6"* | Global Input Intelligence |
| `services/wall/*` | Wall spec §4 / §5 | Wall |

This matters more than the grep, because it names the actual provenance of the
three surfaces that score best against Telegraph. **Availability is Passport's.
Shared Context is Passport's. Calls are the Calls spec's.** They satisfy
Telegraph requirements incidentally, in a shape their own spec chose.

**Spec-attributable CORRECT% = 0/451 = 0.0 %**, agreeing with both completed
sibling censuses.

> **RESTATED 2026-09-14 — what the zero is, and what the other 209 are.** *0/451 is a count of
> BUILT-AND-CORRECT rows resting on an artifact that cites this specification, and as such it is
> measured and it stands* (pillar 1). It is not a count of rows built for something else. The
> three-way split this corpus now uses reads, for this census:
>
> - **attributable to this spec: 0** of the 209 BUILT-AND-CORRECT rows — evidenced by pillar 1's
>   grep, which returned one hit and that hit resolves to the Global Input Intelligence spec.
> - **attributable elsewhere: the rows resting on the five artifact families in pillar 3's
>   table**, each of which names its own programme in its own header — Calls/Rent-a-Buddy,
>   Passport (×2), Global Input Intelligence, Wall. **This census does not map those families
>   to row ids, so the count is not stated here and must not be inferred.**
> - **attribution unknown: every remaining BUILT-AND-CORRECT row.** Not "built for something
>   else" and not "built for this spec" — no evidence either way was gathered for them.
>
> **A staleness note that is not a recount.** Read at the wave-1 worktree (`7d1f2d498`), the
> pillar-1 grep no longer returns one hit: three artifacts now name the Telegraph spec in their
> own text — `artifacts/api-server/src/domain/telegraph/contracts/certification.ts:4#Telegraph spec (v1 and v1_1 — v1_1's shared body is a byte-exact`,
> `artifacts/api-server/src/compass/CompassTools.ts:127#Telegraph §18.3 — the eight conversation accessors the Telegraph spec names.`
> and `artifacts/api-server/src/migrations/2400_telegraph_history_bound.sql:5#Both Telegraph specification versions require this (v1_1 is a byte-exact`.
> Whether any BUILT-AND-CORRECT row rests on them has NOT been re-derived, so **no figure in
> this document is changed by this note** — it records that the "admits no exception in HEAD"
> claim was true of the HEAD it was measured against and is not true of this one.

### The exception that is not in HEAD

**PR #472 is the first and only artifact built *for* this specification**, and
it is unmerged. `migrations/2325_telegraph_unsend_before_seen.sql`, the route
that calls it, and `test/telegraphUnsendBeforeSeen.test.ts` cite §7.1, §7.3,
§7.4, §12.1, §13.1, §26, §27.1, §28 and §29 by number and quote them. Its test
header even states the superset relationship this census independently verified
in §2. If it merges, eleven requirements move: T75, T76, T77, T161, T326, T327, T338
and T387 from NOT-BUILT, and T79, T220 and T314 from BUILT-BUT-WRONG, all to
BUILT-AND-CORRECT. Spec-attributable CORRECT% would become 11/451 = **2.4 %**
(T344 would stay BUILT-BUT-WRONG — #472 closes one of its four dropped-error
reads, not all four). It is applied to `portava-ci` only; `messages.unsent_at` does
not exist in production. **It is not scored in any bucket here.**

PR #460 is *not* spec-attributable — it carries no section citation anywhere in
its diff — even though it hardens behaviour this spec requires.
**[RESTATED 2026-09-14 — UNKNOWN.]** "Carries no section citation" is measured and true; the
conclusion that follows from it is that #460's attribution is **unknown**, not that it is not
this spec's. A diff can implement a specification faithfully and cite nothing. What would settle
it: a section citation in the diff, a PR description naming the spec, or the author saying so.

---

## 5. Requirement-by-requirement

Verdict key: **C** BUILT-AND-CORRECT · **W** BUILT-BUT-WRONG · **N** NOT-BUILT ·
**?** CANNOT-VERIFY · `∅` unguarded absence (a prohibition currently unviolated
with nothing preventing violation — counted N) · **1.1** v1.1-only.

Backend paths relative to `artifacts/api-server/src/`; client paths to
`travel-buddy-standalone/`.

### §1 Product Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T1 | North star: optimize for coordinated real-world action, not message volume / streaks / time in chat | N `∅` | Unguarded absence. No streak, session-length or message-volume mechanic exists in either tree; nothing guards against one. The positive metric is T354, which is also absent. |
| T2 | Pillar **Talk** — text, rich media, voice, GIFs, replies, reactions, seen states, safe message lifecycle | W | Four of eight. Text/media (`routes/messaging.ts:1734`, `:2069`), replies (`:3091#reply_to_id` `reply_to_id`), seen (`:1204`) are real. **Voice, GIF, reactions and safe lifecycle are absent**: `:2080-2083` accepts only `image`/`video`; `message_reactions` does not exist in `baseline/20260819_baseline_structure.sql`; delete is unconditional (`routes/groupChat.ts:340-381`) and unsend does not exist. |
| T3 | Pillar **Share** — any eligible Portava object moves through a safe permission-aware share projection | W | Objects do move (`app/messages/[id].tsx:718-763` renders discovery/post/compass cards) but the payload is raw unversioned JSON in `messages.body` and there is no share projection and no revocation. See T39, T44–T46. |
| T4 | Pillar **Together** — every conversation can expose shared Trips, plans, events, places, Memories, history | N | The Shared Context Rail does not exist (T13–T21). |
| T5 | Pillar **Nearby** — opt-in availability and approximate proximity reveal actionable opportunities without covert tracking | W | Availability is real and opt-in (`migrations/2260_availability_windows.sql:67-100`) and presence is approximate-only (`circle_presence.approximate_label`, `baseline:4465`); neither reaches Telegraph, and no proximity layer exists (T22–T34). |
| T6 | Pillar **Act** — messages/shared objects become plans, votes, meetups, navigation, coordination sessions | W | Three of five: suggestion→add-to-plan / create-meetup / start-poll (`routes/telegraphChat.ts:10-12`), `meetup_time_options`+`meetup_time_votes` (`baseline:7318,7336`), RSVP (`app/messages/[id].tsx:46`). No navigation handoff, no coordination sessions (T102–T116). |
| T7 | Pillar **Remember** — completed outcomes explicitly become Memories or recaps without ingesting whole private chats | W | The prohibition half holds (nothing reads thread history into Memories). The positive half is a hole: the explicit save writes to `saved_messages` and nothing reads it back (T119), and there is no recap (T121–T122). |

### §2 Information Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T8 | Inbox is not a generic notification feed: communication **plus** shared real-world context that materially affects communication | W | `components/TelegraphInboxScreen.tsx:33-39` is a filtered conversation list (All/Direct/Trips/Circles/Unread/Requests) with highlight rings. There is no status band, no available-nearby band, no NOW and no UPCOMING band — the "shared real-world context" half of the assertion has no implementation. |
| T9 | Conversation header: user/crew name · availability · safe presence | W | `app/messages/[id].tsx:1599-1690` renders back, avatar, name, one subtitle tag and call/video/translate/menu actions. Name only; no availability, no safe presence. |
| T10 | Semantic layer **TALK** | C | `app/messages/[id].tsx:1899-1935` — `MessageBubble` carries text, media, mentions (`RichText`), translation state and reply context. |
| T11 | Semantic layer **PLAN** | W | Plan objects render, but as ordinary stream items, not a layer: meetup cards `:293-320`, discovery/post/compass cards `:718-744`. Nothing separates unresolved actions from conversation. |
| T12 | Semantic layer **NOW** | N | No active-coordination layer. See §9. |

### §3 Shared Context Rail

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T13 | Rail at the top of each conversation showing mutually relevant objects | N | The conversation renders header → message list → composer (`app/messages/[id].tsx:1599`, `:1380`, composer below). No rail element exists. |
| T14 | Eligibility: created by me, joined/saved/attended by them | N | No eligibility resolver exists. |
| T15 | Eligibility: created by them, joined/saved/attended by me | N | Same. |
| T16 | Eligibility: both members of the same Trip, Plan, Crew, Event or booking | N | The *fact* is computable (`services/passport/SharedContextService.ts:29` `shared_trips`) but nothing promotes it into a conversation. |
| T17 | Eligibility: both deliberately promoted an item into a shared wishlist / Want-to-Do | N | No shared-wishlist promotion primitive. |
| T18 | Past shared objects remain available in the historical view only when still authorized | N `∅` | No historical view. |
| T19 | Never infer mutuality from chat alone | N `∅` | Unguarded absence. Nothing promotes a message-shared place into a mutual plan — and nothing would refuse it. |
| T20 | Ordering: HAPPENING NOW → STARTING SOON → TODAY → UPCOMING → ACTIVE TRIP → UNRESOLVED → PAST | N | No rail, no ordering. |
| T21 | `TelegraphSharedContextProjection` / `SharedContextItem` contract | N | The nearest artifact is a **different** contract: `services/passport/SharedContextService.ts:24-35` builds explainable facts for a *profile pair* under Passport §17/§18, is consumed only by `routes/passport.ts:26`, and has no `conversationId`, no now/upcoming/unresolved/past arrays and no `availableActions`. |

### §4 Nearby & Available

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T22 | AVAILABLE ≠ ONLINE ≠ NEARBY ≠ SHARING LOCATION — never collapsed into one permission | W | Three of four are genuinely separate stores with separate consent: `availability_windows` (2260), `circle_presence` (`baseline:4458`), `trip_crew_location_sessions` (`baseline:10507`). 2260's `CHECK (source='explicit' OR visibility='private')` makes an inferred public availability *unrepresentable* — a real refusal. But **NEARBY has no referent**, so the four-way separation is a three-way one. |
| T23 | `AvailabilitySignal` contract | W | `2260:67-100` carries `type`, `start_at`, `end_at`, `intents[]`, `group_preference`, `visibility`, `source`, `expires_at` — genuinely close. Absent: `audiencePolicyId`, `proximityVisibility` (HIDDEN/NEARBY/DISTANCE_BUCKET/ETA_IF_MUTUAL), `geographyScope`. The state vocabulary is Passport's TABLE 7/8, not §4.1's. |
| T24 | `nearbyRank` over availability, relationship, intent, shared context, overlap window, travel time, proximity bucket, freshness, safety | N | No ranking function over people exists. |
| T25 | Approximate proximity or controlled distance buckets by default | N | No proximity surface. `presence/domain/types.ts:50` declares a per-feature precision ceiling (`bump: "zone"`) but that module is interface-only and belongs to the Presence Network programme. |
| T26 | Repeated refreshes must not become a movement-tracking side channel | N `∅` | Unguarded absence — there is no refreshable proximity endpoint to abuse, and no budget/throttle concept guarding one. |
| T27 | Exact ETA/location requires stronger mutual coordination permissions | W | A real precision+audience ladder exists: `trip_crew_location_sessions.visibility_level` CHECK `city_only|neighborhood|nearby` with `allowed_member_ids` (`baseline:10511-10521`), and safe-return live share sits behind its own second flag (`routes/safeReturn.ts:3-5`). But there is no ETA concept and no *mutual-coordination* gate — the trip-crew grant is unilateral. |
| T28 | Availability expires automatically and revokes across Telegraph, Discovery and Compass | W | Expiry is real and re-evaluated on every read rather than trusted to a sweep (`2260:38-42`: *"a stalled sweep can never render an expired window as current"*). Cross-surface revocation is not implemented — **Telegraph never reads availability at all**. |
| T29 | Invisible mode suppresses Nearby/Bump/public availability while allowing private Map use | N | No invisible mode. |
| T30 | Blocking is absolute and removes both parties from each other's proximity surfaces | W | Blocking is genuinely absolute in delivery and discovery: `routes/blocks.ts:60-78` tears down follows, friend requests, friendships and pending message requests and writes an interaction cooldown; `compass/CompassTools.ts:1246` filters hidden users out of every social tool; five block-exclusion suites exist (`test/blockExclusion.test.ts`, `memoriesBlockFailClosed.test.ts`, `compass-ui-blocks.test.ts`, `discoveryBlockedSubmitter.test.ts`, `rentABuddySearchBlocks.test.ts`). Two divergences: the proximity half is vacuous, and blocking deliberately **does not close an existing thread** — it is re-checked per send instead (`routes/messaging.ts:1779-1793`), which is defensible but is not "absolute" at the object level. |
| T31 | Privacy zones can suppress discovery around home, lodging or user-defined sensitive places | W | The capability exists and is well built — `lib/protectedLocations.ts:13-27`, a server-side last gate, fail-closed on unparseable geometry — but it belongs to the Map programme, its policy table ships empty by design, and **nothing in Telegraph consults it**. |
| T32 | Who's Around: focused surface for people, open plans and events actionable right now | W | `get_whos_around` is real and privacy-correct (`compass/CompassTools.ts:194`, impl `:790-805`; approximate-only, opt-in-only, `contextsChecked === 0` answers honestly). But it is a **Compass LLM tool, not a surface**, it returns people only — no open plans, no events — and it is scoped to the caller's circles and trips. |
| T33 | Existing social graph separated from discoverable strangers | W | The separation exists in one direction: `toolWhosAround` gates on `sharesSocialContext` (`CompassTools.ts:854`) so only the graph is returned, and stranger contact runs entirely through `message_requests`. The *discoverable strangers* half has no implementation, so there is nothing to separate from. |
| T34 | Stranger flow: safe profile preview → Wave/Request → accepted thread; no automatic unrestricted messaging | C | `lib/messagingPermissions.ts:29-45` resolves `allowed` / `requires_request` / `denied`; `routes/messaging.ts:278-305` refuses `open-thread` fail-closed and names the request route; `:432` files the request and `routes/messaging.ts:891#router.post('/message-requests/:requestId/accept', async (req, res) => {` accepts it into a thread. No path opens an unrestricted stranger thread. There is no separate "Wave" primitive — the request is it. |

### §5 Universal Portava Sharing

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T35 | One consistent share contract for all eligible Portava content | W | Sharing exists but there is **no contract**: each source builds its own JSON and posts it as a `msg_type:'system'` message with a bespoke `subtype`. `DiscoveryShareSheet` → `subtype:'discovery_card'`, `app/messages/[id].tsx:2269` → `'compass_card'`, `routes/circle.ts:300` → `msg_type:'circle_status_card'`, `services/media/MediaActionResolver.ts:343` → `share_telegraph`. Four producers, four shapes, no shared interface. |
| T36 | Object family **Social** — profile, post, Highlight, public Memory derivative, Memory Note, Stamp | W | Post only (`components/PostCardMessage.tsx`). No profile, Highlight, Memory derivative, Memory Note or Stamp share. |
| T37 | Object family **Travel** — Trip, Trip stage, plan, event, route, reservation-safe derivative, layover plan | N | None of the seven is shareable into a thread. |
| T38 | Object family **Places** — place, Hidden Gem, map pin, neighborhood, meetup point | W | Place/gem via `discovery_card` (`components/DiscoveryCardMessage.tsx:26-35`) and meeting point via `circle_status_card` (`components/CircleStatusCardMessage.logic.ts:15`). No map pin, no neighborhood. |
| T39 | Object family **Services** — Buddy profile/service, eligible booking card, Visa Buddy operational card | W | Booking milestones render (`components/rentabuddy/BookingMilestoneMessage.tsx`, dispatched `app/messages/[id].tsx:1862-1866`) and a booking owns its thread (`rent_buddy_bookings.telegraph_thread_id`, read at `routes/messaging.ts:1887`). No Buddy profile share, no Visa Buddy card. |
| T40 | Object family **Media** — photo, video, voice, GIF, file | W | Photo and video only (`routes/messaging.ts:2080-2083`). No voice, GIF or file. |
| T41 | `TelegraphShareable` interface — `getSharePreview` / `getCurrentState` / `getAvailableActions` / `getDeepLink` | N | None of the four methods exists under any name. Search of both trees returns nothing. |
| T42 | Four-layer model: **Message content** | C | `messages.body` + `msg_type`/`subtype` is a genuine sender-authored layer, distinct from everything else (`baseline:7553-7574`). |
| T43 | Four-layer model: **Source object** | W | A source id is carried (`DiscoveryCardPayload.sourceId`/`sourceType`, `components/DiscoveryCardMessage.tsx:26-28`) but it is a payload field, not a resolved reference — there is no `conversation_action_refs` table and nothing dereferences it at render. |
| T44 | Four-layer model: **Share projection** — what the recipient is *currently* authorized to see | N | The layer does not exist. The card is whatever the sender serialized at send time. |
| T45 | Four-layer model: **Derived enrichment** | W | One derived layer is real and correct — `message_translations` per recipient (`baseline:7534-7546`, writer `services/messageTranslation.ts:1-13`). Thumbnails are a message column, not a derivation. No transcript, preview, caption or embedding layer. |
| T46 | Revocation: a deleted/private/unauthorized source degrades the Telegraph reference to unavailable; never a backdoor into revoked content | W | **Violated, not merely absent.** Shared cards are frozen snapshots: `components/DiscoveryCardMessage.tsx:37-45` parses the JSON body and renders it, with no refetch, no `useEffect`, no authorization call; `components/PostCardMessage.tsx` has no fetch at all. A place made private or a post deleted after sharing still renders in full inside the thread forever. Same finding as T359. |

### §6 Rich Messaging Design

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T47 | Composer stays visually calm; rich actions live behind a `+` menu | W | The composer is calm and does have an attachment affordance (`app/messages/[id].tsx` composer row, `hooks/useMessageMediaPicker.ts`), but the `+` menu has two of eight entries (Camera/Photos via the picker). Video, GIF, Voice, Memory Note, Location and Portava are not offered. |
| T48 | Message kind **TEXT** | C | `routes/messaging.ts:1758` `msgType` defaults to `'text'`; rendered `app/messages/[id].tsx:1899`. |
| T49 | Message kind **IMAGE** | C | `routes/messaging.ts:2080-2083` + `:2176` `media_type`; rendered `components/MessageMediaBubble.tsx`, dispatched `app/messages/[id].tsx:1870`. |
| T50 | Message kind **VIDEO** | C | Same path; `media_type` CHECK `('image','video')` (`baseline:7573`). |
| T51 | Message kind **MEDIA_ALBUM** | N | One asset per message; `messages` carries a single `media_url` (`baseline:7568`). No album concept. |
| T52 | Message kind **GIF** | N | No GIF kind, provider or picker anywhere. |
| T53 | Message kind **VOICE** | N | No voice message, no `media_duration_seconds` writer for audio, no waveform, no audio MIME in `lib/mediaPipeline.ts:75` (`ALLOWED_MEDIA_MIME` is image/video only). |
| T54 | Message kind **MEMORY_NOTE** | N | No Memory Note kind. |
| T55 | Message kind **PORTAVA_OBJECT** | W | Implemented as `msg_type:'system'` plus a bespoke `subtype` per object family rather than a typed kind (`app/messages/[id].tsx:718-763`). The capability exists; the envelope the spec asks for does not. |
| T56 | Message kind **LOCATION** | N | No location message kind. |
| T57 | Message kind **ACTION** | N | Actions are inferred from card subtypes, not carried as a kind. |
| T58 | Message kind **ANNOUNCEMENT** | N | No announcement kind (see also T392–T394). |
| T59 | Message kind **SYSTEM** | C | `routes/messaging.ts:1757` `msgType === 'system' ? 'system' : 'text'`; centred-pill renderer `app/messages/[id].tsx:1892-1898` → `components/TelegraphSystemNotice.tsx:16`. |
| T60 | Message kind **SAFETY** | W | Safety exists as a *thread* affordance (`components/ThreadSafetySheet.tsx`, imported `app/messages/[id].tsx:54`) and as circle `needs_help` (`routes/circle.ts:1556-1589`), but there is no SAFETY message kind. |
| T61 | Inline video playback: poster, play/pause, scrub, mute, fullscreen, captions | ? | Requires a device. `components/MessageMediaBubble.tsx:170` mounts an autoplay-capable player; scrub/mute/fullscreen/caption behaviour belongs to the shared player and is not statically decidable. |
| T62 | Picture-in-picture / compact playback continues while scrolling | N | No PiP path in the messaging tree. |
| T63 | Voice: waveform, seek, playback speed, optional transcript/translation | N | No voice messages at all (T53). |
| T64 | GIFs are distinct lightweight looping content with data-saver / accessibility controls | N | No GIF, and no data-saver mode anywhere in the client. |
| T65 | Mixed-media albums: one reply target and one seen lifecycle, independent asset references | N | No albums (T51). |
| T66 | Content drawer: MEDIA / PLACES / PORTAVA / VOICE / GIFS / LINKS / FILES | N | **Deliberately dead-coded.** `app/messages/[id].tsx:1692` — `{false ? <Pressable … onPress={() => Alert.alert('Thread info', 'Members, shared media, and settings — coming soon.')}>` — the entry point exists behind a literal `false`. No route, no service. |
| T67 | The drawer is a structured index, not a second storage copy | N `∅` | Unguarded absence — there is no drawer, hence no second copy. |
| T68 | Object-aware search respects current authorization and unsent/deleted state | N | No search over conversation content exists (T272–T277). |

### §7 Message Lifecycle: Seen, Unsend, Edit

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T69 | Lifecycle SENDING → SENT → DELIVERED → SEEN, ↘ FAILED; SENT/DELIVERED + unseen → UNSENT | W | Two of six states. There is no `lifecycleState` column (`baseline:7553-7574`), **no DELIVERED concept anywhere** (`grep -i '\bdelivered\b'` over `routes/messaging.ts` + `routes/groupChat.ts` + `lib/telegraphEvents.ts` returns one unrelated E2EE string, `routes/messaging.ts:1311`), and no UNSENT. State is inferred from `created_at`, `edited_at`, `deleted_at` and the thread-level `last_read_at`. |
| T70 | Seen = crossed the approved visibility threshold in an active foreground conversation | W | Seen is **thread-level, not message-level**, and is whatever the client asserts: `routes/messaging.ts:1204-1220` stamps `message_thread_members.last_read_at = now()` on any authenticated call, with no visibility predicate the server can check. |
| T71 | Push delivery, app launch and background rendering do not count as seen | ? | The server cannot distinguish them — `POST /threads/:threadId/read` takes no evidence (`:1202`). Whether the client calls it only on foreground render is a runtime property of `hooks/useMessaging.ts markThreadRead`; it is called from a focus effect, but nothing enforces it and no test exercises the background case. |
| T72 | `conversation_members.lastDeliveredSequence` / `lastSeenSequence` | W | Half exists in a different shape: `message_thread_members.last_read_at` (`baseline:7503`) is a timestamp, not a sequence, and there is **no delivered counterpart**. |
| T73 | Direct: Sent/Delivered/Seen. Groups: "Seen by N", optionally list viewers when policy allows | N | No receipt UI beyond the inbox's own unread count. `read.updated` is published (`routes/messaging.ts:1231-1236`) but nothing renders per-message receipts. |
| T74 | Do not create permanent row-per-message-per-user receipt explosions | C | The receipt is one row per member per thread with a single timestamp (`baseline:7495-7505`), and unread counts are derived by comparing `created_at > last_read_at` (`routes/messaging.ts:917-962`). The forbidden shape is structurally absent, and the alternative is implemented. |
| T75 | A sender may unsend only while no eligible recipient has seen the message | N | Nothing in `artifacts/api-server` implements unsend. The only two `/unsend\|unsent/` matches in the whole server tree are unrelated: `test/discoveryNegativeSignalWriter.test.ts:26` (the word "unsendable" in prose) and `migrations/0080_events_extension.sql:380` (`event_reminders_unsent_idx`). **This confirms migration 2325's header claim, with that two-match correction.** What exists instead is unconditional DELETE (`routes/groupChat.ts:340-381`), sender-only, at any time, with no seen predicate. |
| T76 | In a group, one recipient seeing the message closes the window for everyone | N | No window exists to close. |
| T77 | The server resolves read-vs-unsend races transactionally | N | No unsend; and the competing writer (`routes/messaging.ts:1744#.update({ last_read_at: threshold })` `last_read_at`) takes no lock. |
| T78 | Preserve a sequence tombstone internally | W | A tombstone is preserved — deleted rows are returned and rendered as a redacted slot, and the body is emptied rather than the row removed (`routes/groupChat.ts:363-372`, reader `routes/messaging.ts:1577`). But there is no `sequence` to preserve continuity of; ordering is `created_at` (`:1581`). |
| T79 | Remove from normal retrieval, search and projections | W | The body is suppressed on `deleted_at` (`routes/messaging.ts:1719` `body: isDeleted ? null : m.body`) — but in **main** the media fields are not: `:1720-1723` returns `media_url`, `media_thumbnail_url`, `media_type` and `media_duration_seconds` unconditionally, so deleting a photo redacts the caption and leaves the asset addressable. PR #472 fixes exactly this; it is not merged. |
| T80 | Text edits retain an Edited marker **and version history** | W | The marker is real (`routes/messaging.ts:2371-2374` sets `edited_at`, surfaced as `editedAt`). **Version history is not**: the update overwrites `body` in place and `message_edits` does not exist in the schema. Translation invalidation on edit is correct (`:2401` `markTranslationsPending`). |
| T81 | Editing message prose never silently mutates a canonical Plan/Event/Trip object | C | The edit handler writes exactly two columns on one row — `body` and `edited_at` (`routes/messaging.ts:2371-2374`) — and touches nothing else. No card is re-parsed, no domain write is triggered. The forbidden path does not merely happen not to run; the handler has no branch that could reach it. |

### §8 Plans, Decisions & Action Objects

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T82 | Promote structured action over repeatedly parsing prose | C | `routes/telegraphChat.ts:1-13` — intent detection produces persisted, dismissible suggestions whose only outputs are three structured endpoints (`/add-to-plan`, `/create-meetup`, `/start-poll`). Prose is parsed once into an object; the object, not the prose, is what acts. |
| T83 | `ConversationDecision` — question, options, voters, resolution rule, deadline, final result | W | A real structured decision exists but only for one question: `meetup_time_options` + `meetup_time_votes` with a `yes/maybe/no` CHECK (`baseline:7318-7343`). No free-form question, no resolution rule, no deadline, no recorded final result. |
| T84 | `ConversationCommitment` — who agreed to what, by when, completed | N | No commitment object. |
| T85 | `CoordinationSession` | N | No table, no service, no route. |
| T86 | `Rendezvous` — checkpoint, landmark, time window, fallback point, proximity state | W | `circle_meeting_points` is real, host-set, and posts a card into the thread (`routes/circle.ts:1333-1377`, rendered `components/CircleStatusCardMessage.logic.ts:33`). Two of five properties: checkpoint and landmark (`venue_label`/`approx_area`). No time window, no fallback point, no proximity state. |
| T87 | Action `ADD_TO_TRIP` | C | `components/discovery/TripWishlistPicker.tsx` invoked from the card action row (`app/messages/[id].tsx:60`); server tool `compass/CompassTools.ts` `add_to_trip`; `routes/telegraphChat.ts:10` `/add-to-plan`. |
| T88 | Action `CREATE_PLAN` | C | `components/MeetupCreationSheet.tsx` (imported `app/messages/[id].tsx:45`) writes a meetup and posts the card at `:2172`; `routes/telegraphChat.ts:11` `/create-meetup`. |
| T89 | Action `JOIN_PLAN` | C | `rsvpMeetup` (`app/messages/[id].tsx:48`) against `meetup_invites.status` (`baseline:7310` — `pending/going/maybe/declined/cancelled`), rendered by `components/RsvpBar.tsx`. |
| T90 | Action `LEAVE_PLAN` | C | Same RSVP path; `declined` and `cancelled` are in the CHECK (`baseline:7310`). |
| T91 | Action `MEET_HERE` | W | The capability exists but is not a message action: setting a meeting point is a **circle-host** operation (`routes/circle.ts:1333`, host gate at `:1360` `host_changed_meeting_point`) that fires a card into the thread as a side effect (`:1377`). A participant cannot say "meet here" from a message. |
| T92 | Action `SHARE_PLACE` | C | `discovery_card` share path — payload shape at `components/DiscoveryCardMessage.tsx:26-35`, dispatched `app/messages/[id].tsx:718-725`. |
| T93 | Action `SHARE_ROUTE` | N | No route share. `components/RouteBuilderSheet.tsx` builds walking routes for the map, never into a thread. |
| T94 | Action `VOTE` | C | `meetup_time_votes` (`baseline:7336-7343`) with `fmtTimeOption` rendering in-thread (`app/messages/[id].tsx:255`); `routes/telegraphChat.ts:12` `/start-poll`. |
| T95 | Action `SHARE_AVAILABILITY` | N | Availability is never shared into a thread; Telegraph does not read `availability_windows` at all. |
| T96 | Action `SHARE_LOCATION` | W | Location sharing is real and scoped (`routes/tripCrewLocation.ts`, `routes/safeReturn.ts:16-18` live-share start/stop) but it is not a Telegraph action — the composer has no location entry (T56) and no message carries a location scope. |
| T97 | Action `SPLIT_RIDE` | N | Nothing. |
| T98 | Action `CHECK_IN_SAFE` | W | The capability lands in the thread as a card — check-in subtypes `arrived / with_group / leaving / safe` (`components/CircleStatusCardMessage.logic.ts:57`) posted by `routes/circle.ts:300`, plus Safe Return confirm (`routes/safeReturn.ts:12`). But it is a circle-presence operation, not a message action, and it only exists inside circle contexts. |
| T99 | Action `RETURN_TO_GROUP` | N | Nothing. |
| T100 | Action `DO_THIS_NOW` | N | Nothing. |
| T101 | AI/entity extraction may suggest; canonical creation requires user confirmation unless a pre-authorized deterministic shortcut exists | C | **Unconfirmed canonical creation is unrepresentable in the type.** `routes/telegraphCommands.ts:57` declares `requires_confirmation: true` as a literal `true`, not a boolean, on every `ProposedAction`; `:390` `confirm-action` re-verifies trip membership *at execution time* rather than trusting the proposal; `:11-14` documents the BOLA checks. Suggestions in `routes/telegraphChat.ts` are inert until an explicit endpoint is called. |

### §9 Coordination Mode

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T102 | State machine PREPARING → ASSEMBLING → ACTIVE → RETURNING → COMPLETE ↘ DISRUPTED/CANCELLED | N | No coordination state machine anywhere. `lib/calls/callStateMachine.ts` is a call FSM, unrelated. |
| T103 | Thread temporarily transforms into a coordination surface near the leave-by/start window | N | The conversation has exactly one mode. No leave-by concept exists. |
| T104 | Preparing UI: plan card, attendance, leave-by, route, availability conflicts | W | Two of five: the meetup card renders with attendance counts (`app/messages/[id].tsx:293-320` + `RsvpBar`). No leave-by, no route, no conflict detection in-thread (`check_trip_conflicts` exists only as a Compass tool, `compass/CompassTools.ts`). |
| T105 | Assembling UI: on my way, running late, meet here, ETA, pickup, arrival counts | W | One of six: `arrived` exists as a circle check-in (`components/CircleStatusCardMessage.logic.ts:57`) and the meeting-point card renders (`:33`). No on-my-way, running-late, ETA, pickup or arrival count. |
| T106 | Active UI: minimal conversation, next step, crew state, optional location scope | W | Crew state and location scope both exist as **separate screens** — `routes/tripCrewLocation.ts`, `circle_presence` via `app/circle-presence.tsx` — never as a thread mode, and there is no next-step surface. |
| T107 | Returning UI: heading back, Safe Return, shared transport, return checkpoint | W | Safe Return is a complete subsystem (`routes/safeReturn.ts:6-23`: create, start, extend, confirm, trigger-missed, live-share start/stop, history, trusted contacts) and is the strongest single artifact in this section — but it is its own surface, not a conversation state, and heading-back / shared transport / return checkpoint do not exist. |
| T108 | Complete UI: closeout, media grouping, explicit Memory/recap options | N | No closeout, no media grouping, no recap (T121). |
| T109 | Quick state `ON_MY_WAY` | N | Not in `CHECKIN_SUBTYPES` and nowhere else. |
| T110 | Quick state `ARRIVED` | C | `components/CircleStatusCardMessage.logic.ts:57` `CHECKIN_SUBTYPES = ['arrived','with_group','leaving','safe']`; written by `routes/circle.ts:300` and rendered as a check-in card with a member-only gate (`:251`). |
| T111 | Quick state `RUNNING_LATE` | N | Nothing. |
| T112 | Quick state `CANT_MAKE_IT` | W | Expressible only as an RSVP `declined` (`baseline:7310`), which is a plan-attendance answer, not an in-flight coordination status. |
| T113 | Quick state `START_WITHOUT_ME` | N | Nothing. |
| T114 | Quick state `HEADING_BACK` | W | Approximated twice and named nowhere: the `leaving` check-in subtype (`CircleStatusCardMessage.logic.ts:57`) and Safe Return session start (`routes/safeReturn.ts:8`). Neither is a thread status. |
| T115 | Quick state `NEED_HELP` | C | `circle_presence.needs_help` (`baseline:4472`), written at `routes/circle.ts:1556-1568` with `status:'needs_help'` and `is_stale:false`, emitting `needs_help_triggered` (`:1589`) — and deliberately excluded from every member-visible payload (`routes/circle.ts:11`, `:251`: *"Never expose: … needs_help bool"*). The state is real and its disclosure is guarded. |
| T116 | User-declared status must remain distinguishable from system-derived ETA or location-derived estimates | C | `circle_presence` keeps them in separate columns and never merges them: `status_label` (user-declared) vs `approximate_label` / `venue_label` (derived) vs `checked_in` / `is_stale` (system), `baseline:4463-4472`, read without collapse at `routes/circle.ts:920,936`. The ETA half of the sentence is vacuous — no ETA exists. |

### §10 Memory Notes & Post-Experience Content

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T117 | `MemoryNoteShare` contract | N | No Memory Note type, table, route or renderer. |
| T118 | A Memory Note is shareable/saveable/actionable without exposing the sender's canonical private Memory graph | N `∅` | Unguarded absence — no Memory Note exists to leak through. |
| T119 | A user may explicitly save a message, voice note, place share or media item as a private Memory draft | W | **Persists into a hole.** Both client surfaces offer it (`app/messages/[id].tsx:2227`, `components/GroupChatScreen.tsx:1064`) and the server upserts (`routes/messaging.ts:2666-2703`), but **nothing reads `saved_messages` back** — settled by reading call sites, not greps: the only other references in the entire repository are the deletion cascade (`lib/deletionDispositions.ts:432`) and the RLS ledger (`scripts/rlsDispositions.ts:429`). There is no saved-messages route and no screen. It also lands in `saved_messages`, not in `memories`, so it is not a Memory draft. |
| T120 | Telegraph never automatically converts whole conversations into Memories | N `∅` | Unguarded absence. No conversation→Memory path exists, and nothing would refuse one. |
| T121 | End-of-night recap surface | N | Nothing. |
| T122 | Recap derived from confirmed session context and shared references — an invitation to curate, not automatic historical truth | N `∅` | No recap to be wrong about. |

### §11 Design System & Interaction Rules

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T123 | Dark-first concept permitted, but components must support Portava light/dark themes | W | `travel-buddy-standalone/src/theme/telegraphTokens.ts:10-29` is a **single light palette** — `surface:'#F7F6F3'`, `recvBubble:'#FFFFFF'`, `sentBubble:'#1A3A2A'` — declared `as const` with no dark variant and no theme selector. The tokens exist and are used consistently; theme support does not exist. |
| T124 | Restrained teal/cyan as operational emphasis; stronger attention reserved for safety and urgent changes | W | Neither half. The Telegraph accent is `color.signal` (`telegraphTokens.ts:24`) = vermilion `#FF4D2E` (`src/theme/tokens.ts:12`), which is the app-wide primary-action colour and is therefore *not* reserved for safety; the sent bubble is dark green `#1A3A2A`. Teal-ink exists as a token (`tokens.ts:14` `deep:'#0A3D4A'`) and is not used by Telegraph. Same divergence family as the Wall's §35. |
| T125 | Cards compact and contextual; Telegraph must not visually resemble a social feed inside a chat | C | Cards are bounded inline blocks inside the bubble column (`components/DiscoveryCardMessage.tsx`, `PostCardMessage.tsx`, `CompassCardMessage.tsx`) rendered from a single `FlatList` of messages; there is no feed layout, no grid and no infinite media rail in the thread. |
| T126 | Horizontal rails only for short high-value context sets, with "See all" | N | No rails in Telegraph (T13). |
| T127 | Message bubbles remain visually dominant once the user scrolls in | C | Satisfied, but by the **absence** of the competing regions §2.2 asks for: the thread is header → message list → composer, so nothing competes with the bubbles. `TG_SPACING` (`telegraphTokens.ts:43-47`) gives bubbles the dominant vertical rhythm. |
| T128 | Rail behaviour: active plan → expanded NOW card at top | N | No rail. |
| T129 | Rail behaviour: upcoming only → compact horizontal cards | N | No rail. |
| T130 | Rail behaviour: none → collapsed summary ("3 shared plans · 1 past trip") | N | No rail. |
| T131 | Rail behaviour: user scrolls down → rail collapses, messages get priority | N | No rail. |
| T132 | Rail behaviour: critical plan change → temporary promoted change card until acknowledged | N | No rail, and no acknowledgement primitive (T393). |
| T133 | Do not encode delivery/availability solely by colour | C | The one status Telegraph renders is unread, and it is a **number**, not a colour (`components/TelegraphInboxScreen.tsx` row badge). Delivery and availability are not rendered at all, so nothing encodes them by colour. |
| T134 | Reduced-motion behaviour for media, GIFs and animations | W | An animation gate exists and is the wrong gate: `components/MessageEntrance.tsx:31,46` suppresses entrance animation for messages that predate mount — a *pagination* rule, not an accessibility one. It never consults reduced motion. The correct hook exists in the tree, two directories away, and is not reused: `src/features/wall/hooks/useReducedMotionSetting.ts:2` (*"the OS 'reduce motion' accessibility setting"*), whose only consumer is `features/wall/components/objects/VideoWallItem.tsx:50`. |
| T135 | Voice/video controls: screen-reader labels and predictable hit targets | ? | Voice does not exist (T53). The video controls belong to the shared player; screen-reader behaviour is a runtime accessibility-tree property and needs a device. |
| T136 | Captions/transcripts are optional derivatives; original media remains accessible | N | No caption or transcript pipeline (T252). |
| T137 | Nearby/proximity labels understandable without a map-only representation | C | Proximity is stored and rendered as text, never as a required map: `circle_presence.approximate_label` / `venue_label` (`baseline:4465-4466`) → `resolveCardRenderFromProps` returns a `locationText` string (`components/CircleStatusCardMessage.logic.ts:33`). |

### §12 Canonical Domain Model

| id | Requirement (table / aggregate) | V | Evidence |
| --- | --- | --- | --- |
| T138 | `conversations` — identity, type, lifecycle, current policy/version | W | `message_threads` (`baseline:7512-7527`) carries identity, `thread_type` (direct/trip/circle) and `status` (active/archived), with a genuine `chk_thread_context` CHECK tying `trip_id`/`circle_owner_id` to the type. **No policy id and no version column** — the "current policy/version" half has no representation. |
| T139 | `conversation_members` — membership intervals, role, visible sequence bounds, delivered/seen sequences | W | `message_thread_members` (`baseline:7495-7505`) has intervals (`joined_at`/`left_at`), role (`member`/`admin`), archived/muted and `last_read_at`. Two of four: **no visible sequence bounds** (T210) and **no delivered sequence** (T72). |
| T140 | `conversation_requests` — provenance, intent, acceptance/decline state | W | `message_requests` (`baseline:7477-7488`) has state with a four-value CHECK and a `no_self_message_request` CHECK. **Provenance and intent are not stored** — there is no origin column (Event / Trip / Nearby / Bump / Buddy / profile), which is also why T278 fails. |
| T141 | `messages` — stable envelope, sender, sequence, kind, lifecycle, content reference | W | Three of six. See T156. |
| T142 | `message_edits` | N | Absent from the schema; edits overwrite in place (T80). |
| T143 | `message_reactions` | N | Absent. Note the dangling consumer: a `telegraph.reaction` notification template exists and is fully written (`services/notifications/NotificationTemplateService.ts:660-667`, *"reacted to your message"*) for a feature that has no table, no route and no UI. |
| T144 | `message_attachments` — typed media/file references | W | Implemented as **four nullable columns on `messages`** — `media_url`, `media_type`, `media_thumbnail_url`, `media_duration_seconds` (`baseline:7568-7571`) — which is the exact shape §12.1 forbids. One attachment per message maximum; no typed reference table; no file kind. |
| T145 | `message_translations` — recipient-language derived translation | C | `baseline:7534-7546` — per `(message_id, recipient_id)` row with source/target language, provider, a `translation_status` enum and `error_message`. Written by `services/messageTranslation.ts:1-13`, read scoped to the caller at `routes/messaging.ts:1610-1615`. The best-realised row in this table. |
| T146 | `conversation_decisions` | W | The meetup triple is the analogue (T83); there is no general decision store. |
| T147 | `conversation_action_refs` — references to canonical Plans/Trips/Events/Places | N | No table. References live as untyped fields inside the JSON body (T43), so nothing can be joined, revalidated or revoked. |
| T148 | `availability_signals` | W | `availability_windows` (`migrations/2260_availability_windows.sql:67-100`) is a strong analogue built for **Passport §8**, not this spec, and Telegraph never reads it (T28). |
| T149 | `location_shares` — purpose/audience/precision/expiry scoped | W | Split across two tables and missing the first term. `trip_crew_location_sessions` (`baseline:10507-10521`) has audience (`allowed_member_ids`), precision (`visibility_level` CHECK `city_only|neighborhood|nearby`) and expiry (`expires_at`) — but **no `purpose`**. A twelve-entry purpose registry exists separately (`lib/locationPurposes.ts:103-302`) and is not joined to any share row. |
| T150 | `coordination_sessions` | N | No table, service or route. |
| T151 | `presence_sessions` — ephemeral online/recent activity | W | `circle_presence` (`baseline:4458-4473`) is a genuine ephemeral presence store with `stale_after_secs`, `is_stale` and `expires_at` — but it is **circle-scoped, not conversation-scoped**, so a DM has no presence at all. |
| T152 | `call_sessions` / `call_participants` | C | Both exist (`baseline:1`, confirmed present). `routes/calls.ts:1-12` authorizes *exclusively* through `canUserStartCall`/`canUserStartGroupCall`/`canUserJoinCall` with no inline authorization, mints LiveKit tokens only after that passes, and `migrations/2199_call_participants_rls_recursion.sql` hardens their RLS. |
| T153 | `conversation_reports` / `blocks` | W | `blocks` is real and cascading (T30). Reporting is real but writes to the **unified `reports` table** (`artifacts/api-server/src/routes/messaging.ts:3855#router.post('/threads/:threadId/report', async (req, res) => {` threads, `:2720` messages) — while the two dedicated tables production actually holds, `message_reports` and `thread_reports`, have **no writer and no reader** anywhere in application code. Settled by reading both handlers; their only other appearances are `scripts/rlsDispositions.ts:310,456`, `scripts/frozenLegacyFiles.ts:45-46` and `lib/deletionDispositions.ts:370,441`. |
| T154 | `conversation_outbox` — transactional domain-event outbox | N | No outbox table and no outbox worker. Events are published **after the HTTP response** and outside any transaction (`routes/messaging.ts:1998` responds, `:2020` publishes). |
| T155 | `conversation_snapshots` — rebuild/replay checkpoints | N | Absent. |
| T156 | §12.1 `Message` envelope contract | W | Ten of sixteen fields exist (`id`, `thread_id`, `sender_id`, `msg_type`, `body`, `reply_to_id`, `created_at`, `edited_at`, `deleted_at`, `original_language` — `baseline:7553-7574`). The six that are absent are the six that carry the guarantees: **`sequence`, `contentRef`, `unsentAt`, `clientMessageId`, `idempotencyKey`, `lifecycleState`**. |
| T157 | Avoid a giant unversioned `metadata_json` and dozens of nullable FKs on `messages` | W | Half right. There is no `metadata_json` column — but the structured payload is an **unversioned JSON string stuffed into `body`** and parsed per-subtype at the client (`components/DiscoveryCardMessage.tsx:37-45`, `components/CircleStatusCardMessage.logic.ts:43-52`), which is the same anti-pattern under a different column name. `messages` also carries four nullable media columns plus `reply_to_id` and `ciphertext`. |
| T158 | Structured payload types use versioned schemas and explicit reference tables | N | No version field on any card payload and no reference table. See also T429–T431. |

### §13 Commands & Events

| id | Command (§13.1) | V | Evidence |
| --- | --- | --- | --- |
| T159 | `SEND_MESSAGE` | C | `routes/messaging.ts:1734`. |
| T160 | `EDIT_MESSAGE` | C | `routes/messaging.ts:2333`. |
| T161 | `UNSEND_MESSAGE` | N | Absent (T75). |
| T162 | `DELETE_MESSAGE` | C | `routes/groupChat.ts:340-381` — sender-only, active-member-only, redacts the body. |
| T163 | `ADD_REACTION` | N | No route, no table (T143). |
| T164 | `ACCEPT_REQUEST` | C | `routes/messaging.ts:891#router.post('/message-requests/:requestId/accept', async (req, res) => {`. |
| T165 | `DECLINE_REQUEST` | C | `routes/messaging.ts:840`; cancel at `:879`. |
| T166 | `CREATE_DECISION` | W | Only in the meetup shape: `routes/telegraphChat.ts:11-12` `/create-meetup` and `/start-poll`. No general decision command. |
| T167 | `CAST_VOTE` | C | `meetup_time_votes` (`baseline:7336`) via `rsvpMeetup` (`app/messages/[id].tsx:48`). |
| T168 | `CREATE_COORDINATION_SESSION` | N | Nothing (T85). |
| T169 | `SET_COORDINATION_STATUS` | W | Approximated by circle check-in (`routes/circle.ts:300`, subtypes at `components/CircleStatusCardMessage.logic.ts:57`); not a conversation command and not the §9.1 vocabulary. |
| T170 | `SHARE_LOCATION` | W | Exists outside Telegraph only (T96). |
| T171 | `STOP_LOCATION_SHARE` | C | `routes/safeReturn.ts:17` `POST /me/safe-return/sessions/:id/live-share/stop`; `trip_crew_location_sessions.status` transitions to `stopped` (`baseline:10515-10520`). Revocation is a first-class operation on both stores. |
| T172 | `SET_AVAILABILITY` | C | `routes/availability.ts:162#router.patch("/me/quick-availability"` PATCH quick-availability and `routes/availability.ts:725#router.post("/me/availability-windows"` POST availability-windows (flag-gated by `open_to_plans_windows_enabled`, `:42`). |
| T173 | `STOP_AVAILABILITY` | C | `routes/availability.ts:776` DELETE `/me/availability-windows/:id` → `clearWindow` (`services/passport/OpenToPlansService.js`). |
| T174 | `BLOCK_USER` | C | `routes/blocks.ts:46` with the cascade at `:60-78`. |
| T175 | `MUTE_THREAD` | C | `routes/messaging.ts:2540` → `message_thread_members.muted_at` (`baseline:7500`). |
| T176 | `REPORT_MESSAGE` | C | `routes/messaging.ts:2709-2738`, writing the unified `reports` table with `target_type:'message'` and invalidating the reporter's Compass cache at `:2735`. |

| id | Event (§13.2) | V | Evidence |
| --- | --- | --- | --- |
| T177 | `message.sent` | C | Published as `message.created` (`lib/telegraphEvents.ts:24`), emitted at `routes/messaging.ts:2020-2035` with the sender excluded. Renamed, semantically identical. |
| T178 | `message.delivered` | N | No delivered concept exists to emit (T69). |
| T179 | `message.seen` | W | `read.updated` (`lib/telegraphEvents.ts:30`) is published at `routes/messaging.ts:1231-1236` — but it carries a **thread-level** `lastReadAt`, not a per-message seen fact, so no consumer can answer "was *this* message seen". |
| T180 | `message.edited` | C | `message.updated` (`lib/telegraphEvents.ts:33#message.updated`), published `routes/messaging.ts:2394-2399`. |
| T181 | `message.unsent` | N | Absent. PR #472 adds no event either — its diff against `lib/telegraphEvents.ts` is **empty**. |
| T182 | `message.deleted` | N | Not in the event union (`lib/telegraphEvents.ts:22-49`), and `routes/groupChat.ts:340-381` publishes nothing at all — a delete reaches other clients only on their next poll. |
| T183 | `thread.requested` | C | `request.created` (`lib/telegraphEvents.ts:31`). |
| T184 | `thread.accepted` | C | `request.accepted` (`:32`); `request.declined` at `:33`. |
| T185 | `member.joined` | N | Not in the union; only `member.left` exists. A trip-membership sync (`services/groupChatSync.ts`) is silent to open clients. |
| T186 | `member.left` | C | `lib/telegraphEvents.ts:27`. |
| T187 | `availability.started` | N | Not in the union. |
| T188 | `availability.expired` | N | Not in the union; expiry is evaluated lazily on read (`2260:38-42`) and emits nothing. |
| T189 | `location.started` | N | Not in the union. |
| T190 | `location.expired` | N | Not in the union. |
| T191 | `coordination.started` | N | No coordination (T85). |
| T192 | `coordination.completed` | N | Same. |
| T193 | `user.blocked` | C | `lib/telegraphEvents.ts:88#user.blocked`, with `access.revoked` (`:47`) closing live SSE connections whose access has gone. |
| T194 | `safety.reported` | N | Not in the union; reports write a row and emit nothing. |
| T195 | Canonical mutation and event-outbox write occur in the **same database transaction** | N | There is no outbox. `routes/messaging.ts:1998` sends the 201, then `:2020` and `:2032` publish, then `:2039` translates — all after the response, all outside any transaction. A crash between insert and publish loses the event with no replay path. |
| T196 | Push, realtime, indexing, translation, moderation, analytics and projections consume asynchronously and **idempotently** | W | Asynchronous: yes, and deliberately — `lib/telegraphEvents.ts:14-16` states publish failures are logged and swallowed *"so realtime delivery can never break a write path"*, with client polling self-healing. **Idempotent: no.** Without an outbox, event ids or dedup keys, a retried consumer double-applies. The single exception is notifications: `services/notifications/NotificationDeduplicationService.ts:42-45` coalesces `telegraph.message` by `sourceId`. |

### §14 Authorization & Conversation Policy

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T197 | Capability `canSendMessage` | C | Resolved server-side and re-checked per send: `lib/messagingPermissions.ts:29-45` (verdict ladder incl. `message_privacy` and mutual-block), enforced at `routes/messaging.ts:1765-1773` (membership) and `:1779-1793` (pairwise block, fail-closed via `isBlockedBetween`). |
| T198 | Capability `canCall` | C | `routes/calls.ts:17-20` — every endpoint authorizes exclusively through `canUserStartCall` / `canUserStartGroupCall` / `canUserJoinCall`, with the `whoCanCall` preference read by `getFullCallPreferences` (`:26`). |
| T199 | Capability `canCreatePlan` | W | No capability flag exists; plan creation is gated implicitly by thread membership plus a re-verified trip membership at execution (`routes/telegraphCommands.ts:390-444`). The enforcement is real; the capability is not modelled. |
| T200 | Capability `canShareExactLocation` | W | Precision is a property of the *session* (`trip_crew_location_sessions.visibility_level`, `baseline:10518`), not a conversation capability, and no conversation ever grants or denies it. |
| T201 | Capability `canInvite` | N | There is no invite operation on a thread at all (T212). |
| T202 | Capability `canRequestPayment` | N | No payment request in Telegraph. The nearest thing is the off-app solicitation *detector* (`routes/messaging.ts:1875-1942`), which is the opposite concern. |
| T203 | Capability `canCreateBooking` | W | Booking gates exist and are real (`checkBookingKycGate` / `enforceBookingCreationGates` in the Rent-a-Buddy tree) but they are not conversation capabilities and are not evaluated per thread. |
| T204 | Capability `canBroadcast` | N | No broadcast concept (T415–T417). |
| T205 | Capability `canViewPreMembershipHistory` | W | Not modelled — **and the rule it would express is violated**. See T211. |
| T206 | Capability `canSeeGroupReadReceipts` | N | No group read receipts exist to gate (T73). |
| T207 | Capabilities derived server-side from membership, block state, Trip/Crew membership, booking state, age/policy, location scope, safety state and conversation type | W | A genuine server-side resolver exists — `services/interactionPermissions.ts:597-632` folds blocks, follows, friendships, trust restrictions and age into a verdict, and `routes/messaging.ts:290-305` treats a resolver throw as `db_error` rather than permission — but it is a **pairwise interaction** resolver returning two booleans (`canMessage`, `canSendMessageRequest`), not a conversation-scoped capability set over the nine named inputs. |
| T208 | UI renders capabilities; it does not invent authorization | C | No client-supplied flag is trusted anywhere. Every mutating route re-derives authorization: membership `routes/messaging.ts:1765-1773`; block fail-closed `:1779-1793`; edit ownership `:2365-2369`; delete ownership + active membership `routes/groupChat.ts:355-360`; `verifyThreadMember` on every suggestion call `routes/telegraphChat.ts:45-56`; command confirmation re-verifies trip membership at execution `routes/telegraphCommands.ts:390`. |
| T209 | Authorization is checked **both** when sending and when reading | C | Reads re-authorize as thoroughly as writes: `routes/messaging.ts:1560-1570` re-checks active membership on every page of messages; `:1610-1615` scopes translations to `recipient_id = user.id`; `:1596-1600` re-applies `nameVisibilitySet` per read so an identity that stopped being visible stops being returned. |
| T210 | `visibleFromSequence` / `visibleUntilSequence` on members | N | Neither column exists, under any name; a repository-wide search for `visible_from` / `visible_until` returns nothing. |
| T211 | New members do not automatically receive pre-membership history | W | **Violated.** `routes/messaging.ts:1577-1585` selects from `messages` filtered on `thread_id` and ordered by `created_at`, with the only gate being *current* active membership (`:1560-1570`) — no `joined_at` bound of any kind. `services/groupChatSync.ts:9-13` adds every newly-accepted trip member to the trip thread, and `syncCircleChatMembers` does the same for circles, so a new member can immediately page back through the entire prior conversation. |
| T212 | Adding a third person to a DM creates a new group; it does not expose the old DM history | N `∅` | Unguarded absence: **no add-participant operation exists at all** — group threads are created only by trip/circle membership sync (`services/groupChatSync.ts:9-20`), and no route adds a member to a `direct` thread. The rule is currently unviolated only because the operation is missing, and T211 shows the read path would leak the moment it were added. |
| T213 | Explicitly selected Plans/Places may be carried forward as new share objects | N | No carry-forward on group formation. |

### §15 Location, Proximity & Safety

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T214 | `LocationShare` — purpose / audience / precision / expiry / lifecycle | W | Three of five. `trip_crew_location_sessions` (`baseline:10507-10521`) carries audience (`allowed_member_ids`), precision (`visibility_level` CHECK `city_only\|neighborhood\|nearby`) and expiry (`expires_at NOT NULL` + a status CHECK `active\|stopped\|expired`). **No `purpose` column** and no `LIVE\|RECENT\|LAST_KNOWN\|EXPIRED` lifecycle vocabulary. |
| T215 | A meetup grant cannot be silently reused for general Nearby discovery or future tracking | W | The purpose *registry* is real and ratcheted — twelve purposes with lawful basis, precision class and retention (`lib/locationPurposes.ts:103-302`), guarded by `scripts/checkLocationPurposes.ts` — but **no share row carries a purpose** (T214), so nothing binds a grant to one. Reuse is prevented only because there is no Nearby to reuse into. |
| T216 | Expired location becomes inaccessible, not merely hidden in UI | C | Server-side and structural. Recipient access runs through `requireSafeReturnRecipient` **before the handler** (`routes/safeReturn.ts:660-661`), the module states *"exact coords never appear in API responses (enforced by `toPublicSession`)"* (`:22`), and the session status CHECK admits `expired` as a terminal state (`baseline:10520`). Expiry removes the read, not the render. |
| T217 | Safety mode NORMAL → SAFETY_ATTENTION → SAFETY_EVENT | W | Two escalation ladders exist and neither is this one: Safe Return sessions escalate via `trigger-missed` (`routes/safeReturn.ts:13`) into `safe_return.missed` / `trusted_circle_alert` urgent notifications, and circle presence escalates via `needs_help` (`routes/circle.ts:1556-1589`). Neither is a conversation-level mode. |
| T218 | Safety mode promotes trusted contact, status, help, route/return, call, block/report; de-prioritizes entertainment | W | Every named affordance exists — `components/ThreadSafetySheet.tsx` in the thread, trusted contacts (`routes/safeReturn.ts:22`), call entry (`app/messages/[id].tsx:1699-1716`), block/report (`:57,59`) — but nothing **promotes** or **de-prioritizes**: the surface never reorders. |
| T219 | Block cascade across direct delivery, location, presence, Nearby, Bump discovery, shared-memory resurfacing, Crew suggestions and Compass retrieval | W | Five of eight have real enforcement: delivery (`routes/messaging.ts:1788-1792`), Compass (`compass/CompassTools.ts:1246` `refreshHiddenUsers`), discovery (`test/discoverySearchBlockedSubmitter.test.ts`), memories (`test/memoriesBlockFailClosed.test.ts`), Buddy search (`test/rentABuddySearchBlocks.test.ts`). Nearby, Bump and Crew suggestions have no referent; shared-memory resurfacing is covered. |
| T220 | No subsystem may independently "rediscover" a blocked relationship | W | The right architecture is in place — one shared fail-closed helper, `lib/blockGuard.ts` `isBlockedBetween`, consulted rather than reimplemented, plus `refreshHiddenUsers` for the Compass tool surface. **But in main the read that decides whether to consult it fails open**: `routes/messaging.ts:1783-1788` destructures only `{ data: otherMembers }`, and because supabase-js *resolves* rather than throws, a transient failure yields `null`, `?? []` turns an unreadable membership table into "this thread has no other members", `others.length === 1` is false, and the whole pairwise block guard is skipped. The same hole exists on the media send path (`:2139-2144`). PR #472 fixes both; it is unmerged. |

### §16 Media Pipeline

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T221 | `MediaAsset != Message != Memory`; attachments and Memory links both point at a MediaAsset | W | The canonical asset store exists and is well built (`lib/mediaAssets.ts:94-160`, with EXIF capture-time extraction at `:62-80`) — but **message media does not use it**: `routes/messaging.ts:2176` writes `media_url` / `media_type` / `media_thumbnail_url` straight onto the `messages` row. Telegraph is the surface that did not adopt the separation. |
| T222 | Progressive ladder: local preview → thumbnail/poster → streamable rendition → original | W | Two rungs. The client shows a local preview through its upload states (`hooks/useMessageMediaPicker.ts:30` `idle\|picking\|previewing\|uploading\|done\|failed`) and a thumbnail is stored (`messages.media_thumbnail_url`). There is no streamable rendition and no original/derivative distinction for message media. |
| T223 | Resumable / chunked upload for poor travel connectivity | N | `hooks/useMessageMediaPicker.ts:60,66` offers upload progress, cancel and retry — but retry restarts the transfer. No range, no chunking, no resume token. |
| T224 | Poster/frame generation and adaptive renditions for video | W | Poster/thumbnail generation exists in the shared processor (`lib/mediaProcessing.ts:154-210`, sharp re-encode with full metadata strip); adaptive renditions do not exist for any surface. |
| T225 | Waveform generation for voice as derived metadata | N | No voice (T53); `lib/mediaPipeline.ts:75` `ALLOWED_MEDIA_MIME` admits no audio type. |
| T226 | Media scanning/moderation must not block basic text delivery | C | Structurally impossible to block it: text and media are separate endpoints (`routes/messaging.ts:1734` vs `:2069`), and the sniff/size/rate policy runs at *upload* time in `lib/mediaPipeline.ts:187-227` — a path a text send never enters. |
| T227 | Data-saver mode prioritizes text/status/coordinates over media/AI | N | No data-saver setting exists in the client. |

### §17 Offline, Realtime & Multi-Device

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T228 | Per-conversation server sequence ordering, not global ordering | N | No sequence column exists. Ordering is `created_at DESC` with a `created_at` cursor (`routes/messaging.ts:1581-1585`), which cannot distinguish two messages written in the same millisecond and cannot express "after event N". |
| T229 | Client timestamps are advisory only | C | The server generates the timestamp itself and never reads one from the body: `routes/messaging.ts:1822` `const now = new Date().toISOString()`, written at `:1853` `created_at: now`. There is no `createdAtClient` field to trust. |
| T230 | Offline command fields: `clientMessageId`, `idempotencyKey`, `createdAtClient`, `syncState` | W | One of four, and it is **not persisted**. `clientId` is accepted (`routes/messaging.ts:1763`), echoed in the response (`:2007`) and in the realtime payload (`:2031`) — but the insert at `:1848-1861` does not include it, so the server retains no correlation key after the request ends. |
| T231 | Offline resend must be idempotent | N | Direct consequence of T230: nothing is stored to deduplicate against, there is no unique constraint on any client key and the write is an `insert`, not an `upsert`. A retried send creates a second message. |
| T232 | Tombstones preserve sequence continuity for unsent/deleted messages | W | The tombstone half is real and deliberate — the row is retained and redacted in place rather than removed (`routes/groupChat.ts:363-372`, with the `body: ''` choice documented because `body` is `NOT NULL`), and the reader returns it as a suppressed slot (`routes/messaging.ts:1719`). There is no sequence for it to keep continuous. |
| T233 | Reconnect resumes from the last acknowledged conversation/event sequence | N | The SSE stream carries no cursor: `routes/telegraphStream.ts:36-40` closes at 30 minutes with a `reconnect` event and the client re-authenticates from scratch. Gap recovery is delegated entirely to polling (`lib/telegraphEvents.ts:15-16`). |
| T234 | Seen/delivery state, edits and canonical thread state converge server-side | W | Edits and thread state converge properly (one server-authoritative row; `routes/messaging.ts:2371`). Seen converges at **thread** granularity only. Delivery has no state to converge (T69). |
| T235 | Active precise location is device-specific and must not automatically transfer to a newly authenticated device | N | Both location stores are keyed by `user_id` alone — `location_sessions` (`baseline:7109`) and `trip_crew_location_sessions` (`baseline:10509`) carry no device column — so a live share follows the *account*. The device registry that exists (`routes/devices.ts:1-16`) is an MLS crypto-key registry and is not consulted by any location path. |
| T236 | Realtime gateway failure → polling / delta fallback | C | Designed in, and stated: `routes/telegraphStream.ts:13-15` — *"The mobile client always retains polling as a fallback, so this transport is an enhancement, never a hard dependency"*; `lib/telegraphEvents.ts:14-16` — publish failures are logged and swallowed *"so realtime delivery can never break a write path"*, and *"any missed event self-heals on the next poll."* |
| T237 | Push failure → no loss of canonical messages; push is wakeup/fallback, not consistency authority | C | The row is inserted (`routes/messaging.ts:1848`) and the 201 sent (`:1998`) before any notification work; dispatch is `Promise.allSettled` inside a try/catch explicitly labelled non-fatal (`:1977-1992`). |
| T238 | Translation / AI / maps failure → core messaging continues | C | `services/messageTranslation.ts:11` — *"Falls back to `status: failed` on any error — never throws"* — and the call site adds an outer net (`routes/messaging.ts:2039-2046`). Tagging is wrapped the same way (`:1964-1992`). Suggestion generation is a separate endpoint entirely. |
| T239 | Low bandwidth → deprioritize typing, reactions, media preview and AI before text or safety | N | No bandwidth signal and no degradation ladder. Typing happens to be realtime-only (T258), which is adjacent but not adaptive. |

### §18 Translation, Voice & Compass

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T240 | `MessageTranslation` contract | W | Six of eight fields: `message_id`, `target_language`, `translated_body`, `provider`, `created_at`/`updated_at`, plus `status` and `error_message` the spec does not ask for (`baseline:7534-7546`). **Missing `providerVersion` and `confidence`** — and the absence of `confidence` is what makes T242 fail. |
| T241 | Store the original text/audio; translation never replaces it | C | The original stays in `messages.body`; the translation is a separate row keyed by recipient; the read path returns both and says which is which — `displayBody` / `originalBody` / `originalLanguage` / `translated` / `canShowOriginal` (`services/messageTranslation.ts:31-38`), assembled at `routes/messaging.ts:1610-1615`. Nothing overwrites the source. |
| T242 | Low-confidence operational translation shows original **plus** translation instead of pretending certainty | W | The *mechanism* exists (`canShowOriginal`, `components/TranslationSettingsSheet.tsx`) but it is driven by a **user preference** — `profiles.show_original_messages` (`migrations/0098_profile_translation_prefs.sql:14`) — not by confidence. There is no confidence value to threshold on (T240); `validateTranslation` (`lib/translation`) checks validity, not certainty. |
| T243 | Voice pipeline AUDIO → TRANSCRIPT → optional TRANSLATION, audio authoritative | N | No voice messages (T53), no transcription. |
| T244 | Compass tool `getConversationContext()` | W | Not a Compass tool, and not conversation-scoped: `routes/telegraphChat.ts:5-6` accepts `?message=<text>` for a **single** message and runs `detectIntent` (`services/telegraphIntent.ts`) behind `resolvePrivacyVerdict` (`services/telegraphChatSuggestions.ts:81`). The privacy posture is right; the accessor the spec names does not exist. |
| T245 | Compass tool `getSharedPlans()` | N | Not in the tool set (`compass/CompassTools.ts` registers eleven tools; none is this). |
| T246 | Compass tool `getParticipantAvailability()` | N | Not present. `get_whos_around` returns presence for circles, not participant availability for a conversation. |
| T247 | Compass tool `getSharedPlaces()` | N | Not present. |
| T248 | Compass tool `suggestMeetingPoint()` | N | Not present. Meeting points are set by a circle host (T86), never suggested. |
| T249 | Compass tool `createPlanDraft()` | W | Exists under another name and outside Compass: `routes/telegraphCommands.ts:34` `create_meetup_draft` produces a `ProposedAction` that cannot execute unconfirmed (`:57`). Correct behaviour, wrong surface. |
| T250 | Compass tool `findSafePublicMeetup()` | N | Not present. |
| T251 | Compass tool `searchAuthorizedConversationContent()` | N | Not present; there is no conversation search at all (T272). |
| T252 | Compass sees only data authorized to the conversational context | C | Three gates, all fail-closed. `services/telegraphChatSuggestions.ts:27#export interface TelegraphChatPrivacyVerdict` — `TelegraphChatPrivacyVerdict` decides what context is safe *before* any suggestion is built; `services/telegraphChatSuggestions.ts:237-255#show_telegraph_dm, show_telegraph_trip, show_telegraph_circle` reads the per-surface opt-out (`show_telegraph_dm` / `_trip` / `_circle`) and returns `reason:'telegraph_disabled'` when off; `routes/telegraphChat.ts:17-21` states thread membership is verified on every call, trip/circle context is used only for confirmed members, and no GPS or live location is ever returned. |
| T253 | Compass cannot reveal one participant's private Memory/preferences to another, impersonate participants, or silently create canonical plans from uncertain prose | C | All three, separately enforced. Cross-participant leakage: the privacy verdict above plus `compass/CompassTools.ts:248` — *"never mention a person a tool did not return … NEVER guess, infer, triangulate"*. Impersonation: suggestions render as a labelled tray (`components/TelegraphSuggestionTray.tsx`), never as a participant's message. Silent creation: `requires_confirmation: true` as a literal type (T101). |

### §19 Notifications & Attention

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T254 | P0 Safety — interruptive; bypasses ordinary batching where policy requires | C | A genuine override exists: `services/notifications/NotificationPreferenceService.ts:6-7` — *"Quiet hours: skip push during window UNLESS urgent or admin priority"* and *"Safety override: urgent + admin priority always deliver even when push is off"*, backed by a stored `safety_override` flag (`:59`). Safety events actually carry `urgent`: `safe_return.reminder`, `.missed`, `.trusted_circle_alert`, `.check_in_prompt`, `circle.need_help_host_alert`. |
| T255 | P1 Coordination — immediate / high priority | W | `important` exists and is used for coordination-shaped events (`NotificationTemplateService.ts:67,105,118,130,169,188`) but it carries **no delivery difference** from `normal` — only `urgent` changes behaviour (T254). It is a label, not a priority. |
| T256 | P2 Message — standard notification policy | C | `NotificationTemplateService.ts:215-222` — `telegraph.message`, `defaultPriority:'normal'`, `defaultChannels:['in_app','push','telegraph']`, deduped by `sourceId` at `NotificationDeduplicationService.ts:42-45`. |
| T257 | P3 Media — large upload completion, passive/batched | N | No media-completion notification and no batching mechanism. |
| T258 | P4 Ephemeral — typing, lightweight presence: realtime only, no persistent push | C | Structurally guaranteed. `routes/telegraphStream.ts:6-7` — *"typing relay (**no persistence**)"* — and there is **no typing template at all** in `NotificationTemplateService.ts`, so no push path can exist for it. `typing.started` / `typing.stopped` live only on the in-memory bus (`lib/telegraphEvents.ts:28-29`). |
| T259 | P5 AI — lowest priority, degrades first | W | The priority half is right: `telegraph.ai_suggestion` is `defaultPriority:'low'` on `['in_app']` only — no push (`NotificationTemplateService.ts:233-240`). The *degrade-first* half does not exist: there is no load-shedding ladder anywhere. |
| T260 | Inbox displays "12 unread · 1 needs action" | W | Unread is real and carefully built (`routes/messaging.ts:917-962`, with a schema-drift fallback when migration 0016's `last_read_at` is absent, `:942-945`). **"Needs action" has no representation** — nothing distinguishes a message from an unresolved decision. |
| T261 | Acknowledgment for important operational changes is distinct from passive Seen | N | No acknowledgement primitive for any message or card. (Safe Return contacts carry `acknowledged_at`, `services/safeReturn/SafeReturnService.ts:75`, which is a different object.) |

### §20 Source-Domain Integrations

| id | Domain | V | Evidence |
| --- | --- | --- | --- |
| T262 | **Trips** — crew threads, shared Trip cards, today/next context, membership authorization, Trip Kernel commands | W | Two of five. Crew threads are real and auto-synced (`routes/messaging.ts:2426` `GET /trips/:tripId/chat`, `services/groupChatSync.ts:9-13`) and membership authorizes (`isAcceptedTripMember`, `routes/telegraphCommands.ts:463`). No shared Trip card, no today/next context, no Trip Kernel commands. |
| T263 | **Plans** — invitation, RSVP, changes, dependencies, coordination trigger | W | Invitation and RSVP are real (`meetup_invites`, `components/RsvpBar.tsx`, `app/messages/[id].tsx:2172`); change cards exist for meeting points (`routes/circle.ts:1377`). No dependencies and no coordination trigger (T103). |
| T264 | **Events** — share card, attendance, live status, timing changes | W | An `event_context_card` subtype exists in the message vocabulary, but no attendance, live status or timing-change surface renders in a thread. |
| T265 | **Places / Hidden Gems** — share, save, meet here, add to Trip, current intelligence | W | Three of five, and they are the card's own action row: *View / Add to Plan / Save* (`components/DiscoveryCardMessage.tsx:1-9`, save via `services/discoveryBookmarks.toggleSave`, add via `components/discovery/TripWishlistPicker.tsx`). No "meet here" from a card (T91) and no live intelligence — the card is a frozen snapshot (T46). |
| T266 | **Discovery** — Discover Together; shared opportunity set from availability, time and context | N | Sharing a discovery card is not "Discover Together". No shared opportunity set exists; Telegraph reads neither availability nor time context. |
| T267 | **Compass** — authorized thread context, meeting/recommendation tools, catch-up | W | Thread context and recommendation are real and privacy-gated (`components/CompassTelegraphTray.tsx`, `services/compass.checkCompassTelegraphAvailable`, `components/CompassCardMessage.tsx`; server `routes/telegraphChat.ts`). Meeting tools (T248) and catch-up do not exist. |
| T268 | **Memories** — safe share derivatives, Memory Notes, explicit Save to Memory, post-experience recap | W | One of four, and it is broken: Save exists and writes nowhere useful (T119). No derivatives, no Memory Notes, no recap. |
| T269 | **Buddy / Visa Buddy** — protected booking/operational layer; **no chat mutation of price/terms** | C | The booking layer is real (`components/rentabuddy/BookingMilestoneMessage.tsx` dispatched at `app/messages/[id].tsx:1862`; a booking owns its thread via `rent_buddy_bookings.telegraph_thread_id`, read at `routes/messaging.ts:1887`; booking-scoped call eligibility at `routes/calls.ts:26`). The prohibition is **actively enforced, not merely unviolated**: no message write path reaches a booking, and `routes/messaging.ts:1875-1942` runs a 14-pattern off-app solicitation detector that logs an admin-only event and auto-suspends the buddy profile past a threshold — with both writes error-checked because *"a silently failed update here leaves a repeat off-app solicitor ACTIVE with no trace"* (`:1917-1936`). |
| T270 | **Safety** — Safe Return, help states, location scope, block/report | C | All four. Safe Return end-to-end (`routes/safeReturn.ts:6-23`), help states (`circle_presence.needs_help`, `routes/circle.ts:1556-1589`), location scope (`trip_crew_location_sessions.visibility_level`), block/report (`routes/blocks.ts:46`, `routes/messaging.ts:2616`, `:2709`), plus an in-thread safety sheet (`components/ThreadSafetySheet.tsx`). |
| T271 | **Map** — meet points, routes, contextual shared map; **no historical movement trail** | W | Meeting points exist (`circle_meeting_points`, `routes/circle.ts:1272-1377`). There is no contextual shared map in a thread and no route share (T93). The prohibition half holds structurally: `trip_crew_location_sessions` keeps a single `last_location_snapshot_id` (`baseline:10519`) — a pointer to one snapshot, not a trail. |

### §21 Search & Retrieval

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T272 | Telegraph search is object-aware and authorization-scoped | N | **There is no conversation search of any kind.** `routes/messaging.ts` (2,731 lines, 30 endpoints) contains no search route, and neither does `routes/groupChat.ts`. The inbox filter (`components/TelegraphInboxScreen.tsx:33-39`) filters loaded threads client-side. |
| T273 | Multi-type results: MESSAGES / PLACES / MEDIA / PLANS / MEMORIES | N | No search. |
| T274 | Index message text, permitted transcripts, object titles and safe metadata | N | Nothing indexes conversation content. |
| T275 | Private semantic indexes filter access **before** retrieval, not after | N `∅` | Unguarded absence: no semantic index over conversations exists. (Compass's own tools do gate before retrieval — `compass/CompassTools.ts:902` `sharesSocialContext`, `:904` trust floor — but they index no message content.) |
| T276 | Unsent/deleted/revoked objects removed from normal user search and Compass retrieval | W | Partial, in the one place it can act. Deleted message bodies are suppressed on read (`routes/messaging.ts:1719`) and a report invalidates the reporter's Compass cache (`:2638`, `:2735`). But deleted **media survives** in main (T79) and revoked source objects survive inside cards forever (T46). |
| T277 | "Ask this conversation" prefers structured plans/decisions/actions over inferred prose | N | No ask-this-conversation surface. The suggestion tray runs on a single typed message, not on the conversation. |

### §22 Abuse, Moderation & Travel Scam Safety

| id | Control | V | Evidence |
| --- | --- | --- | --- |
| T278 | Requests carry contextual origin: Event, Trip, Nearby, Bump, Buddy, profile | N | `message_requests` has no origin column at all (`baseline:7477-7488`) — only `preview_text`. A recipient cannot be told why a stranger is reaching out. |
| T279 | Rate limits adaptive to relationship, verification, trust, account age and reports | W | Two divergences in one row. **Message sending has no rate limit at all** — `routes/messaging.ts` contains no `checkRateLimit` call; the only limiter in the messaging tree is on AI suggestions (`routes/telegraphChat.ts:88`). The adaptive machinery does exist, and is applied only to the *request* step: `resolveInteractionPermissions` plus `getRestrictionState` fold trust restrictions and account state into request eligibility, with a `DegradedPermissionCheckError` path so a failed trust read is not mistaken for permission (`routes/messaging.ts:432-562`, six dedicated tests at `test/messaging.test.ts:519-631`). |
| T280 | Stranger media can be blurred / no autoplay until accepted | N | `components/MessageMediaBubble.tsx:170` renders and autoplays unconditionally. The request-acceptance gate means a stranger cannot open a thread at all, which mitigates the risk but does not implement the control. |
| T281 | Links/files: reputation/scanning; reserved official identities | N | No link scanning, no URL reputation, no reserved-identity list. There is no file kind (T40). |
| T282 | Travel scam signals: off-platform payment, fake taxi, visa help, ticket resale, fake hotel, urgent money request | W | **One of six, and that one is real and enforced.** `routes/messaging.ts:1875-1895` — a 14-pattern off-app payment detector (`off-app`, `pay outside`, `venmo me`, `cashapp`, `my whatsapp`, …) scoped to buddy-booking threads and attributed only when the sender *is* the buddy (`:1898-1906`), escalating to auto-suspension past `OFF_APP_SUSPENSION_THRESHOLD` (`:1915-1937`). No detector exists for the other five families. |
| T283 | Evidence: store minimum necessary reported content/context under restricted policy | W | Minimal, arguably too minimal: a report row carries reporter, target type/id and a 200-character `reason_detail` (`routes/messaging.ts:2622-2633`) and **no content snapshot** — so a message deleted after being reported leaves a moderator with a pointer to a redacted row. |
| T284 | Reported deleted content may remain in restricted moderation storage but not normal retrieval | N | The opposite happens. Deletion redacts in place — `routes/groupChat.ts:609#.update({ deleted_at: now, body: '' })` `.update({ deleted_at: now, body: '' })` — with nothing copied to moderation storage first, so reported content is **destroyed**, not restricted. |

### §23 Backend Package Boundaries

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T285 | `src/domain/telegraph/{contracts,commands,events,policies,invariants,services,projections,replay}` | N | No `domain/` directory exists. `artifacts/api-server/src/` is `app.ts · compass · lib · middlewares · migrations · presence · routes · scripts · security · services · test · types`. |
| T286 | `src/features/telegraph/{home,conversation,nearby,shared-context,coordination,composer,media,search}` | W | One eighth exists: `travel-buddy-standalone/src/components/telegraph/TelegraphPrimitives.tsx`. Everything else is flat in `src/components/` (fifteen `Telegraph*`/`*Message` files). The pattern **is** established in the same tree — `src/features/wall/` has `components/`, `hooks/`, `services/`, `theme/` — and Telegraph did not adopt it. |
| T287 | `server/telegraph/{commandRoutes,readRoutes,realtimeGateway,outboxWorker,projectionWorkers,notificationWorker,mediaAdapters,integrationAdapters}` | W | Two of eight exist as files rather than a package: the realtime gateway (`routes/telegraphStream.ts` + `lib/telegraphEvents.ts` + `lib/telegraphBroadcast.ts`) and a notification worker (`services/notifications/NotificationRouter.ts`). No outbox worker (T154), no projection workers, no adapter layer. |
| T288 | Trips, Buddy, Safety, Memories, Discovery and Compass remain integrations; Telegraph does not embed their canonical business logic | C | **Structurally true, and this is the spec's Primary Invariant.** `routes/messaging.ts` writes only `messages`, `message_threads`, `message_thread_members`, `saved_messages`, `message_translations` and `reports` — no trip, booking, memory or place write exists in the messaging tree. Domain effects are owned elsewhere and re-authorized at execution: circle cards written by `routes/circle.ts:300`, booking milestones by the Rent-a-Buddy tree, trip actions by `routes/telegraphCommands.ts:390` which re-verifies trip membership before executing a confirmed proposal. |

### §24 Projection Architecture

| id | Projection | V | Evidence |
| --- | --- | --- | --- |
| T289 | `TelegraphHomeProjection` — conversation list + badges + Now + nearby summary | W | The list half is a real server-built projection: `artifacts/api-server/src/routes/messaging.ts:1898#router.get('/me/threads', async (req, res) => {` `GET /me/threads` resolves the other participant's display identity under `nameVisibilitySet`, folds in unread counts and thread type. No Now band and no nearby summary (T8). |
| T290 | `ConversationProjection` — renderable ordered thread **with current permissions** | W | The renderable half is real and careful: `routes/messaging.ts:1552-1732` sanitizes sender identities per viewer, joins per-recipient translations, resolves reply context and enriches mention/hashtag spans. It carries **no permissions block**, and it does not bound history (T211). |
| T291 | `SharedContextProjection` | N | Does not exist (T21). |
| T292 | `NearbyAvailableProjection` | N | Does not exist. |
| T293 | `CoordinationProjection` | N | Does not exist (T85). |
| T294 | `ConversationContentIndex` — media/places/Portava/voice/GIF/links/files drawer | N | Dead-coded behind a literal `false` (T66). |
| T295 | Mobile clients consume server-built projections instead of independently joining raw tables and reimplementing authorization | W | Mostly true and then not: `src/services/messaging.ts` goes through `fetch(apiBase()…)` for every message operation (`:240,256,274,607,628,653`). But the conversation screen makes **two direct PostgREST reads of a raw messaging table**, one of which recomputes authorization client-side: `app/messages/[id].tsx:1247-1252` (member count) and `:1260-1266` (*"Permission gate: accepted thread members only"* — a `message_thread_members` select whose result sets `isAcceptedMember`). The server does not trust it (T364), so this is a layering violation rather than a security hole. |

### §25 Migration & Compatibility Strategy

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T296 | Phase 0: inspect existing messaging schema, migrations, RLS, client routes, realtime subscriptions, push flow, media upload paths, translation paths and current enum literals | N | The T0 inventory artifact does not exist. There is no Telegraph inventory document in `docs/`, and no file in the tree records this inspection. The *capability* to do it exists as standing CI lanes (T297); the deliverable does not. |
| T297 | Compare production and CI schemas before writing migrations | C | Four standing lanes do exactly this: `scripts/auditMigrationsVsLive.ts`, `scripts/checkProductionDrift.ts`, `scripts/checkMissingLiveColumns.ts`, `scripts/auditLiveVsCanonical.ts`. Built by the migration programme, not this spec. |
| T298 | Identify direct client writes and legacy JSON fields; create ratchets before introducing new paths | C | `scripts/checkAuthorizationContract.ts:1-18` fails CI when a protected table regains broad `anon`/`authenticated` mutation privileges or a server-derived column becomes client-writable — *"a migration that reopens one of these must update the contract IN THE SAME PR or CI goes red."* Plus `scripts/checkSilentSupabaseWrites.ts`, `scripts/checkWritePathColumns.ts`, `scripts/frozenLegacyFiles.ts`. |
| T299 | Inventory source-domain FK identities; never substitute semantically similar IDs | C | `scripts/checkSchemaReferences.ts` and `scripts/checkEnumLiterals.ts` are the standing guards; the routes enforce it locally too (`routes/messaging.ts:1836-1846` refuses a reply reference from another thread; `:2680-2689` refuses a cross-thread save). |
| T300 | Capture baseline tests and message delivery behaviour before mutation | C | The baseline exists: `test/messaging.test.ts` (22 cases incl. thread-creation rollback at `test/messaging.test.ts:502#rolls back the thread`), `test/messagingOffApp.test.ts`, `test/telegraphChat.test.ts`, `test/telegraphRealtime.test.ts`, `test/telegraphStreamEndpoints.test.ts`, `test/callSystem.test.ts`. |
| T301 | Repository safety rule — do not invent schema fields; no semantically-close substitution; unknown stays null/unresolved | C | Enforced by ratchet rather than convention: `scripts/checkMissingLiveColumns.ts`, `scripts/checkWritePathColumns.ts`, `scripts/checkNotNullWrites.ts`, `scripts/checkEnumLiterals.ts`. The discipline is visible in the migrations themselves — `2325:88-110` refuses to run unless `messages`, `message_thread_members`, `last_read_at` and `deleted_at` all exist. |
| T302 | Phase 1 — Conversation Kernel, member visibility bounds, message envelope, outbox, policy service | W | Two of five: the kernel (`message_threads` + `message_thread_members`) and a partial envelope (T156). No visibility bounds (T210), no outbox (T154), no policy service (T207). |
| T303 | Phase 2 — Reliable DM/group, requests, blocking, seen/delivery, unseen-unsend, offline/idempotency | W | Three of six: DM/group, requests and blocking are the strongest built area. Seen is thread-level (T70), delivery is absent (T69), unsend is absent (T75), idempotency is absent (T231). |
| T304 | Phase 3 — Universal share contract, rich media, content drawer, object-aware search | W | One of four, partially: image/video media. No contract (T41), no drawer (T66), no search (T272). |
| T305 | Phase 4 — Shared Context Rail and live source-object cards | N | Neither. The cards that exist are frozen snapshots, the opposite of live (T46). |
| T306 | Phase 5 — Availability/Nearby, Who's Around, privacy zones, instant revocation | N | None of the four exists **in Telegraph**; availability and privacy zones exist in Passport and Map respectively and are not wired here (T28, T31). |
| T307 | Phase 6 — Plans/decisions/coordination sessions, meeting points, temporary location | W | Three of four exist and none is conversation-scoped: meetup decisions (T83), meeting points (T86), temporary location (T214). Coordination sessions do not exist. |
| T308 | Phase 7 — Translation, voice transcript, Compass thread tools, catch-up | W | One of four: translation, which is the best-built subsystem in this census (T145, T241). No transcript, no thread tools (T245–T251), no catch-up. |
| T309 | Phase 8 — Buddy/Safety operational modes, calls, captions, advanced offline/proximity | W | Two of five: Buddy/Safety (T269, T270) and calls (T152, T198). No captions, no advanced offline (T233), no proximity. |
| T310 | Phase 9 — Post-experience recap, collaborative media, opportunity graph optimization | N | None. |

### §26 RLS & Authorization Test Matrix

| id | Case → expected | V | Evidence |
| --- | --- | --- | --- |
| T311 | Non-member reads conversation → **DENY** | C | `routes/messaging.ts:1560-1570` re-checks active membership on every read and returns 403 before any message query; `migrations/2070_rls_hardening.sql:11` lists `message_thread_members` among the hardened tables; `test/rlsPrivacy.test.ts`, `test/accessControl.test.ts`. |
| T312 | Removed member reads future sequence → **DENY** | C | Achieved by a blunter rule that is strictly stronger: `.is('left_at', null)` (`routes/messaging.ts:1565`) denies a departed member the *entire* thread, not merely future messages. There is no sequence, but the required outcome holds. |
| T313 | New member reads pre-membership history without policy → **DENY** | W | **Expected DENY, actual ALLOW.** The read path has no `joined_at` bound (T211). This is the single clearest divergence in the census. |
| T314 | Blocked sender sends DM → **DENY** | W | Denied on the happy path (`routes/messaging.ts:1788-1792`, fail-closed `isBlockedBetween`) — but the membership read that decides whether to consult the guard drops its error (`:1783`), so a transient read failure yields ALLOW (T220). PR #472 closes it. |
| T315 | Expired exact location read → **DENY** | C | `requireSafeReturnRecipient` runs as middleware before the handler (`routes/safeReturn.ts:660-661`), coordinates never leave `toPublicSession` (`:22`), and `expired` is a terminal session status (`baseline:10520`). |
| T316 | Availability audience excludes viewer → **DENY** | C | `migrations/2260_availability_windows.sql:44-49` — RLS enabled, owner-only SELECT of their own rows, **no cross-user read policy at all**, and service-role-only writes so `source` and `visibility` cannot be self-set through PostgREST. A viewer reaches another traveler's window only through the projection, which re-checks explicit-source + active + visibility together. |
| T317 | Private Memory source shared without derivative authorization → **DENY** | N `∅` | Vacuous: no Memory share path exists (T117), so the case cannot arise and nothing guards it. |
| T318 | Authorized user reads current safe share projection → **ALLOW** | N | There is no share projection to read (T44). The positive case has no implementation. |
| T319 | Trip member loses Trip membership → capabilities downgrade **immediately** | W | The effect is right and the timing is not guaranteed: `services/groupChatSync.ts:9-13` reconciles `message_thread_members` on membership change and reads then deny (`routes/messaging.ts:1565`) — but the sync is invoked fire-and-forget from the membership routes, and there is no capability object to downgrade (T207). |
| T320 | Buddy booking cancelled → booking-only actions disabled **immediately** | W | Correct for one action: call eligibility is re-derived at call time from booking state (`isRabBookingCallEligible`, `routes/calls.ts:26`). Every other booking action is rendered from a frozen card and is not rechecked (T46, T412–T414). |

### §27 Certification & Test Plan

| id | Property invariant (§27.1) | V | Evidence |
| --- | --- | --- | --- |
| T321 | permission decreases → accessible set never increases | N | No monotonicity property test exists. `test/accessControl.test.ts` and `test/rlsPrivacy.test.ts` are case tests over fixed fixtures. |
| T322 | location precision decreases → recipient precision never increases | N | Not for location shares. The adjacent property **does** exist for another module — `test/presenceDomain.test.ts:79-83` proves `narrowestPrecision` never exceeds `FEATURE_PRECISION_CEILING` — but that guards `presence/domain`, which no location-share path uses. |
| T323 | participant removed → future accessible sequences never increase | N | No sequences (T228). |
| T324 | block activated → future direct delivery impossible | W | Three test files establish the case behaviour (`test/blocks.test.ts`, `test/blocksLib.test.ts`, `test/blockExclusion.test.ts`) but the property does not hold in main because of the fail-open at T220. |
| T325 | thread / availability / location expiry → temporary scopes terminate | W | Availability and location expiry are tested (`test/availability.test.ts`; safe-return session lifecycle) and re-evaluated on read (`2260:38-42`). Thread expiry does not exist, and none of this is expressed as a property. |
| T326 | message unseen → unsend may succeed | N | No unsend. PR #472's `test/telegraphUnsendBeforeSeen.test.ts` is exactly this test and is unmerged. |
| T327 | any eligible recipient seen → unseen-unsend impossible | N | Same. |

| id | Adversarial fixture (§27.2) | V | Evidence |
| --- | --- | --- | --- |
| T328 | Stranger spam and request flooding | W | The restriction wiring is tested unusually well — six cases at `test/messaging.test.ts:519-631` covering normal-allowed, fail-open-silent, real-restriction, two distinct fail-closed paths and a discriminator that must not swallow every throw. There is no *flooding* fixture, and sends are unlimited (T279). |
| T329 | Blocked sender retrying on a stale device | N | No fixture. |
| T330 | Duplicate send and offline resend | N | No fixture, and no mechanism to test (T231). |
| T331 | Out-of-order realtime events | N | No fixture. `test/telegraphRealtime.test.ts` covers delivery, not reordering. |
| T332 | Location expires while the owner's device is offline | N | No fixture. |
| T333 | Edit while translation/transcript is generating | W | The ordering hazard is handled and tested — `markTranslationsPending` on edit (`routes/messaging.ts:2401`) plus `test/retranslateGate.test.ts`, `test/contentTranslationInvalidation.test.ts`, `test/commentTranslationInvalidation.test.ts` — but as unit coverage of the gate, not as an adversarial race fixture. |
| T334 | Participant removed mid-send | N | No fixture. |
| T335 | Trip membership revoked while the thread is open | N | No fixture. |
| T336 | Buddy booking cancelled during coordination | W | Adjacent coverage exists (`test/callHardening.test.ts`, `test/rentBuddyReliabilityRoutes.test.ts` exercise eligibility against booking state) but not this fixture. |
| T337 | AI summary sees conflicting messages | N | No fixture. |
| T338 | Unsend races recipient seen update | N | No unsend. PR #472 adds precisely this. |
| T339 | Source object revoked while a cached share card is open | N | No fixture — and the behaviour it would catch is wrong (T46). |

| id | Live-DB contract check (§27.3) | V | Evidence |
| --- | --- | --- | --- |
| T340 | Every selected/written column exists in CI and production schema | C | `scripts/checkMissingLiveColumns.ts`, `scripts/checkWritePathColumns.ts`, `scripts/auditMigrationsVsLive.ts` — standing CI lanes against the live schema. |
| T341 | Every enum literal exists in the live database | C | `scripts/checkEnumLiterals.ts`. |
| T342 | Every RLS role has intended positive and negative access | C | `scripts/rlsDispositions.ts` is a per-table ledger of expected class and policy count (including the two dead report tables at `:310`, `:456`); `test/rlsPolicyShapeLive.test.ts` checks shape against the live database; `scripts/checkAuthorizationContract.ts:1-18` fails CI on drift. |
| T343 | Migrations additive/idempotent where designed and include postconditions | C | The 2100–2999 band convention, enforced by `scripts/certifyMigrations.ts`, `scripts/checkMigrationLedger.ts` and `scripts/checkMigrationPrefixes.ts`, and visible in the files: `2260_availability_windows.sql` and `2325` both open with a precondition `DO $$` block and close with a postcondition block that re-reads `pg_proc` / `information_schema`. |
| T344 | No silent catch converts a schema/permission failure into a plausible empty inbox/context | W | The ratchet exists and is on point — `test/silentSchemaErrorCatches.test.ts` and `scripts/checkSilentSupabaseWrites.ts` — but **the messaging tree still contains instances**, four of them in one file: `artifacts/api-server/src/routes/messaging.ts:1800#const { data: member, error: memberErr } = await sc` (membership read, error dropped), `:1783` (block-guard membership read, error dropped — the T220 hole), `:1611` (translation read, error dropped), `:2680` (save membership read, error dropped). PR #460 exists for exactly this class and is unmerged. |
| T345 | Direct-write ratchets can only shrink | C | `scripts/checkAuthorizationContract.ts` is the shrink-only guard for client mutation privileges; `scripts/frozenLegacyFiles.ts:45-46` and `scripts/frozenMigrationRoots.ts:90-91` hash-pin the legacy migration set (including `0030_message_reports.sql` and `0031_thread_reports.sql`) so it cannot be edited. |

### §28 Observability & SLOs

| id | Metric → target | V | Evidence |
| --- | --- | --- | --- |
| T346 | message command success — high availability, safety/coordination prioritized | N | No metric is emitted for messaging and no target constant exists. Sentry is wired app-wide (`sentry-preload.ts`) but there is no Telegraph SLO, dashboard or alert. |
| T347 | duplicate canonical messages = **0** under the idempotency contract | N | Neither the metric nor the contract exists (T231). |
| T348 | unsend-after-seen violations = **0** | N | Vacuously zero because unsend does not exist (T75); nothing measures it. |
| T349 | expired precise-location leakage = **0** | W | The guarantee is genuinely enforced (T216, T315) — but nothing measures it, so a regression would be silent. |
| T350 | blocked direct deliveries = **0** | W | Enforced except for the fail-open (T220), and unmeasured. |
| T351 | projection lag — bounded, alert on material stale shared context | N | Four of six projections do not exist (T291–T294); the two that do are computed per request, so there is no lag to measure and no shared context to go stale. |
| T352 | realtime reconnect recovery — no lost confirmed messages | C | Guaranteed architecturally rather than measured: the canonical row is committed and the 201 returned (`routes/messaging.ts:1848`, `:1998`) before any realtime publish (`:2020`), and the client's polling path is the source of truth (`routes/telegraphStream.ts:13-15`, `lib/telegraphEvents.ts:15-16` — *"any missed event self-heals on the next poll"*). A dropped SSE event cannot lose a confirmed message. |
| T353 | share-revocation latency — fast enough to prevent stale authorization bypass | N | Revocation does not exist, so latency is unbounded (T46). |
| T354 | successful coordinated real-world actions — the primary product outcome metric | N | Nothing measures outcomes. Telegraph has **no telemetry sink at all** — no analogue of the Wall's `wall_telemetry_events`. |

### §29 Non-Negotiable Developer Invariants

| id | Invariant | V | Evidence |
| --- | --- | --- | --- |
| T355 | No AI, translation, transcription, maps or push dependency in the core message-delivery path | C | The row is inserted (`routes/messaging.ts:1848`) and the 201 sent (`:1998`) before translation (`:2039`), tagging (`:1964`), notification (`:1977`) and realtime (`:2020`), every one of which is fire-and-forget with its own net; `services/messageTranslation.ts:11` — *"never throws."* Delivery cannot be blocked by any of them. |
| T356 | No exact location without explicit purpose / audience / precision / expiry authorization | W | Three of four are enforced (audience `allowed_member_ids`, precision `visibility_level`, expiry `expires_at NOT NULL`, `baseline:10511-10521`) and exact coordinates never leave the API at all (`routes/safeReturn.ts:22`). **Purpose is not bound to a share row** (T215) — the registry exists separately and nothing joins them. |
| T357 | No stale location labeled live | C | Staleness is a stored, enforced property: `circle_presence.stale_after_secs` / `is_stale` / `expires_at` (`baseline:4468-4471`), recomputed on read (`routes/circle.ts:920`, `:936` `const isStale = Boolean(effectivePresence?.is_stale)`), and `trip_crew_location_sessions.status` has `expired` as a terminal CHECK value. |
| T358 | No private canonical Memory exposed through a Telegraph share | N `∅` | Unguarded absence — no Memory share path exists to leak through, and nothing would refuse one (T117). |
| T359 | No source-object revocation bypass via a cached Telegraph card, search or Compass | W | **Violated at the card.** Shared cards are frozen JSON re-rendered forever with no re-authorization (`components/DiscoveryCardMessage.tsx:37-45`, `PostCardMessage.tsx` — no fetch at all). It holds for Compass, where a report invalidates the reporter's cache (`artifacts/api-server/src/routes/messaging.ts:3855#router.post('/threads/:threadId/report', async (req, res) => {`, `:2735`), and vacuously for search (T272). |
| T360 | No direct mutation of canonical Trip/Plan/Event/Buddy terms from message prose — **the spec's Primary Invariant** | C | Enforced three ways, not merely unviolated. (a) Structural: `routes/messaging.ts` writes only messaging tables plus `reports`; no domain write exists in the messaging tree (T288). (b) Type-level: `routes/telegraphCommands.ts:57` makes an unconfirmed `ProposedAction` unrepresentable, and `:390` re-verifies trip membership at execution rather than trusting the proposal. (c) Active policing of prose that tries: the off-app solicitation detector (`routes/messaging.ts:1875-1942`) treats term renegotiation in chat as an abuse signal with auto-suspension. |
| T361 | No semantic ID substitution across domains | C | Guarded by standing ratchets (`scripts/checkSchemaReferences.ts`, `scripts/checkEnumLiterals.ts`, `scripts/checkMissingLiveColumns.ts`) and locally by the routes: `routes/messaging.ts:1836-1846` refuses a `replyToId` that belongs to a different thread *"(prevents cross-thread metadata exposure)"*, and `:2680-2689` refuses a cross-thread save. |
| T362 | No group-add operation that leaks prior DM history | W | Violated for the group case that exists (T211: a trip/circle member added by `groupChatSync` reads the whole back history) and vacuous for the DM case, which has no operation (T212). |
| T363 | No silent schema failures that become plausible empty state | W | The right ratchet exists (`test/silentSchemaErrorCatches.test.ts`, `scripts/checkSilentSupabaseWrites.ts`) and the messaging tree is one of the places it has not finished: four dropped-error reads in `routes/messaging.ts` (`:1562`, `:1611`, `:1783`, `:2680`), one of which disables a block guard (T220). |
| T364 | No hidden client-side authorization replacing server policy | C | The client *does* compute an affordance gate over a raw table (`app/messages/[id].tsx:1260-1266`, T295), but it **replaces nothing**: every route re-derives authorization server-side and ignores the client entirely (T208). No server decision anywhere reads a client-supplied permission. |
| T365 | No derived translation or transcript overwriting original content | C | The original stays in `messages.body` and translations live in their own per-recipient rows (`baseline:7534-7546`); the read path returns `originalBody` alongside `displayBody` with an explicit `canShowOriginal` (`services/messageTranslation.ts:31-38`); an edit invalidates rather than merges (`routes/messaging.ts:2401`). |
| T366 | No automatic Memory creation from private conversation history | N `∅` | Unguarded absence: no conversation→Memory path exists, and nothing would refuse one. |
| T367 | No Nearby exposure merely because GPS indicates physical proximity | N `∅` | Unguarded absence: there is no Nearby. `presence/domain/types.ts:50` declares the right ceiling for the concept (`bump: "zone"`) and is interface-only, consumed by nothing in Telegraph. |
| T368 | Blocked relationships never reappear through Nearby, Compass, Bump or shared-memory suggestions | W | Compass and shared-memory are genuinely enforced (`compass/CompassTools.ts:1246` `refreshHiddenUsers` on every social tool; `test/memoriesBlockFailClosed.test.ts`). Nearby and Bump have no referent. And the guarantee is not absolute while the send path can skip its block guard on a read error (T220). |
| T369 | Derived projections are rebuildable from canonical state + events | W | The half that exists is fully rebuildable — both projections are computed per request from canonical tables and cache nothing (`artifacts/api-server/src/routes/messaging.ts:1898#router.get('/me/threads', async (req, res) => {`, `:1552`), which is stronger than "rebuildable". But there are **no events to rebuild from** (T195), and four of the six named projections do not exist. |

### §30-DoD Definition of Done

| id | Area — done when | V | Evidence |
| --- | --- | --- | --- |
| T370 | **Core messaging** — DM/group send, reply, reactions, delivery/seen, unseen-unsend, edit and offline resend are deterministic | W | Three of seven: send, reply, edit. Reactions (T143), delivery (T69), unsend (T75) and idempotent resend (T231) are absent. |
| T371 | **Rich content** — image/video/GIF/voice/Memory Note/Portava object render inline and survive poor-network conditions | W | Three of six render (image, video, Portava object as cards); GIF, voice and Memory Note do not exist; and upload does not survive a poor connection (T223, no resume). |
| T372 | **Shared context** — the top rail accurately shows authorized mutual Now/Upcoming/Want-to-Do/Past state | N | No rail (T13–T21). |
| T373 | **Nearby** — only opt-in eligible users appear; availability and proximity revoke immediately; exact location stays separate | W | Opt-in and revocation are real for availability (`2260` explicit-source CHECK, `routes/availability.ts:776` clear) and exact location is genuinely separate (T214, T216). There is no Nearby, so "only eligible users appear" is vacuous. |
| T374 | **Action** — plan/invite/vote/meet/coordination flows use canonical source-domain commands | W | Plan, invite and vote do, and correctly (T88–T90, T94, T101 — confirmation required, membership re-verified at execution). Meet is host-only and not a message action (T91); coordination does not exist (T85). |
| T375 | **Privacy** — RLS negative tests, block cascade, membership history, revocation and source-object authorization all pass | W | RLS negative tests and block cascade largely pass (T311, T312, T316, T219). **Membership history fails** (T313) and **revocation and source-object authorization do not exist** (T46, T318). Three of five. |
| T376 | **Reliability** — outbox / idempotency / reconnect / backpressure tests pass | N | None of the four mechanisms exists: no outbox (T154), no idempotency (T231), no resume cursor (T233), no backpressure or load-shedding (T239). |
| T377 | **CI / live DB** — schema, enum, write-path and RLS checks green on an isolated branch/PR with the final diff reviewed | C | The lanes exist, are standing, and are the strongest thing in this census (T340–T343, T345). Migration 2325 was authored to them: preconditions, postconditions asserting `prosecdef`, a pinned `search_path`, and explicit `has_function_privilege` assertions that `anon` and `authenticated` hold no EXECUTE. |

### Appendix A

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T378 | Use existing repository naming conventions where established — the `telegraph_*` list is architectural, not permission to duplicate canonical structures | C | Honoured deliberately. The messenger uses `message_threads` / `message_thread_members` / `messages` / `message_requests` / `message_translations` and no parallel `telegraph_*` set was created. Migration 2325 makes the same call explicitly rather than by accident (`2325:47-58`): it reuses `last_read_at` as the seen substrate because *"Introducing a sequence column here would be a second, competing receipt system for one behaviour."* |

---

## 6. v1.1-only requirements — §30A Production Architecture Completion Addendum, and §31

These 73 requirements exist **only** in v1.1. They score **7 C / 11 W / 54 N /
1 ?** — CONSTRUCTED 24.7 %, CORRECT 9.6 %. The addendum is titled *"closes the
remaining platform-level gaps required for Telegraph to move from
feature-complete product architecture to production-complete infrastructure"*,
and it is the part of the specification the tree is furthest from.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T379 | **§30A.1** Canonical `TelegraphRelationship` model so eligibility, calling, Nearby, location, invitations and temporary connections do not independently infer relationship state | W | **The anti-pattern is exactly what exists.** Relationship is independently inferred by at least four resolvers with different vocabularies: `lib/messagingPermissions.ts:38-45` (friend / follower / following / trip / circle), `services/interactionPermissions.ts:597-632`, `lib/calls/callPermissionEngine.ts` via `whoCanCall` (`test/callHardening.test.ts:31` `'people_i_message'`), and `compass/CompassTools.ts:854` `sharesSocialContext`. Each is correct; none is canonical. |
| T380 | Origins FOLLOW/MUTUAL_FOLLOW/TRIP/CREW/EVENT/BUMP/NEARBY/BUDDY/PLAN/MANUAL; states REQUEST_ONLY/ACTIVE/TEMPORARY/RESTRICTED/BLOCKED/EXPIRED | N | Neither vocabulary exists in any form. |
| T381 | Relationship policy is an **input** to ConversationPolicy, not a replacement for block, age, safety, membership or object authorization | W | The "not a replacement" half is structurally honoured — `services/interactionPermissions.ts:597-632` folds blocks, trust restrictions and age in *alongside* the relationship term rather than deriving them from it, and every route re-checks membership independently (T208). The "input to ConversationPolicy" half has no referent (T207). |
| T382 | **§30A.2** Server-built `ReachablePersonProjection` combining relationship, availability, permitted proximity, shared context, privacy and safety | N | No such projection. |
| T383 | Nearby is geographical, availability temporal, reachability contextual; clients must not recompute this eligibility from raw tables | W | Messaging eligibility *is* server-computed (`services/interactionPermissions.ts`), but the client recomputes thread membership from a raw table (`app/messages/[id].tsx:1260-1266`, T295), and reachability as a concept does not exist. |
| T384 | Availability never implies permission to call, bypass message requests, expose exact location or access private plans | C | Enforced by four independent gates, none of which takes availability as an input. Calling: `routes/calls.ts:17-20` authorizes only through `callPermissionEngine`. Requests: `lib/messagingPermissions.ts:29-45`. Location: a separately granted scoped session (`baseline:10511-10521`). Plans: trip/circle membership. And availability windows have **no cross-user read policy at all** (`2260:44-49`), so availability cannot even be observed without going through the projection. |
| T385 | **§30A.3** Text editing with an Edited marker and internal version history; editing never mutates a canonical object | W | Marker yes (`routes/messaging.ts:2371`), history no (T80). The non-mutation half is fully correct (T81). |
| T386 | Model UNDO_SEND, UNSEND_BEFORE_SEEN, DELETE_FOR_ME, DELETE_FOR_EVERYONE, REMOVE_ATTACHMENT, SOURCE_OBJECT_REVOKED and ACCOUNT_DELETED as **distinct** operations | W | Two of seven. `DELETE_FOR_EVERYONE` is `routes/groupChat.ts:340-381`. `ACCOUNT_DELETED` is genuinely and carefully modelled as its own operation by the deletion programme — `lib/deletionDispositions.ts:370-441` is a per-table ledger, and `migrations/2139_shared_content_tombstones.sql:26-37` tombstones `messages.sender_id` with `SET NULL` rather than cascading, precisely so *"a conversation has two sides"* and a bystander keeps their reply. The other five do not exist. |
| T387 | `UNSEND_BEFORE_SEEN` is race-safe and server-authoritative; in groups it succeeds only while no eligible recipient has seen the message | N | Absent (T75–T77). Implemented in PR #472, unmerged, CI-only. |
| T388 | Deleted and unsent content removed from normal search, Compass retrieval, inbox projections and content drawers per the operation's semantics | W | Inbox/read suppression is real (`routes/messaging.ts:1719`) and Compass is invalidated on report (`:2735`). Media survives deletion in main (T79); there is no search (T272) or drawer (T66) to remove from. |
| T389 | **§30A.4** Membership records include `joined_at`, `left_at`, `removed_at`, `visible_from_sequence`, `visible_until_sequence`, `role` | W | Three of six (`baseline:7496-7504`): `joined_at`, `left_at`, `role`. No `removed_at` (a removal is indistinguishable from a voluntary leave) and no sequence bounds (T210). |
| T390 | New members do not automatically gain pre-membership history; adding a third person to a direct conversation creates a new group | W | The first clause is **violated** (T211, T313); the second is vacuous because no add-to-DM operation exists (T212). |
| T391 | Roles OWNER, ADMIN, HOST, MEMBER, GUEST with capability-based authorization for invitations, removals, pins, announcements, group settings and shared operational state | W | Two of five roles (`role` CHECK `member\|admin`, `baseline:7504`) and **none** of the six capabilities: there is no invite, remove, pin, announce or group-settings operation on a thread at all. |
| T392 | **§30A.5** An `ANNOUNCEMENT` message/object type | N | Does not exist (T58). |
| T393 | Seen and Acknowledged are separate concepts | N `∅` | Unguarded absence: there is no acknowledgement, so `last_read_at` is the only signal and nothing distinguishes them. |
| T394 | Do not overload passive read receipts to represent acceptance, agreement or acknowledgement | C | Honoured, and not by accident: `last_read_at` feeds only unread counts (`routes/messaging.ts:917-962`), while every consent-shaped act has its own explicit object — `message_requests.status`, `meetup_invites.status`, and `confirm-action` / `decline-action` (`routes/telegraphCommands.ts:390`, `:445`). No path infers agreement from reading. |
| T395 | **§30A.6** Notification causes MESSAGE, MENTION, PLAN_CHANGED, INVITATION, COORDINATION, LOCATION, CALL, SAFETY | W | Seven of eight exist under a richer taxonomy of 13 categories and ~80 event types (`services/notifications/NotificationTemplateService.ts:14-16`): `telegraph.message`, `telegraph.mention` (`:651`), `plan.item_updated`, invitation events, the `location` category (`:282-306`), `call.incoming` (`:186`) and `safe_return.*`. **COORDINATION has no cause** — as expected, since coordination does not exist (T85). |
| T396 | Priority ladder P0 SAFETY / P1 ACTIVE_COORDINATION / P2 DIRECT_OR_MENTION / P3 PLAN_OR_TRIP / P4 NORMAL_GROUP / P5 REACTION_OR_PASSIVE | W | Four levels, not six (`NotificationTemplateService.ts:19`), and only `urgent` produces different behaviour (T254–T259). The ladder's ordering is approximated by category, not modelled. |
| T397 | Deduplicate by underlying causal event; one Plan change must not create redundant Plan, Trip, Telegraph and Compass notifications | W | A dedup service exists and is correct for one case only: `services/notifications/NotificationDeduplicationService.ts:42-45` coalesces `telegraph.message` by `sourceId`. There is no causal-event identity shared across categories, which is exactly the redundancy the requirement names. |
| T398 | Thread notification policy ALL / MENTIONS / IMPORTANT / temporary mute / MUTED; safety-critical delivery governed by safety policy rather than ordinary mute | W | Two of five, but the second is the important one and it is exactly right: `MUTED` (`message_thread_members.muted_at`, `routes/messaging.ts:2540`) and the safety override — `services/notifications/NotificationPreferenceService.ts:6-7`, *"Safety override: urgent + admin priority always deliver even when push is off"*, with a stored `safety_override` flag (`:59`). No ALL/MENTIONS/IMPORTANT selector, no temporary mute. |
| T399 | **§30A.7** `TelegraphDevice` registry: platform, push, voice/video, proximity, background-location capability, trust state, last activity | W | A registry exists for a different purpose and carries one of the seven fields: `routes/devices.ts:1-16` registers `platform` and an Ed25519 MLS identity key per install. No capability flags, no trust state, no last-activity. |
| T400 | Precise location sharing is device-specific and must not silently transfer to a newly authenticated device | N | Both location stores are keyed by `user_id` with no device column (`baseline:7109`, `:10509`), so a live share follows the account (T235). The device registry that exists is never consulted by a location path. |
| T401 | Device revocation terminates realtime sessions, invalidates location capabilities and proximity identities, stops push, rotates credentials — without destroying conversation history | W | **One fifth is genuinely well built.** Realtime termination exists end-to-end: `lib/telegraphEvents.ts:47` `access.revoked`, `registerTerminator` / `terminateUserConnectionsLocal`, a cross-instance terminate hook in `lib/telegraphBroadcast.ts:33`, and a 30-minute max connection age so *"revoked sessions … cannot hold open an indefinite connection"* (`routes/telegraphStream.ts:35-40`). Location capabilities and push are not device-scoped, credentials are not rotated, and there is no device-revocation endpoint. |
| T402 | **§30A.8** Uploads pass quarantine, file-type verification, security scanning, metadata policy, transcoding and approved-asset publication; **never trust a client-provided MIME type** | W | Four of six, and the emphasized clause is **fully and unusually well satisfied**. `lib/mediaPipeline.ts:187-227`: `sniffMedia(buf)` reads magic bytes; the size ceiling comes from the **sniffed** kind, not the declared one (`:200`); a declared/actual mismatch is refused outright (`:217-223`); and the module states the rule as policy — *"A declared type is a hint, never a fact"* (`:71`) — with a documented history of the drift that made it necessary (`:20-38`). Metadata policy and transcoding: `lib/mediaProcessing.ts:154-166`. **Quarantine and security scanning do not exist.** |
| T403 | EXIF handling defined explicitly — GPS, capture time, device metadata — so forwarding a photo does not disclose where it was captured | C | Three layers. Strip: `lib/mediaProcessing.ts:154,165-166` re-encodes through sharp, `.rotate()` first *"to auto-orient from EXIF before the EXIF is stripped"*, then a full EXIF/GPS/XMP strip. Deliberate retention of the one non-location fact: capture time is extracted server-side before the strip and stored as a field, bounded by a plausibility window (`lib/mediaAssets.ts:37-80`). Audit: `scripts/auditStorageExif.ts:1-30` enumerates the **bucket**, not rows, because *"an object nothing references … is invisible to a row walk"*, distinguishes "carries EXIF" from "carries a GPS IFD", and **never dereferences a coordinate**. |
| T404 | External URL previews are fetched through a controlled server-side preview service; recipients must not silently contact arbitrary sender-provided domains | N `∅` | Unguarded absence. There are **no link previews at all** — a URL renders as plain text through `components/RichText.tsx` — so no recipient-side fetch occurs today, and nothing implements or guards the rule for when one is added. |
| T405 | GIF and other external media providers use the same isolation and attribution boundary | N `∅` | No GIF provider exists (T52). |
| T406 | **§30A.9** Track FORWARDED / RESHARED_FROM_SOURCE / COPIED_ATTACHMENT without exposing private conversation lineage | N `∅` | There is no forward operation, so no lineage leaks and no provenance is tracked. |
| T407 | Content capabilities ALLOW / NO_FORWARD / SOURCE_POLICY / EXPIRES_WITH_SOURCE | N | No capability vocabulary on any shared content (T41). |
| T408 | Screenshot detection, if supported, is informational only and never presented as a guarantee | N `∅` | No screenshot detection. |
| T409 | **§30A.10** Every shareable domain registers preview, authorization, current state, actions, search behaviour and revocation through a content capability contract | N | No registry and no contract (T41); each producer hand-rolls a payload (T35). |
| T410 | Every executable action registers authorize / preview / execute / optional compensate; Telegraph orchestrates, source domains retain truth | W | The orchestration half is genuinely right (T288, T441). Three of four hooks exist for **one** action family: `ProposedAction.label` (preview), `confirm-action` (execute), and `:390`'s re-verification (authorize) — `routes/telegraphCommands.ts:53-59,390-444`. No registry, no compensate. |
| T411 | Action buttons derived from current capabilities; an old rendered card must not authorize a stale action | W | **Violated at the card**: the action row is static markup over a frozen payload with no capability read (`components/DiscoveryCardMessage.tsx:1-9,37-45`). Honoured on the command path, where authorization is re-derived at execution (`routes/telegraphCommands.ts:390`). |
| T412 | **§30A.11** tap → command → owning-domain authorization/write → domain event → projection update | W | Three of five hops exist, and only on the command path: `routes/telegraphCommands.ts:326` (command), `:390` (authorize + execute). There is no domain event (T195) and no projection update (T291–T294). Card actions bypass the chain entirely (T411). |
| T413 | Do not permanently render Going / Joined / Booked / Paid from optimistic UI alone | W | Correct where it matters most: RSVP state is server-backed and re-read (`getMeetup` / `rsvpMeetup`, `app/messages/[id].tsx:48`, against `meetup_invites.status`), and Save round-trips (`services/discoveryBookmarks.toggleSave`). Wrong at the card, whose *rendered* state is the sender's snapshot and is never re-derived (T46). |
| T414 | Current source-domain capability is rechecked at execution time so expired events, revoked invitations, changed bookings and removed memberships fail safely | C | Done properly wherever an execution path exists. `routes/telegraphCommands.ts:11-14` states it — *"confirm-action re-verifies trip membership at execution time"* — and `:390-444` implements it; call eligibility is re-derived from live booking state at call time (`isRabBookingCallEligible`, `routes/calls.ts:26`); message sends re-check membership and blocks per request (T208). The gap is cards, which have no execution path to recheck on and are counted at T411. |
| T415 | **§30A.12** Distinguish PRIVATE_CONVERSATION / SMALL_GROUP / LARGE_GROUP / BROADCAST transport classes | N | `message_threads.thread_type` is `direct\|trip\|circle` (`baseline:7526`) — a **context** discriminator, not a scale class — and the fanout path is byte-identical for all three. |
| T416 | Large Event conversations must not use small-group fanout, presence or per-recipient Seen UI without bounded strategies | N `∅` | Unguarded absence: `publishToThread` fans out to every active member with no size bound (`lib/telegraphEvents.ts`), and the rule is unviolated only because event conversations do not exist. |
| T417 | Large groups may support slow mode, host-only posting, media/link restrictions, member moderation, bounded acknowledgement | N | None of the five. |
| T418 | **§30A.13** Private policy signals — request acceptance, spam reports, block rate, burst, duplicate-message, malicious-link — constrain abuse and are **never** exposed as a public messaging score | W | The privacy clause is fully honoured: `trust_profiles.overall_score` is consulted as a floor and never returned to any caller (`compass/CompassTools.ts:858-866`, with a uniform "not available" answer that never confirms why), and restrictions are resolved server-side (`services/trust/TrustRestrictionService`). Of the six named signals only reports and restriction state feed it — no burst detection (T279), no duplicate-message signal (T231), no malicious-link signal (T281). |
| T419 | New accounts receive gradual outreach capabilities; Nearby must never become mass-DM infrastructure | W | The gradual half is real for the *request* step, where account state and trust restrictions gate eligibility with a fail-closed degraded path (`routes/messaging.ts:432-562`, six tests at `test/messaging.test.ts:519-631`). Sends themselves are unrestricted (T279), and the Nearby clause is vacuous. |
| T420 | Proximity defenses: coarse distance buckets, update throttling, privacy-zone suppression, purpose-bound access, no historical proximity endpoint | W | One of five, and it is real: **no historical proximity endpoint exists**, and `trip_crew_location_sessions` structurally cannot become one — it keeps a single `last_location_snapshot_id` (`baseline:10519`), not a trail. The other four have no referent in Telegraph. |
| T421 | BLOCK overrides Nearby in both directions; Unavailable/Invisible promptly revokes Nearby, Discovery and Compass availability projections | W | Bidirectionality is real and checked both ways (`routes/blocks.ts:275-276`), fail-closed (`lib/blockGuard.ts`), and Compass re-derives hidden users on every request rather than caching (`compass/CompassTools.ts:1246` `refreshHiddenUsers`) — which is the "promptly" the rule asks for. Nearby and Invisible have no referent (T29). |
| T422 | **§30A.14** Accessibility as an architecture requirement: screen-reader labels, dynamic type, reduced motion, high contrast, captions/transcripts, non-colour-only status, large touch targets, accessible alternatives for maps, waveforms, video, proximity and coordination | W | Two of eight in the Telegraph tree: non-colour status (T133) and text-first proximity (T137). Reduced motion is not applied (T134), captions do not exist (T136), and the rest is absent. The tree's own precedent shows this is a Telegraph gap, not a platform one: the Wall implements reduced motion and proves it four ways. |
| T423 | **§30A.14** i18n: RTL layouts, locale-sensitive timestamps, 12/24-hour clocks, pluralization, Unicode names/handles, long translations, mixed-language threads, destination/user timezone semantics | W | Two of eight, and Telegraph got the two that are hardest: **mixed-language threads are fully solved per recipient** (T145, T241 — original preserved, per-recipient translation, honest failure status) and Unicode handles work. **There is no RTL support anywhere in the client** — a repo-wide search for `I18nManager` / `isRTL` returns nothing. Timestamps use hand-rolled formatters, not a locale API (`app/messages/[id].tsx:82-99`). |
| T424 | Timezone and date-line behaviour must be covered by automated tests | C | For the one timezone-sensitive computation Telegraph performs — the conversation's day dividers — it is, and the test is written against exactly the date-line hazard: `travel-buddy-standalone/src/utils/localDate.test.ts:6-12` constructs a late-evening local instant and asserts the local day, noting *"`toISOString().slice(0,10)` would roll this to 2026-08-30 at any positive UTC offset."* Consumed by `app/messages/[id].tsx:20`. |
| T425 | **§30A.15** Truthful ONLINE / POOR_CONNECTION / OFFLINE / RECONNECTING; distinguish local unsent, server accepted, recipient offline, receipt unavailable | N | No connection-state model and no send-state model. The SSE client reconnects but exposes no state, and there is no local-unsent representation (T230). |
| T426 | Storage tiers for thumbnails, streamable media, originals, archival and deletion; temporary precise-location has a much shorter lifecycle than ordinary media | W | The **location half is genuinely right**, and it is the half the rule emphasises: location sessions carry mandatory expiry with an `expired` terminal state (`baseline:10512,10520`) and `location_sessions.expires_at`, while message media has no expiry at all — the asymmetry the rule demands exists. The media-tier half does not (T222). |
| T427 | Canonical conversations and messages survive loss of realtime caches, search indexes, translations, notification queues, AI artifacts and read projections | C | All six are strictly derived and none is on the write path. Realtime: in-memory, failures swallowed by design (`lib/telegraphEvents.ts:14-16`). Search index: none. Translations: separate rows with a `failed` status that never throws (`services/messageTranslation.ts:11`). Notifications: `Promise.allSettled` inside a non-fatal try (`routes/messaging.ts:1977-1992`). AI artifacts: their own table. Read projections: a single nullable timestamp, with an explicit fallback when the column itself is missing (`routes/messaging.ts:942-945`). |
| T428 | `ConversationProjection`, `InboxProjection`, `SharedContextProjection`, `ContentIndexProjection`, `SearchIndex` and seen-state derivatives are rebuildable from canonical state and events | W | The two that exist are stronger than rebuildable — computed per request from canonical tables, caching nothing (`artifacts/api-server/src/routes/messaging.ts:1898#router.get('/me/threads', async (req, res) => {`, `:1552`). Four do not exist, and there are no events to rebuild from (T195). |
| T429 | **§30A.16** Versioned structured-message schemas `place.share.v1`, `event.share.v1`, `trip.share.v1`, `memory_note.v1`, `location.scope.v1`, `coordination.status.v1` | N | None exists; card payloads are unversioned JSON in `body` (T157). The convention **is** practised elsewhere in the same tree — `schemaVersion` appears in intel and passport telemetry envelopes (`test/intelObservability.test.ts:406`, `test/passportTelemetryIngest.test.ts:142,268`, which even rejects an unknown version) — so this is a Telegraph omission, not a missing platform capability. |
| T430 | Unknown future message types render a **safe generic fallback** on older clients rather than crashing or silently disappearing | W | Two thirds. A fallback does exist and nothing crashes or disappears: an unknown `msg_type:'system'` subtype falls to the centred pill (`app/messages/[id].tsx:1892-1898` → `components/TelegraphSystemNotice.tsx:16`) and an unknown `msgType` falls through every branch to `MessageBubble` (`app/messages/[id].tsx:1899`). It is not **safe**: because structured payloads live in `body` as raw JSON (T157), both fallbacks render the payload as literal text, so an unrecognised structured message shows the user its JSON. |
| T431 | Client capability negotiation when an interaction requires a minimum supported schema or action version | N | No version negotiation of any kind. |
| T432 | **§30A.17** Measure delivery latency, failed sends, unsend outcomes, seen convergence, media processing, plan conversion, coordination success, Nearby→conversation, conversation→plan and completed real-world outcomes | N | None of the ten is measured. Telegraph has no telemetry sink at all — no analogue of the Wall's `wall_telemetry_events` (T354). |
| T433 | Do not indiscriminately copy private message text into analytics | C | Actively honoured with concrete artifacts, not merely by the absence of analytics. `services/messageTranslation.ts:13` — *"Privacy: never logs full message body. Only message_id, status, codes."* The one place message text is ever persisted outside `messages` is the off-app abuse excerpt, capped at 120 characters and explicitly tagged `visibility: 'admin_only'` (`routes/messaging.ts:1902`). The north-star half of this bullet is counted separately at T1 and T354. |
| T434 | SLOs for message acceptance, realtime delivery, offline recovery, seen convergence, block enforcement, location revocation, media availability and projection freshness, with safety/privacy strictest | N | No SLO definitions exist for any of the eight (T346–T354). |
| T435 | Internal support tooling exposing delivery and projection diagnostics, event ids, conversation ids and authorized moderation context under purpose-scoped access with audit logging | W | The moderation half exists and is guarded — `routes/moderation.ts`, `routes/admin.ts`, `routes/appeals.ts`, with `scripts/checkAdminGuard.ts` as a standing CI guard and admin-only visibility tagging on abuse events (`routes/messaging.ts:1902`). The diagnostics half does not: no delivery diagnostics, no projection diagnostics, and no event ids to trace with (T195). |
| T436 | **§30A.18** A Telegraph replay simulator permuting send, disconnect, unsend, reconnect, member removal, location expiry, plan changes, blocking, translation completion and media completion, verifying deterministic final state | N | No replay harness — and nothing to replay: there is no event log (T195) and no snapshot table (T155). |
| T437 | Property tests: permission monotonicity, precision monotonicity, removed participants, block, temporary-scope expiry | N | None exists for Telegraph (T321–T327). The tree's one genuine property test of this family guards a different module (`test/presenceDomain.test.ts:79-83`). |
| T438 | Live-DB contracts verify columns and enum literals against the actual schema and verify RLS role behaviour; **schema/permission failures must never be swallowed into plausible empty inboxes** | W | The first half is fully built and is the strongest area in the census (T340–T343, T345). The emphasized half — the one clause in the whole addendum that names an inbox — is the clause that still fails: four dropped-error reads in `routes/messaging.ts` (`:1562`, `:1611`, `:1783`, `:2680`), one of which silently disables a block guard (T220, T344). PR #460 exists for this class and is unmerged. |
| T439 | **§30A.19** Formalize a Context Kernel above transport: Relationship, Time, Proximity, Intent, Shared Objects → Policy + Capabilities | N | No kernel. Two of the five inputs exist as scattered, uncomposed resolvers (relationship: four of them, T379; intent: `services/telegraphIntent.ts`). Nothing assembles them. |
| T440 | Transport answers what was sent · conversation context answers what is happening between these people · world context answers what is happening around them · policy answers what each may know or do · actions execute through owning domains | W | Two of the five layers are genuinely separated: transport (`routes/messaging.ts` + `lib/telegraphEvents.ts`) from policy (`lib/messagingPermissions.ts`, `services/interactionPermissions.ts`, `lib/calls/callPermissionEngine.ts`), with actions executing through owning domains (T288). Conversation context and world context have no layer at all. |
| T441 | The separation is mandatory so messaging infrastructure does not become the canonical owner of Trips, Events, Buddy bookings, Memories, availability, location or other domain truth | C | Holds absolutely. The messaging tree owns no domain truth: `routes/messaging.ts` writes only messaging tables plus `reports`; domain effects are produced by their owning routes (`routes/circle.ts:300`, the RAB tree) and executed only through re-authorized commands (`routes/telegraphCommands.ts:390`). This is the spec's Primary Invariant and it is the thing the repository gets most right. |
| T442 | **§30A.20** Availability is user intent, not permission to contact or track | C | T384, reinforced at the storage layer: `2260`'s `CHECK (source = 'explicit' OR visibility = 'private')` makes an *inferred* window that looks public **unrepresentable**, so availability cannot even be fabricated into a contact signal by a writer that bypasses the service. |
| T443 | Online presence, availability, proximity and precise location sharing are separate capabilities | W | Three of four are separate stores with separate consent and separate expiry (T22). Proximity does not exist. |
| T444 | A newly added group participant cannot read history outside the authorized sequence window | W | **Violated** (T211, T313, T390). |
| T445 | A source object shared in Telegraph cannot grant broader access than its authorized share projection | W | There is no share projection, and the frozen card grants access that outlives the source's own authorization (T46, T359). |
| T446 | External previews cannot cause recipient-side network disclosure to arbitrary sender-controlled domains | N `∅` | Unguarded absence — no previews exist (T404). |
| T447 | AI, translation, transcription, GIF providers, maps, search and push are never required for core text-message correctness | C | T355, T238, T427. The insert and the 201 complete before every one of them, and each has its own swallow-and-continue net. |
| T448 | Canonical operational state always outranks historical conversation text | W | True wherever operational state is re-read — RSVP (`meetup_invites.status`), call eligibility (`routes/calls.ts:26`), confirmed commands (`routes/telegraphCommands.ts:390`). False at the card, which **is** historical conversation text presented as current operational state (T46, T411, T413). |
| T449 | All consequential cross-domain actions pass through the owning domain's command/authorization path | C | T288, T360, T414. No cross-domain write originates in the messaging tree. |
| T450 | Derived Telegraph projections are rebuildable; caches and indexes are never the sole authoritative copy | C | Nothing derived is authoritative anywhere on the server: the realtime bus is in-memory and lossy by design (`lib/telegraphEvents.ts:14-16`), translations are derived rows that never replace the original (T365), read state degrades to a documented fallback when its column is missing (`routes/messaging.ts:942-945`), and both projections are recomputed per request from canonical tables (T369). |
| T451 | **§31** Five responsibilities: transport · Context Kernel · policy · action orchestration · outcome loop | W | Three of five exist as identifiable layers — transport, policy and action orchestration (T440). The **Context Kernel** does not exist (T439) and the **outcome loop** does not close: nothing measures a coordinated real-world outcome (T354) and nothing returns one to Memory (T119, T121). |

---

## 7. What could not be verified (3)

Counted honestly in their own bucket and never folded into either side.

| id | § | Why construction cannot settle it |
| --- | --- | --- |
| T61 | 6.3 | Inline video playback controls — poster, play/pause, scrub, mute, fullscreen, captions. `components/MessageMediaBubble.tsx:170` mounts an autoplay-capable player, but scrub/mute/fullscreen/caption behaviour belongs to the shared player and is a device property. |
| T71 | 7.2 | "Push delivery, app launch and background rendering do not count as seen." **The server cannot know.** `POST /threads/:threadId/read` (`routes/messaging.ts:1204`) accepts no evidence of foreground visibility and stamps `last_read_at` on any authenticated call. The client calls it from a mount effect on thread open (`app/messages/[id].tsx:1269-1273`, *"Mark thread as read when the user opens it. Fire-and-forget."*), which is the right intent but fires on mount rather than on visible render, and nothing enforces it server-side. This is a *design* gap as much as a verification one — the requirement is not checkable because the protocol carries nothing to check. |
| T135 | 11.3 | Voice/video control screen-reader labels and hit targets. Voice does not exist (T53); the video transport controls belong to the shared player, whose accessibility-tree behaviour needs a device. |

**Three is a real number, not a rounding of a harder question.** Where a
requirement was absent I said NOT-BUILT rather than CANNOT-VERIFY, because the
absence of a table, a route, a column or a named function is decidable by
reading. The visual-judgement rows that would ordinarily land here (§11's
"cards compact and contextual", "bubbles visually dominant") were decidable in
this tree because the structures they would compete with do not exist — and
those rows say so rather than claiming a design win.

---

## 8. Deployment and liveness facts that bound the built code

These are **not** construction verdicts and are not in the 451. They decide
whether the built code can do anything.

1. **`messages.unsent_at` does not exist in production.** Confirmed in-tree:
   `baseline/20260907_production_tables.txt` (431 lines, committed during this
   pass) contains **zero** matches for `unsent`. Migration 2325 (PR #472) adds
   the column and `telegraph_unsend_message_before_seen`, applied to
   `portava-ci` only. Everything §7.4 asks for is therefore CI-only, and this
   census scores main.
2. **Two of production's seven Telegraph tables are orphans.** The seven are
   confirmed by `baseline/20260907_production_tables.txt`. `message_reports`
   and `thread_reports` have no writer and no reader in application code —
   settled by reading both report handlers, which write the unified `reports`
   table instead (`artifacts/api-server/src/routes/messaging.ts:3855#router.post('/threads/:threadId/report', async (req, res) => {`, `:2720`). Their migrations are
   hash-frozen (`scripts/frozenLegacyFiles.ts:45-46`), so they will persist.
3. **`saved_messages` is written and never read** (T119). The Save affordance is
   live on two client surfaces today and does nothing observable.
4. **Telegraph has no telemetry sink.** Unlike the Wall (`wall_telemetry_events`,
   migration 2308), there is no Telegraph analytics table, deployed or
   undeployed. Nothing in §28 or §30A.17 has anywhere to land.
5. **The `open_to_plans_windows_enabled` flag gates availability windows** and is
   seeded OFF by migration 2260. Since Telegraph never reads availability at all
   (T28), this does not change a Telegraph verdict — but it means the strongest
   §4-adjacent artifact is dark even on its own surface.
6. **Messaging has one kill switch and no rate limit.** `disable_messaging` is
   checked fail-closed on every send (`routes/messaging.ts:1752-1756`), which is
   good; there is no per-user send limit at all (T279).
7. **Writer-attribution caveat, inherited.** `scripts/checkWriterlessReads.ts:39-41`
   declares that a dynamic `.from(expr)` anywhere makes writer attribution
   INCOMPLETE and that the check errs toward silence. Every "nothing
   writes/reads X" claim above was settled by reading call sites, and the tree's
   two dynamic `.from(table)` sites (`services/media/MyWorldMemoryService.ts:614`,
   `services/media/MediaProjectionService.ts:1502#const { data } = await (sc as any).from(table).select("*").eq(ownerCol, ownerId).limit(1000);`) were opened and confirmed to be
   gem- and media-scoped helpers whose callers cannot pass a messaging table name.

---

## 9. Open PRs that would change a verdict

Censused state is **main**. Neither PR below is scored in any bucket.

### PR #472 — Telegraph §7.4 unsend-before-seen

Five files: `migrations/2325_telegraph_unsend_before_seen.sql` (287 lines),
`routes/messaging.ts` (+152), `test/telegraphUnsendBeforeSeen.test.ts` (601),
plus a no-op `lib/telegraphEvents.ts` touch and a version bump.

**This is the only artifact in the repository built for this specification**
(§4). It is also, read on its merits, the best-argued migration in the
Telegraph area:

- The decision lives in the database, not the route, and the stated reason is
  the right one: *"supabase-js issues each statement in its own implicit
  transaction, so a recipient's read landing between (1) and (2) yields an
  unsend of a message that HAS been seen"* (`2325:30-39`). It locks the message row (`2325:162`) and then takes `FOR UPDATE` locks on
  every eligible recipient's receipt row **before** reading `last_read_at`
  (`2325:189-195`, commented *"This is the §7.4 race, closed."*).
- It refuses to invent a substrate: seen is `last_read_at >= messages.created_at`
  because that is already what the unread-count logic means, and *"Introducing a
  sequence column here would be a second, competing receipt system for one
  behaviour"* (`2325:47-58`). That is Appendix A's rule (T378) applied
  correctly.
- It returns a discriminating `outcome` envelope rather than raising, and the
  route treats a null/absent outcome as a **failure**, never a success and never
  a refusal (route diff, `+`unsend handler).
- Its postconditions assert `prosecdef`, a pinned `search_path`, and explicitly
  that `anon` and `authenticated` hold **no** EXECUTE.

If merged it would move **eleven** requirements to BUILT-AND-CORRECT (§4), and
would be the first non-zero spec-attributable score any Portava census has
recorded.

Two things it does **not** do, which is why some verdicts stay where they are:
it adds no `message.unsent` event (T181 — its `telegraphEvents.ts` diff is
empty), and it closes one of T344's four dropped-error reads, not all four.

### PR #460 — Telegraph silent failures

Seven files: `lib/mediaAccess.ts` (+6), `routes/groupChat.ts` (+15),
`routes/messaging.ts` (+14), `routes/telegraphChat.ts` (+171),
`test/telegraphSilentFailures.test.ts` (545), `test/mediaAccess.test.ts` (+23).

It closes a genuine hole this census does not otherwise capture: *"rows
tombstoned before that change still carry `media_url` and went on authorizing
the bytes for a picture the sender had already unsent"* — the fix filters the
signed-URL lookup on `deleted_at IS NULL`. It would strengthen T79, T276 and
T344.

**PR #460 is not spec-attributable.** Its diff carries no section citation
anywhere — a repo-wide grep for `§` over `git diff main...pr/460` returns
nothing — despite hardening behaviour §7.4, §21 and §27.3 all require. It is
good work done for the codebase, not for this document, which is the same
pattern §4 describes for the tree as a whole.

> **RESTATED 2026-09-14 — UNKNOWN.** The grep is kept: #460's diff cites no section, and that
> is a fact. *"Good work done for the codebase, not for this document"* is not — it is a claim
> about why the author wrote it, and an uncited diff is equally consistent with an author
> working from the spec and not bothering to say so. Record #460 as **attribution unknown**.
> What would settle it: a section citation in the diff, a PR body naming the spec, or the
> author. See `docs/architecture/attribution-method.md`.

---

## 10. §2, §3, §5, §6, §7, §8, §9, §10 and §11 built: the Shared Context Rail, the share contract, the typed kinds, unsend-before-seen, the coordination surface, the recap, and the end of the frozen card

**Read against the branch `worktree-agent-adcce5a16df432ba7`, whose base is
`014a25d56`.** §3 was the largest all-NOT-BUILT block in this census: nine rows,
nine N verdicts, no rail element anywhere in either tree. §11.2's five rail
behaviours were five more N rows for the same reason — a behaviour table about a
component that did not exist. This section builds the component, the projection
behind it, and the refusal §3.2 asks for.

Nothing here needs a migration. The rail is computed from canonical tables that
production already has (`baseline/20260907_production_tables.txt` lists
`trip_members`, `meetups`, `meetup_invites`, `event_attendees`, `collections`,
`collection_items` and `rent_buddy_bookings`), and every new artifact is
TypeScript. That is the reason these rows can reach C at all: a row whose truth
depends on DDL no database has would stay W however good the code was.

### 10.1 What was built, and where

- **§3.4's contract is a declared type, not a shape that happens to come out
  of a handler.** `services/telegraph/sharedContext.ts` declares
  `SharedContextItem` and `TelegraphSharedContextProjection` with §3.4's field
  names verbatim — `conversationId`, `generatedAt`, `now`, `upcoming`,
  `unresolved`, `past`; `objectType`, `objectId`, `currentVersion`, `title`,
  `startsAt`, `endsAt`, `relationship`, `status`, `availableActions` — and
  `buildSharedContextProjection`
  (`services/telegraph/sharedContext.ts:648#buildSharedContextProjection`) is
  the only thing that constructs one. `objectType`, `relationship` and
  `availableActions` are not free strings: they come from
  `services/telegraph/vocabulary.ts`, which carries §5's object families
  (`services/telegraph/vocabulary.ts:33#TELEGRAPH_OBJECT_TYPES`), §3.1's four
  eligibility clauses as the four relationship values
  (`services/telegraph/vocabulary.ts:99#SHARED_RELATIONSHIPS`) and §8.1's
  fourteen native actions in the spec's order
  (`services/telegraph/vocabulary.ts:119#TELEGRAPH_ACTIONS`). A wrong value is a
  compile error.
- **§3.1's four clauses are four resolvers over five canonical tables.**
  `resolveSharedTrips` (`services/telegraph/sharedContext.ts:344#resolveSharedTrips`)
  keeps a trip only when the viewer AND at least one other active member of the
  conversation both hold an `accepted` `trip_members` row; `resolveSharedMeetups`
  (`:405#resolveSharedMeetups`) does the same over `meetup_invites`, counting the
  creator as a participant even without an invite row of their own;
  `resolveSharedEvents` (`:467#resolveSharedEvents`) over `event_attendees`;
  `resolveSharedBookings` (`:521#resolveSharedBookings`) over the two parties of a
  `rent_buddy_bookings` row. Clause 1 and clause 2 — "created by me and
  joined by them", "created by them and joined by me" — are decided by
  `relationshipFor`, which reads the source object's own owner/creator/host
  column, so the rail says WHICH side made the thing.
  Clause 4, "both deliberately promoted an item into a shared wishlist or
  Want-to-Do state", is `resolveSharedWantToDo`
  (`:567#resolveSharedWantToDo`): a `collection_items` row exists only because a
  user pressed Save, so the same `(entity_type, entity_id)` saved independently
  by two people in the conversation is exactly the clause, and it is canonical
  state rather than an inference.
- **§3.2 is REFUSED, not merely not done.** The census's own rule is that a
  prohibition counts as built only when something makes the violation
  unrepresentable or refuses it. Two artifacts do:
  `CANONICAL_MUTUALITY_SOURCES`
  (`services/telegraph/sharedContext.ts:198#CANONICAL_MUTUALITY_SOURCES`) is a
  closed five-element list that does not contain `messages`, and
  `admitCandidate` (`:246#admitCandidate`) — the single gate every rail item
  passes through — returns `{ admitted: false, refusal: "non_canonical_source" }`
  for anything outside it. The type refuses the same value at compile time.
  The test proves both halves *and* the absence:
  `test/telegraphSharedContext.test.ts:388` asserts the refusal branch fires,
  and `:394` reads this module's own source, extracts every `.from("…")` it
  makes, and fails if `messages` is among them or if any table outside the nine
  canonical ones appears.
- **§3.1's last bullet has an enforcement, not a hope.** "Past shared objects
  remain available in the historical view only when still authorized" is
  enforced twice: the resolvers only admit rows where the viewer's own
  membership is currently active (`trip_members.status = 'accepted'`), and
  `admitCandidate` re-checks `viewerStillAuthorized` and refuses
  `viewer_unauthorized`. `test/telegraphSharedContext.test.ts:490` puts a trip
  the viewer was REMOVED from into the fixture and asserts it is absent from
  `past`, not merely greyed out.
- **§3.3's ordering is the spec's seven bands, in the spec's order, and it is
  the sort key.** `SHARED_CONTEXT_ORDER`
  (`services/telegraph/sharedContext.ts:95#SHARED_CONTEXT_ORDER`) lists
  HAPPENING_NOW, STARTING_SOON, TODAY, UPCOMING, ACTIVE_TRIP, UNRESOLVED, PAST;
  `classifyBand` (`:137#classifyBand`) puts one object in one band and
  deliberately bands a trip that spans *now* as ACTIVE_TRIP rather than
  HAPPENING_NOW, because §3.3 ranks the active trip BELOW a plan starting soon —
  a fortnight in Da Nang must not outrank the dinner in forty minutes.
  `test/telegraphSharedContext.test.ts:449` asserts the whole ordered set end to
  end through the route.
- **The route.** `GET /api/threads/:threadId/shared-context`
  (`routes/telegraphSharedContext.ts:155#/threads/:threadId/shared-context`)
  verifies active membership, resolves the thread's other active members, and
  returns the projection plus §11.2's server-decided rail mode. `GET
  /api/threads/:threadId/conversation-header`
  (`routes/telegraphSharedContext.ts:223#/threads/:threadId/conversation-header`)
  is §2.2's other two thirds. Both are mounted:
  `routes/index.ts:26#telegraphSharedContextRouter` imports and
  `routes/index.ts:188#telegraphSharedContextRouter` uses.
  A failed membership read is a 500 and a failed RESOLVER read sets
  `incomplete: true` rather than returning an empty rail — "we could not tell"
  and "you share nothing with this person" are different statements and the
  surface must not conflate them (`test/telegraphSharedContext.test.ts:525`).
- **The client.** `travel-buddy-standalone/src/features/telegraph/` is the
  feature folder the client convention asks for. `railBehavior.ts` holds
  §11.2's five rows as pure functions —
  `shouldCollapseOnScroll` (`travel-buddy-standalone/src/features/telegraph/sharedContext/railBehavior.ts:29#shouldCollapseOnScroll`),
  `detectCriticalChanges` (`:66#detectCriticalChanges`),
  `resolveRailPresentation` (`:137#resolveRailPresentation`) —
  and `SharedContextRail.tsx` renders them. The rail is MOUNTED on both
  conversation surfaces, which is what "at the top of each conversation" means
  in a tree that has two of them:
  `travel-buddy-standalone/app/messages/[id].tsx:2089#SharedContextRail` (direct
  and booking threads) and
  `travel-buddy-standalone/src/components/GroupChatScreen.tsx:815#SharedContextRail`
  (trip and circle threads).
- **§11.2 row 5, the part that is easy to get wrong.** A critical change
  (a plan cancelled, a start time moved) is promoted until acknowledged, and
  the promotion OUTRANKS the scroll rule — a rail that a scroll can silence is
  not a promotion, and the traveler would never learn the dinner was called
  off. `railBehavior.ts:137` puts the change branch above the scroll branch and
  `railBehavior.component.test.ts:172` pins the acknowledgement being
  per-change rather than global. The first load promotes nothing, because
  there is no change until there is a previous projection to differ from.
- **§11.1's rails rule.** `RAIL_MAX_CARDS = 4`
  (`travel-buddy-standalone/src/features/telegraph/sharedContext/railBehavior.ts:23#RAIL_MAX_CARDS`)
  and everything past it is behind "See all"
  (`travel-buddy-standalone/src/features/telegraph/sharedContext/SharedContextRail.tsx:194#telegraph-rail-see-all`).
- **§11.3's reduced motion, fixed at the one place it was wrong.**
  `MessageEntrance` had exactly one gate and it was a PAGINATION rule; nothing
  in the Telegraph tree read the OS setting. It now does —
  `travel-buddy-standalone/src/components/MessageEntrance.tsx:55#useReducedMotionSetting`
  — reusing the hook the Wall already had, and a viewer with reduced motion on
  gets the static View on every message
  (`travel-buddy-standalone/src/features/telegraph/__tests__/MessageEntrance.reducedMotion.component.test.tsx:53`).
- **§11.1's two themes exist, and the accents are separated.**
  `travel-buddy-standalone/src/features/telegraph/theme/telegraphTheme.ts:86#DARK`
  is the dark palette the token file never had, `telegraphPalette`
  (`:111#telegraphPalette`) resolves it, and `operational` (teal/cyan) is a
  different token from `attention` (the app's vermilion), which the rail uses
  for exactly one thing: the urgent-change card. The contrast of both palettes
  is computed from the real token values in
  `travel-buddy-standalone/src/features/telegraph/__tests__/telegraphTheme.component.test.ts:92`.

### 10.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T13 | N | **C** | **Rail at the top of each conversation showing mutually relevant objects** — The component exists and is mounted on BOTH conversation surfaces — `travel-buddy-standalone/app/messages/[id].tsx:2089#SharedContextRail` and `travel-buddy-standalone/src/components/GroupChatScreen.tsx:815#SharedContextRail` — between the header and the message list, fed by a mounted route (`routes/index.ts:188#telegraphSharedContextRouter`). What would turn this red (P24): a third conversation surface appearing without it; nothing pins that. |
| T14 | N | **C** | **Eligibility: created by me, joined/saved/attended by them** — `relationshipFor` reads the source object's own owner column and returns `CREATED_BY_ME_JOINED_BY_THEM` when the viewer created it and a conversation counterpart joined (`services/telegraph/sharedContext.ts:344#resolveSharedTrips`, `:405#resolveSharedMeetups`, `:467#resolveSharedEvents`). Asserted against a trip Alice owns and Bob joined, `test/telegraphSharedContext.test.ts:498`. |
| T15 | N | **C** | **Eligibility: created by them, joined/saved/attended by me** — Same resolver, the other branch — asserted against a meetup Bob created and Alice accepted, `test/telegraphSharedContext.test.ts:498`. |
| T16 | N | **C** | **Eligibility: both members of the same Trip, Plan, Crew, Event or booking** — Four resolvers, four canonical membership tables: `trip_members` (the crew table — a trip's crew IS `trip_members`; `circle_memberships` is a personal address book, not a shared crew, and is deliberately not read), `meetup_invites` (Plan), `event_attendees` (Event), `rent_buddy_bookings` (booking). `services/telegraph/sharedContext.ts:521#resolveSharedBookings` is the booking one. |
| T17 | N | **C** | **Eligibility: both deliberately promoted an item into a shared wishlist / Want-to-Do** — `resolveSharedWantToDo` (`services/telegraph/sharedContext.ts:567#resolveSharedWantToDo`) admits an entity only when two conversation members independently hold a `collection_items` row for it — a row that exists only because each pressed Save. Banded UNRESOLVED, which is §3.3's "UNRESOLVED / WANT TO DO". A place only the viewer saved is absent (`test/telegraphSharedContext.test.ts:480`). |
| T18 | N `∅` | **C** | **Past shared objects available in the historical view only when still authorized** — No longer an unguarded absence: the historical view exists (`past[]`) and authorization is enforced twice — in the resolvers' `status = 'accepted'` filter and again in `admitCandidate`'s `viewer_unauthorized` refusal (`services/telegraph/sharedContext.ts:246#admitCandidate`). A trip the viewer was removed from is absent from `past`, proved at `test/telegraphSharedContext.test.ts:490`. |
| T19 | N `∅` | **C** | **Never infer mutuality from chat alone** — The unguarded absence is now a guarded one. A closed source list without `messages` (`services/telegraph/sharedContext.ts:198#CANONICAL_MUTUALITY_SOURCES`), a refusal branch that names the reason (`:246#admitCandidate`), and a test that reads the module's own `.from(...)` calls and fails if the message table ever appears (`test/telegraphSharedContext.test.ts:394`). A discovery card posted in the thread is in the fixture and does not reach the rail (`:468`). |
| T20 | N | **C** | **Ordering: HAPPENING NOW → STARTING SOON → TODAY → UPCOMING → ACTIVE TRIP → UNRESOLVED → PAST** — `services/telegraph/sharedContext.ts:95#SHARED_CONTEXT_ORDER` is the seven bands in the spec's order and its index IS the sort rank; `classifyBand` (`:137#classifyBand`) assigns them. End-to-end ordering asserted through the route at `test/telegraphSharedContext.test.ts:449`. |
| T21 | N | **C** | **`TelegraphSharedContextProjection` / `SharedContextItem` contract** — Both interfaces are declared with §3.4's field names and produced by one builder (`services/telegraph/sharedContext.ts:648#buildSharedContextProjection`). This is NOT `services/passport/SharedContextService.ts` — that module answers Passport §17/§18's question about a profile pair and neither imports the other. |
| T126 | N | **C** | **Horizontal rails only for short high-value context sets, with "See all"** — `RAIL_MAX_CARDS = 4` (`travel-buddy-standalone/src/features/telegraph/sharedContext/railBehavior.ts:23#RAIL_MAX_CARDS`) with the remainder behind a See-all control (`travel-buddy-standalone/src/features/telegraph/sharedContext/SharedContextRail.tsx:194#telegraph-rail-see-all`), asserted both as logic (`railBehavior.component.test.ts:108`) and as rendered tree (`SharedContextRail.component.test.tsx:118`). |
| T128 | N | **C** | **Rail behaviour: active plan → expanded NOW card at top** — Server decides the mode (`services/telegraph/sharedContext.ts:717#railModeFor`) so client and server cannot disagree; the client renders the first NOW item expanded (`railBehavior.component.test.ts:80`, `SharedContextRail.component.test.tsx:83`). |
| T129 | N | **C** | **Rail behaviour: upcoming only → compact horizontal cards** — `railModeFor` returns COMPACT_UPCOMING when `now` is empty and `upcoming` is not; rendered as a horizontal card row (`railBehavior.component.test.ts:87`). |
| T130 | N | **C** | **Rail behaviour: none → collapsed summary ("3 shared plans · 1 past trip")** — `collapsedSummary` (`services/telegraph/sharedContext.ts:725#collapsedSummary`) renders the spec's example string exactly, and the rail collapses to it (`railBehavior.component.test.ts:94`). |
| T131 | N | **C** | **Rail behaviour: user scrolls down → rail collapses, messages get priority** — `shouldCollapseOnScroll` (`travel-buddy-standalone/src/features/telegraph/sharedContext/railBehavior.ts:29#shouldCollapseOnScroll`) is driven by the conversation's own scroll handler (`travel-buddy-standalone/app/messages/[id].tsx:2114#setRailCollapsed`) and collapses the rail to one line (`railBehavior.component.test.ts:66`, `SharedContextRail.component.test.tsx:148`). |
| T132 | N | **C** | **Rail behaviour: critical plan change → temporary promoted change card until acknowledged** — `detectCriticalChanges` (`travel-buddy-standalone/src/features/telegraph/sharedContext/railBehavior.ts:66#detectCriticalChanges`) diffs the seen projection against the fetched one for a cancellation or a moved start; the card is promoted above the scroll rule and disappears only on acknowledgement, per change (`railBehavior.component.test.ts:172`). The acknowledgement primitive T132's old evidence said did not exist is this. |
| T134 | W | **C** | **Reduced-motion behaviour for media, GIFs and animations** — The wrong gate is no longer the only gate: `travel-buddy-standalone/src/components/MessageEntrance.tsx:55#useReducedMotionSetting` consults the OS setting and returns the static View, proved both ways in `travel-buddy-standalone/src/features/telegraph/__tests__/MessageEntrance.reducedMotion.component.test.tsx:53`. Scoped honestly: GIFs and inline video are still N/? rows of their own (T52, T61, T64) — this row is the animation half, which is what Telegraph actually animates today. |
| T4 | N | **W** | **Pillar **Together** — every conversation can expose shared Trips, plans, events, places, Memories, history** — Five of six now: Trips, plans (meetups), events, places (both-saved `WANT_TO_DO`) and history (`past[]`) all reach the conversation through the rail. **Memories do not** — no resolver reads `memories`, and §10's Memory Note rows (T117–T122) are still N. |
| T133 | C | **C** | **Do not encode delivery/availability solely by colour** — Unchanged verdict, stronger evidence: every rail band renders its WORD first (`travel-buddy-standalone/src/features/telegraph/theme/telegraphTheme.ts:127#statusLabelFor`), the colour rule beside it is reinforcement, and the three-word assertion is in `SharedContextRail.component.test.tsx:101`. |

**Rows looked at that did NOT move, and why:**

| id | stays | why it did not move |
| --- | --- | --- |
| T9 | W | **Conversation header: name · availability · safe presence** — The SERVER half is built and tested — `routes/telegraphSharedContext.ts:223#/threads/:threadId/conversation-header` returns the counterpart's explicit, unexpired, visibility-admitted availability window and their consented coarse presence, and `needs_help` is never selected (`routes/telegraphSharedContext.ts:295#status_label`). The CLIENT header still renders name and one subtitle tag only; nothing consumes the new route yet. A route with no screen is not a header. |
| T28 | W | **Availability expires automatically and revokes across Telegraph, Discovery and Compass** — Telegraph now READS availability, which it never did, and re-evaluates expiry on the read through Passport's own predicate (`routes/telegraphSharedContext.ts:260#projectPublicWindows`), so an expired window cannot render as current (`test/telegraphSharedContext.test.ts:604`). It stays W for the ceiling §8.5 already records: `open_to_plans_windows_enabled` is seeded OFF and no database has it on, so on every deployment of this tree the read returns `enabled:false` and nothing else. |
| T123 | W | **Components must support Portava light/dark themes** — The missing half is built — a dark palette, a resolver and a hook (`travel-buddy-standalone/src/features/telegraph/theme/telegraphTheme.ts:86#DARK`) — and the new feature components use it. The inbox, the conversation shell and the message bubbles still import the static single-palette `TG` from `travel-buddy-standalone/src/theme/telegraphTokens.ts:10`, so "components support both themes" is true of the rail and false of Telegraph. Adoption is the remaining work, not construction. |
| T124 | W | **Restrained teal/cyan as operational emphasis; stronger attention reserved for safety and urgent changes** — Same boundary. The separation now EXISTS and is enforced by test (`travel-buddy-standalone/src/features/telegraph/__tests__/telegraphTheme.component.test.ts:92`), and the rail is the first surface where vermilion means only "urgent change". Everywhere else in Telegraph the accent is still `color.signal` for ordinary actions. |
| T8 | W | **Inbox is not a generic notification feed** — Untouched by this section. The rail is a CONVERSATION surface; §2.1's status / available-nearby / NOW / UPCOMING bands are an INBOX surface and still do not exist. |
| T16's "Crew" reading | — | Stated rather than hidden: this section reads §3.1's "Crew" as the trip crew (`trip_members`), which the resolver covers. `circle_memberships` is a per-user list, not a shared crew, and is deliberately not read. A reader who thinks Crew means something else should read T16 as W. |

### 10.3 The tests, and how each was shown red

`test/telegraphSharedContext.test.ts` — 33 tests, node:test, the real service and
the real router in a real express app over an in-memory PostgREST-shaped fake.
Shown red twice before commit: with `services/telegraph/sharedContext.ts` moved
aside the file cannot import (`# tests 1 / # pass 0 / # fail 1`), and with
`admitCandidate`'s `non_canonical_source` branch deleted the run is
`# pass 32 / # fail 1`, the one failure being the §3.2 refusal test. Restored:
33/33.

`travel-buddy-standalone/src/features/telegraph/__tests__/railBehavior.component.test.ts` —
14 tests. Shown red by disabling the scroll branch and by replacing the
acknowledgement filter with `[0]`: 2 failed, 12 passed. Restored: 14/14.

`travel-buddy-standalone/src/features/telegraph/__tests__/SharedContextRail.component.test.tsx` —
9 tests against the rendered tree.

`travel-buddy-standalone/src/features/telegraph/__tests__/MessageEntrance.reducedMotion.component.test.tsx` —
3 tests. Shown red by pinning `reduceMotion = false` (the state before this
change): 1 failed, 2 passed. Restored: 3/3.

`travel-buddy-standalone/src/features/telegraph/__tests__/telegraphTheme.component.test.ts` —
10 tests, contrast computed from the real tokens. Shown red by setting the dark
palette's operational accent to `color.signal`: 1 failed, 9 passed. Restored:
10/10.

### 10.4 The ceiling

No migration and no flag bounds §3: the rail reads tables production already
has, and every artifact is code. That is why nine N rows reach C rather than W.

What is NOT claimed. The rail is **on a branch**, and built on a branch is not
merged, merged is not deployed, deployed is not flag-enabled. The
`conversation-header` route has no consumer yet, so §2.2 stays W. The
availability half of that route is dark on every deployment of this tree because
`open_to_plans_windows_enabled` is seeded OFF — reading it is built, seeing it is
not. The theme rows stay W because a palette nobody imports is a palette, not a
theme. And no guard pins the rail's mount points: a third conversation surface,
or a Telegraph component created outside `src/features/telegraph/`, would make
T13 false without anything going red.

One structural gap worth recording, because it bounds this whole document and
not just this section: **`census-telegraph.md` declares no `head_commit` and has
no entry in `CENSUS_SCOPE`** (`src/scripts/checkCensusFreshness.ts:77#CENSUS_SCOPE`),
so `check:census-freshness` reports it as CANNOT BE CHECKED and no change to any
Telegraph file ages it. Adding both is an owner decision — it would immediately
mark this census stale for every lane currently writing into it — and is left
open here rather than taken unilaterally.

### 10.5 §5 Universal Portava Sharing — the contract, and the end of the frozen snapshot

§5 scored one C out of twelve, and the row that mattered most was T46, the only
verdict in this census phrased as **"Violated, not merely absent"**: a shared
card was the JSON the sender serialised at send time, rendered forever, with no
refetch and no authorization call. A place made private, or a post deleted,
after sharing still rendered in full inside the thread. That is §5.3's exact
prohibition — *"Telegraph is never a backdoor into revoked source content"* —
and it was being violated on every thread that had ever carried a card.

- **§5.1's interface exists, verbatim, and is instantiated per family.**
  `TelegraphShareable`
  (`services/telegraph/shareables.ts:107#TelegraphShareable`) declares
  `getSharePreview` / `getCurrentState` / `getAvailableActions` /
  `getDeepLink`, and `shareableFor`
  (`services/telegraph/shareables.ts:1041#shareableFor`) returns one for any of
  fifteen object types across §5's five families —
  `services/telegraph/shareables.ts:1031#SHAREABLE_OBJECT_TYPES`. A family with
  no loader returns `null`, and the resolver answers `not_found` rather than
  inventing a card: an unknown family must not silently become a live
  reference.
- **§5.2's third layer is the whole point, and it is computed per read.**
  `resolveShareProjections`
  (`services/telegraph/shareables.ts:1125#resolveShareProjections`) takes a
  batch of references and a VIEWER and returns, for each, either a projection
  built from the live source row or an explicit unavailable state with a
  reason. An unavailable reference carries `projection: null`, `actions: []`
  and nothing else — the title, the image and the blurb do not survive
  revocation. The loaders never even construct a projection for an object they
  are refusing, so the backdoor is closed twice; `test/telegraphShare.test.ts:324`
  measures that redundancy (opening it takes two mutations, not one).
- **Every loader fails CLOSED.** supabase-js resolves on a database error, so
  an unchecked read turns "we could not tell" into "no such row" — and on this
  path the permissive reading is the dangerous one. All nine reads bind and
  read `error`, and an unreadable source degrades with reason `unknown`
  (`test/telegraphShare.test.ts:402`, four tables).
- **Memory visibility is refused rather than approximated.** `loadMemory`
  (`services/telegraph/shareables.ts:483#loadMemory`) grants `public`, an
  explicit `allowed_user_ids` entry, or ownership, and degrades
  `friends_only` / `trip_crew` / `circle_only` to `private`. Guessing at a
  relationship read owned by the Memories surface is exactly the backdoor §5.3
  forbids, so the ladder stops where this module's knowledge stops
  (`test/telegraphShare.test.ts:363`).
- **The envelope is a REFERENCE.** `PortavaObjectBody`
  (`services/telegraph/shareables.ts:1203#PortavaObjectBody`) carries five
  fields — kind, objectType, objectId, the sender's caption, and a version —
  and nothing from the object. `buildPortavaObjectBody` (`:687#buildPortavaObjectBody`)
  is the only constructor and `parsePortavaObjectBody` (`:702#parsePortavaObjectBody`)
  refuses a future version rather than half-reading it.
- **Two routes, mounted.** `POST /threads/:threadId/share`
  (`routes/telegraphShare.ts:80#/threads/:threadId/share`) applies the SAME
  four gates the ordinary send path applies — kill switch, active membership,
  1:1 block guard, E2EE refusal
  (`routes/telegraphShare.ts:106#guardTelegraphThreadWrite`) — and then resolves the
  object FOR THE SENDER and refuses when the sender cannot open it. Sharing is
  not a way to launder a reference to something you were never authorized to
  see. `POST /threads/:threadId/share-projections`
  (`routes/telegraphShare.ts:190#/threads/:threadId/share-projections`) is the
  batch resolve. Both mounted at `routes/index.ts:189#telegraphShareRouter`.
- **The client half, including the cards that were already wrong.**
  `travel-buddy-standalone/src/features/telegraph/sharing/useShareRevocation.ts:50#useShareRevocation`
  is a THREE-state hook — available / unavailable / unknown — and the third
  state is load-bearing: no thread id, an unmappable legacy `sourceType`, or a
  failed resolve all mean "could not tell", and a card in that state renders
  exactly as it did before §5 existed. Collapsing `unknown` into `available` is
  the backdoor; collapsing it into `unavailable` blanks every card on a network
  blip. `DiscoveryCardMessage`
  (`travel-buddy-standalone/src/components/DiscoveryCardMessage.tsx:93#revocation.state`)
  and `PostCardMessage`
  (`travel-buddy-standalone/src/components/PostCardMessage.tsx:85#revocation.state`)
  now take an optional `threadId` and render a revoked notice instead of the
  snapshot; `PortavaObjectMessage`
  (`travel-buddy-standalone/src/features/telegraph/sharing/PortavaObjectMessage.tsx:28#PortavaObjectMessage`)
  is the new kind, dispatched on both conversation surfaces
  (`travel-buddy-standalone/app/messages/[id].tsx:869#PortavaObjectMessage`,
  `travel-buddy-standalone/src/components/GroupChatScreen.tsx:847#PortavaObjectMessage`).

### 10.6 §5 row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T41 | N | **C** | **`TelegraphShareable` interface — `getSharePreview` / `getCurrentState` / `getAvailableActions` / `getDeepLink`** — all four methods exist under those names (`services/telegraph/shareables.ts:107#TelegraphShareable`) and are implemented for fifteen object types (`:1041#shareableFor`), asserted family by family at `test/telegraphShare.test.ts:252`. |
| T44 | N | **C** | **Four-layer model: Share projection — what the recipient is *currently* authorized to see** — the layer exists and is computed per (viewer, object) on every read (`services/telegraph/shareables.ts:1125#resolveShareProjections`); the card is no longer whatever the sender serialised. |
| T46 | W | **C** | **Revocation: a deleted/private/unauthorized source degrades to unavailable; never a backdoor into revoked content** — the violation is closed on both ends. Server: an unavailable reference carries `projection: null` and `actions: []`, proved by the assertion that the deleted post's own words do not appear anywhere in the serialised response (`test/telegraphShare.test.ts:324`). Client: the two cards that WERE frozen snapshots now re-resolve and degrade (`travel-buddy-standalone/src/features/telegraph/__tests__/shareRevocation.component.test.tsx:134`, `:165`). |
| T43 | W | **C** | **Four-layer model: Source object** — a reference is now a RESOLVED reference, not a payload field: the envelope carries only `(objectType, objectId)` (`services/telegraph/shareables.ts:1203#PortavaObjectBody`) and the renderer dereferences it through the registry. The census's objection — "a payload field, not a resolved reference … nothing dereferences it at render" — is answered by `travel-buddy-standalone/src/features/telegraph/sharing/PortavaObjectMessage.tsx:28#PortavaObjectMessage`. |
| T55 | W | **C** | **Message kind PORTAVA_OBJECT** — it is now a typed kind, not `system` plus a bespoke subtype: the route writes `msg_type='portava_object'` (`routes/telegraphShare.ts:80#/threads/:threadId/share`), `messages.msg_type` carries no CHECK so this needs no migration (`baseline/20260819_baseline_structure.sql:7565`), and both conversation surfaces dispatch it. |
| T35 | W | **W** | **One consistent share contract for all eligible Portava content** — the contract now EXISTS and fifteen types implement it, which is the half that was missing. It stays W because the four legacy producers the census named still write their own bespoke JSON (`discovery_card`, `post_card`, `compass_card`, `circle_status_card`): the new cards are revocable, but they are revocable by MAPPING the old payload, not by the old producers having moved to the contract. One contract plus four legacy shapes is not yet one shape. |
| T36 | W | **W** | **Object family Social — profile, post, Highlight, public Memory derivative, Memory Note, Stamp** — profile, post and Memory are now shareable through the contract (`services/telegraph/shareables.ts:1031#SHAREABLE_OBJECT_TYPES`). Highlight and Stamp have no loader and `STAMP` is not in the registry, so three of six. |
| T37 | N | **W** | **Object family Travel — Trip, Trip stage, plan, event, route, reservation-safe derivative, layover plan** — was "none of the seven is shareable into a thread"; four now are (TRIP, TRIP_STAGE, PLAN/MEETUP, EVENT), each with its own authorization read. Route, reservation-safe derivative and layover plan have no loader. |
| T38 | W | **W** | **Object family Places — place, Hidden Gem, map pin, neighborhood, meetup point** — place, gem, map pin and meetup point resolve through the contract; NEIGHBORHOOD is in the vocabulary and deliberately has no loader, so `shareableFor` returns null for it rather than pretending (`test/telegraphShare.test.ts:295`). Four of five. |
| T39 | W | **W** | **Object family Services — Buddy profile/service, eligible booking card, Visa Buddy operational card** — the booking card now resolves with its two-party authorization (`services/telegraph/shareables.ts:1041#shareableFor`), and BUDDY_SERVICE maps to the same loader. There is no Visa Buddy card and no standalone Buddy profile share. |
| T3 | W | **W** | **Pillar Share — any eligible Portava object moves through a safe permission-aware share projection** — the "permission-aware share projection" half is now real and is exactly what §5.2 asked for. It stays W on "any eligible object": four object families are covered and Media (§5's fifth family — photo, video, voice, GIF, file) is not a shareable type at all; it travels as message media, which is a different mechanism. |

### 10.7 The §5 tests, and how each was shown red

`test/telegraphShare.test.ts` — 34 tests, node:test, the real registry and the
real router over an in-memory PostgREST-shaped fake. Four mutations, each
observed red and reverted:

| mutation | result |
| --- | --- |
| `loadPost` ignores `deleted_at` / `status` | pass 31 / fail 3 |
| a projection BUILT for the deleted row AND carried on the unavailable branch | pass 32 / fail 2 — carrying it alone stays green, because a loader never builds one for an object it refuses; that redundancy is deliberate and this is how it was measured |
| all nine `if (error)` guards disabled | pass 30 / fail 4 |
| the sender-side `getCurrentState` check dropped from `POST /share` | pass 33 / fail 1 |

`travel-buddy-standalone/src/features/telegraph/__tests__/shareRevocation.component.test.tsx`
— 11 tests against the REAL card components and the REAL hook, with only the
network call stubbed. Shown red by disabling `DiscoveryCardMessage`'s revoked
branch (its pre-§5 behaviour, 1 failed / 10 passed) and by making a failed
resolve read as `unavailable` (1 failed / 10 passed). Both restored: 11/11.

### 10.8 The §5 ceiling

No migration: `messages.msg_type` has no CHECK constraint, so the
PORTAVA_OBJECT kind needs no DDL, and every table the loaders read is in
`baseline/20260907_production_tables.txt`. That is why T41, T43, T44, T46 and
T55 reach C rather than W.

What is NOT claimed:

- **The old producers have not moved.** `DiscoveryShareSheet`, the post
  ShareSheet, the Compass tray and `routes/circle.ts` still write their own
  JSON shapes. Their cards are now revocable because the client MAPS
  `sourceType` into the §5 vocabulary
  (`travel-buddy-standalone/src/features/telegraph/sharing/shareApi.ts:148#legacySourceTypeToObjectType`),
  and a `sourceType` outside that map — `for_you`, `compass_card` — stays in
  the `unknown` state and renders as before. T35 stays W for exactly this.
- **Nothing sends a PORTAVA_OBJECT yet from the UI.** The route is mounted and
  the renderer is wired on both surfaces, but no share sheet calls
  `shareObjectIntoThread`
  (`travel-buddy-standalone/src/features/telegraph/sharing/shareApi.ts:101#shareObjectIntoThread`).
  A traveler will SEE a correctly-degrading card; they cannot yet CREATE one
  without the API. That is why T36–T39 stay W rather than moving on coverage
  alone.
- **Media is not a shareable family.** §5's fifth family is carried by
  `messages.media_*`, whose CHECK is `('image','video')`
  (`baseline/20260819_baseline_structure.sql:7573`) — voice, GIF and file need
  DDL, and those rows (T40, T52, T53) are untouched here.
- **Branch, not deployment.** Built on a branch is not merged; merged is not
  deployed.

### 10.9 §6 Rich Messaging — seven kinds, the drawer that was dead code, and search

§6 scored four C out of twenty-two. Eight of §6.2's thirteen message kinds did
not exist; §6.4's content drawer was **deliberately dead-coded** — the census
found `app/messages/[id].tsx` carrying
`{false ? <Pressable … onPress={() => Alert.alert('Thread info', '… coming
soon.')}> : null}`, an affordance behind a literal `false` with no route and no
service behind it; and there was no search over conversation content at all.

The asymmetry that shapes everything here: `messages.msg_type` is
`text NOT NULL DEFAULT 'text'` with **no CHECK**
(`baseline/20260819_baseline_structure.sql:7565`), while `messages.media_type`
carries `CHECK (media_type IN ('image','video'))` (`:7573`). So a KIND costs
nothing and an ASSET TYPE costs a migration. Seven kinds whose payload is
structured data are carried as validated JSON envelopes and need no DDL. VOICE
is **refused by name, with the reason**, because a kind that cannot carry its
asset is not a kind.

- **`services/telegraph/messageKinds.ts`** declares a zod payload per kind and
  `validateKindMessage` (`services/telegraph/messageKinds.ts:244#validateKindMessage`)
  turns a (kind, payload) pair into the row that will be written — `msg_type`
  from the kind, `subtype` from the kind's own discriminator (SAFETY's four
  classes, LOCATION's precision, ACTION's action name).
  `SENDABLE_ENVELOPE_KINDS` (`:136#SENDABLE_ENVELOPE_KINDS`) is the seven;
  `UNSENDABLE_KINDS` (`:146#UNSENDABLE_KINDS`) is every other §6.2 kind with
  the reason it is not here, so a reader can tell "not built" from "built and
  broken". A test asserts every one of §6.2's thirteen is in one list or the
  other — none is silently missing (`test/telegraphKinds.test.ts:279`).
- **§4.3 lands in the LOCATION payload.** `precision` defaults to `area`;
  `exact` is a value the sender must choose. The client sheet opens on
  "Approximate area" and "Exact" is a second tap
  (`travel-buddy-standalone/src/features/telegraph/composer/TypedComposePrompt.tsx:37#TypedComposePrompt`),
  and nothing in that sheet reads the device GPS.
- **§8.2 lands in the ACTION payload.** `requiresConfirmation` is a
  `z.literal(true)`, so a caller cannot send an already-confirmed action; the
  forged value is a 400 (`test/telegraphKinds.test.ts:318`).
- **§6.4's drawer is a CLASSIFIER over rows the thread already has.**
  `drawerTabFor` (`services/telegraph/messageKinds.ts:316#drawerTabFor`) routes
  each row to one of §6.4's seven tabs
  (`services/telegraph/messageKinds.ts:303#DRAWER_TABS`), including the legacy
  `discovery_card` / `post_card` producers, so an OLD card is indexed too. The
  route writes nothing and says so in its own response (`indexOnly: true`).
- **§6.4's search is object-aware, and its authorization is not new law.**
  `searchableTextOf` (`services/telegraph/messageKinds.ts:371#searchableTextOf`)
  returns null for a deleted row and for an unsent one (on a database that has
  the column), which is §7.4's "remove from normal retrieval, search and
  projections"; and it searches a typed envelope's HUMAN fields — label, title,
  caption, note — never its ids and urls, which is what "object-aware" buys
  over a LIKE over `body`.
- **Both surfaces inherit §14.3.** `memberWindow`
  (`routes/telegraphKinds.ts:86#memberWindow`) resolves the caller's history
  bound through `services/groupChatHistoryBound.ts` — the one module that owns
  that rule — and `readIndexableRows` (`routes/telegraphKinds.ts:140#readIndexableRows`)
  applies it in the query AND in a post-filter. A member added yesterday cannot
  reach last month's photos through the drawer or find them by searching
  (`test/telegraphKinds.test.ts:489`, `:515`).
- **The write gates are shared, not re-implemented.**
  `lib/telegraphThreadWrite.ts:80#guardTelegraphThreadWrite` holds the four
  checks the ordinary send path applies — kill switch, active membership, 1:1
  block guard, E2EE refusal — and the §5 share route and the §6.2 typed-kind
  route both call it. A second write endpoint that skipped one of them would be
  a weaker door into the same table.
- **The routes are mounted** at `routes/index.ts:190#telegraphKindsRouter`.
- **The client.** `TypedMessageRenderer`
  (`travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:65#TypedMessageRenderer`)
  renders all seven, dispatched from the conversation at
  `travel-buddy-standalone/app/messages/[id].tsx:844#rendersTypedKind`. The
  content drawer replaces the dead code at
  `travel-buddy-standalone/app/messages/[id].tsx:1958#telegraph-open-content-drawer`
  and is `travel-buddy-standalone/src/features/telegraph/drawer/ContentDrawerSheet.tsx:52#ContentDrawerSheet`.
  The composer's `+` button opens §6.1's menu
  (`travel-buddy-standalone/app/messages/[id].tsx:2376#setShowPlusMenu`).

### 10.10 §6 row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T51 | N | **C** | **Message kind MEDIA_ALBUM** — a validated kind with at least two independent asset references in one message (`services/telegraph/messageKinds.ts:244#validateKindMessage`), sent, stored and rendered (`travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:65#TypedMessageRenderer`). One asset is refused — that is an IMAGE or a VIDEO, not an album (`test/telegraphKinds.test.ts:302`). |
| T65 | N | **C** | **Mixed-media albums: one reply target and one seen lifecycle, independent asset references** — true by construction: an album is ONE `messages` row, so it has exactly one `reply_to_id` and one position in the single thread-level receipt, and its assets are separate entries in the payload. Rendered as one bubble with N cells (`travel-buddy-standalone/src/features/telegraph/__tests__/kinds.component.test.tsx:106`). |
| T56 | N | **C** | **Message kind LOCATION** — a kind with a precision ladder whose default is COARSE (§4.3), a subtype that records which precision the sender chose, and a renderer that shows the precision in words (`travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:65#TypedMessageRenderer`). |
| T57 | N | **C** | **Message kind ACTION** — actions are no longer inferred from card subtypes: `ACTION` is a kind carrying a §8.1 action name and a `requiresConfirmation` literal `true`, rendered as a proposal with a Confirm control (`travel-buddy-standalone/src/features/telegraph/__tests__/kinds.component.test.tsx:70`). |
| T58 | N | **C** | **Message kind ANNOUNCEMENT** — a kind with a title, an optional body and an optional acknowledgement requirement, rendered with the acknowledge control only when it asks for one. |
| T54 | N | **C** | **Message kind MEMORY_NOTE** — the kind exists and carries §10.1's `MemoryNoteShare` field set (`services/telegraph/messageKinds.ts:244#validateKindMessage`), with an authoring sheet (`travel-buddy-standalone/src/features/telegraph/__tests__/typedComposeMemoryNote.component.test.tsx:41`). What is NOT claimed is T117's contract row — see below. |
| T52 | N | **C** | **Message kind GIF** — a distinct kind with its own payload (url, still frame, provider, alt text) and its own renderer, separate from IMAGE/VIDEO. No provider is configured to pick one FROM, which is T64's row and the composer entry's stated reason, not this one's: the kind exists, validates, sends, stores and renders. |
| T64 | N | **W** | **GIFs are distinct lightweight looping content with data-saver / accessibility controls** — the CONTROLS are built: `isGifAnimated` (`travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:33#isGifAnimated`) is a pure rule — animate only when neither reduced motion nor data saver is on — and the still frame carries the reason in words. It stays W because `dataSaver` is a prop with no app-level setting behind it yet, and because no provider exists to obtain a GIF from. |
| T60 | W | **C** | **Message kind SAFETY** — SAFETY is now a message KIND, not only a thread affordance: four classes (`check_in`, `heads_up`, `need_help`, `all_clear`), each landing in `subtype`, rendered with the class as a WORD and the §11.1 attention colour reserved for it (`travel-buddy-standalone/src/features/telegraph/__tests__/kinds.component.test.tsx:98`). |
| T66 | N | **C** | **Content drawer: MEDIA / PLACES / PORTAVA / VOICE / GIFS / LINKS / FILES** — the seven tabs exist with counts, served by `GET /threads/:id/drawer` (`routes/telegraphKinds.ts:262`) and rendered by `travel-buddy-standalone/src/features/telegraph/drawer/ContentDrawerSheet.tsx:52#ContentDrawerSheet`. The dead-coded entry point is now a real control (`travel-buddy-standalone/app/messages/[id].tsx:1958#telegraph-open-content-drawer`). |
| T67 | N `∅` | **C** | **The drawer is a structured index, not a second storage copy** — no longer an unguarded absence. The drawer exists and stores nothing: it classifies `messages` rows in memory (`services/telegraph/messageKinds.ts:316#drawerTabFor`), every id it returns is a `messages.id` that already existed, and the route writes nothing and declares `indexOnly: true` in its own response. |
| T68 | N | **C** | **Object-aware search respects current authorization and unsent/deleted state** — `GET /threads/:id/search` (`routes/telegraphKinds.ts:397#"/threads/:threadId/search",`) is member-gated, §14.3-bounded and tombstone-excluding, and matches on a typed object's HUMAN fields rather than on raw JSON (`services/telegraph/messageKinds.ts:371#searchableTextOf`). A deleted message is not findable by its exact text (`test/telegraphKinds.test.ts:531`). |
| T47 | W | **W** | **Composer stays visually calm; rich actions live behind a `+` menu** — the menu now names all EIGHT of §6.1's entries instead of two (`travel-buddy-standalone/src/features/telegraph/composer/composerMenu.ts:48#COMPOSER_ENTRIES`), and an entry that cannot complete states its reason INLINE rather than being hidden. Five of eight are operable (Camera, Photos, Video, Location, Memory Note); GIF has no provider, Voice has no audio asset type, and Portava has no in-composer object picker. Two of eight became five of eight — better, not done. |
| T53 | N | **N** | **Message kind VOICE** — deliberately NOT moved. It is now REFUSED by name with the constraint that blocks it (`services/telegraph/messageKinds.ts:204#UNSENDABLE_KINDS`), which is honest, but a refusal is not a kind. It needs a migration widening `messages.media_type` and an audio MIME in `lib/mediaPipeline.ts:75`. |
| T63 | N | **N** | **Voice: waveform, seek, playback speed, optional transcript/translation** — unchanged. There are no voice messages to play. |
| T2 | W | **W** | **Pillar Talk — text, rich media, voice, GIFs, replies, reactions, seen states, safe message lifecycle** — six of eight now: text, media, GIFs (the kind), replies, seen, and the album/location/safety additions. **Voice, reactions and the safe lifecycle are still absent** — `message_reactions` does not exist and unsend does not exist on this branch. |
| T11 | W | **W** | **Semantic layer PLAN** — ACTION and ANNOUNCEMENT give the stream a genuinely different class of item with its own renderer and its own confirm/acknowledge affordance, which is more than "ordinary stream items". It stays W because there is still no LAYER: unresolved actions are interleaved with conversation rather than separated, which is what §2.3 asks for. |

### 10.11 The §6 tests, and how each was shown red

`test/telegraphKinds.test.ts` — 36 tests, node:test, the real classifier and
the real router over an in-memory PostgREST-shaped fake. Four mutations:

| mutation | result |
| --- | --- |
| `searchableTextOf`'s deleted/unsent guards disabled | pass 34 / fail 2 — and the route-level "a deleted message is NOT findable" test STAYED green, because the tombstone is excluded twice (in the query and in the predicate). That redundancy is deliberate and this is how it was measured. |
| `readIndexableRows` dropping both its `.gte(created_at, …)` and its `withinWindow` filter | pass 34 / fail 2 (the §14.3 drawer and search tests) |
| `UNSENDABLE_KINDS.VOICE` deleted | pass 33 / fail 3 |
| `drawerTabFor` returning `"MEDIA"` for everything | pass 32 / fail 4 |

Client, 5 files, 33 tests, each in its own file where the component is
Modal-rooted (`src/components/__tests__/TESTING.md` Rule 6 and its two-file
rule — measured here as a hard limit of two Modal mounts per file, recorded in
each file's header):

| file | mutation | result |
| --- | --- | --- |
| `kinds.component.test.tsx` | `isGifAnimated` ignoring `reduceMotion`; `safetyWord` returning one string | 3 failed / 9 passed |
| `composerMenu.component.test.tsx` | the VOICE entry's `available` flipped to true | 2 failed / 2 passed |
| `contentDrawer.component.test.tsx` | the failure branch replaced with an empty index | 1 failed / 4 passed |
| `typedCompose.component.test.tsx` | the precision default changed from `area` to `exact` | 1 failed / 2 passed |
| `typedComposeMemoryNote.component.test.tsx` | the empty-string guard removed | 1 failed / 1 passed |

### 10.12 The §6 ceiling

No migration for the seven kinds, the drawer or search: `msg_type` has no
CHECK and every read is over tables production has.

What is NOT claimed:

- **VOICE is not built and is not counted.** It is refused with its reason.
  The migration it needs (`messages.media_type` widened, an audio MIME in
  `lib/mediaPipeline.ts`) is not in this branch, and writing one would produce
  a row no deployed database could accept.
- **Three of §6.1's eight entries cannot complete** and say so on screen. The
  menu is honest, not finished.
- **The drawer scans the most recent 500 messages** and reports `truncated`
  when it hits that bound. A thread longer than that has an index of its recent
  content, not of all of it; paging it is unbuilt.
- **`dataSaver` has no setting behind it.** The rule is real and tested; the
  toggle that would set it is not in this tree, which is why T64 stays W.
- **Branch, not deployment.**

### 10.13 §8 and §9 — decisions, commitments, rendezvous, and the coordination surface

§9 had a state machine in the spec and none in the tree: *"No coordination
state machine anywhere. `lib/calls/callStateMachine.ts` is a call FSM,
unrelated."* Five of §9.1's seven quick states did not exist. §8's four named
objects were one analogue (the meetup time-poll) and three absences.

**Why these are projections and not tables.** Appendix A is explicit that the
spec's schema names are *"architectural names, not permission to create
duplicate tables if equivalent canonical structures already exist."* A decision
IS a question one person asked and answers other people gave — a message and
some messages. A second `conversation_decisions` table would be a second source
of truth for the same conversation AND a migration no database has, which would
cap every one of these rows at W. So each §8 object is carried as a typed
message and READ as a pure projection over the thread, and the rules that are
easy to get wrong become testable without a database.

- **§9's state machine is §9's arrows and only §9's arrows.** `legalNextStates`
  (`services/telegraph/coordination.ts:69#legalNextStates`) encodes
  PREPARING → ASSEMBLING → ACTIVE → RETURNING → COMPLETE with DISRUPTED and
  CANCELLED as the exits. DISRUPTED has outbound edges because it is
  recoverable; COMPLETE and CANCELLED have none, because §9's diagram has no
  arrow leaving either and inventing one would be this module deciding
  something the spec did not.
- **The state is DERIVED, not stored.** `derivedCoordinationState`
  (`services/telegraph/coordination.ts:111#derivedCoordinationState`) reads the
  plan's own timeline: before leave-by it is PREPARING, between leave-by and
  start ASSEMBLING, then ACTIVE, then RETURNING for two hours, then COMPLETE. A
  stored state drifts the moment an app is offline through a transition, and
  the repair would be a background job nothing in this tree runs. A plan with
  **no start time has NO state** — not PREPARING — so an undated wish cannot
  put a conversation into coordination mode
  (`test/telegraphCoordination.test.ts:286`).
- **"TEMPORARILY" is enforced.** §9 says the thread transforms *temporarily*
  near the leave-by window. `threadIsCoordinating`
  (`services/telegraph/coordination.ts:143#threadIsCoordinating`) excludes
  PREPARING for exactly that reason, and the client panel renders nothing while
  the state is PREPARING (`test/telegraphCoordination.test.ts:294`,
  `travel-buddy-standalone/src/features/telegraph/__tests__/coordinationPanel.component.test.tsx:88`).
- **§9.1's closing rule is enforced in the type and in the layout.** A quick
  state carries `provenance: z.literal("USER_DECLARED")`
  (`services/telegraph/coordination.ts:149#QuickStatePayload`), so a
  system-derived estimate is not REPRESENTABLE as a declared status — a caller
  sending `provenance: "SYSTEM_DERIVED"` is refused
  (`test/telegraphCoordination.test.ts:335`). On the client the derived state
  is the panel's title line and says *"derived from the plan"*, while declared
  statuses live under *"What people said"*; there is no row that could hold
  both.
- **§8's ConversationDecision has the three rules a naive tally gets wrong.**
  `projectDecision` (`services/telegraph/coordination.ts:244#projectDecision`)
  counts the LATEST vote per voter (a change of mind replaces, it does not
  add), RECORDS a vote cast after the deadline and does NOT count it (a
  deadline that changes nothing is not a deadline), and leaves a TIE
  **unresolved** (§8 asks for a final result; a tie does not have one). Four
  resolution rules — PLURALITY, MAJORITY, UNANIMOUS, ASKER_DECIDES — each with
  its own test.
- **§8's ConversationCommitment** (`services/telegraph/coordination.ts:374#projectCommitment`)
  answers §8's four questions — who agreed, to what, by when, and whether it
  was completed — and carries an `overdue` flag that is true only when the
  deadline passed with nothing completed.
- **§8's Rendezvous has all five properties**, not two:
  `services/telegraph/coordination.ts:167#RendezvousPayload` carries checkpoint,
  landmark, a time window, a fallback point and a coarse proximity state. There
  is deliberately no coordinate field, and a caller that sends `lat`/`lng` has
  them dropped (`test/telegraphCoordination.test.ts:562`).
- **§8.1's actions: seven carried here, seven named as owned elsewhere.**
  `COORDINATION_ACTIONS` (`services/telegraph/coordination.ts:600#COORDINATION_ACTIONS`)
  is MEET_HERE, SHARE_ROUTE, SHARE_AVAILABILITY, SHARE_LOCATION, SPLIT_RIDE,
  RETURN_TO_GROUP and DO_THIS_NOW. An action owned by a canonical surface is
  REFUSED here with where it lives (`test/telegraphCoordination.test.ts:525`),
  because routing it through a second endpoint would make a second writer for
  the same fact — exactly what Appendix A forbids. The route publishes the
  ownership map at `GET /telegraph/coordination-kinds`
  (`routes/telegraphCoordination.ts:182`).
- **§8.2 in the type, again.** An action proposal's `requiresConfirmation` is a
  `z.literal(true)`; a client cannot send a pre-confirmed action.
- **The routes.** `POST /threads/:threadId/coordination`
  (`routes/telegraphCoordination.ts:99`) writes through the same four gates as
  the ordinary send path; `GET /threads/:threadId/coordination`
  (`routes/telegraphCoordination.ts:212`) returns the derived state, the legal
  next states, the latest declared status per member, the arrival counts and
  the three projections, and inherits §14.3's history bound. Mounted at
  `routes/index.ts:192#telegraphCoordinationRouter`.
- **The client panel** is §2.2's "OPTIONAL COORDINATION PANEL", between the
  rail and the stream
  (`travel-buddy-standalone/app/messages/[id].tsx:2094#CoordinationPanel`,
  `travel-buddy-standalone/src/features/telegraph/coordination/CoordinationPanel.tsx:44#CoordinationPanel`).
  §9's per-state affordances are data
  (`travel-buddy-standalone/src/features/telegraph/coordination/coordinationApi.ts:210#STATE_AFFORDANCES`)
  so the Assembling row offers on-my-way / running-late / arrived /
  can't-make-it / start-without-me and the Returning row offers heading-back.

### 10.14 §8 and §9 row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T102 | N | **C** | **State machine PREPARING → ASSEMBLING → ACTIVE → RETURNING → COMPLETE ↘ DISRUPTED/CANCELLED** — the machine exists, its arrows are §9's arrows, its terminal states are terminal, and its current value is derived from the plan's own timeline (`services/telegraph/coordination.ts:69#legalNextStates`, `:111#derivedCoordinationState`). Served per thread at `routes/telegraphCoordination.ts:212`. |
| T103 | N | **C** | **Thread temporarily transforms into a coordination surface near the leave-by/start window** — leave-by exists (`services/telegraph/coordination.ts:130#leaveByFor`), the transformation is bounded to ASSEMBLING/ACTIVE/RETURNING/DISRUPTED (`:143#threadIsCoordinating`), and the panel renders only then (`travel-buddy-standalone/src/features/telegraph/__tests__/coordinationPanel.component.test.tsx:88`). A plan three days out leaves the conversation alone. |
| T109 | N | **C** | **Quick state ON_MY_WAY** — a validated §9.1 state whose name lands in the row subtype and which the Assembling affordance row offers (`test/telegraphCoordination.test.ts:322`). |
| T111 | N | **C** | **Quick state RUNNING_LATE** — same path. |
| T113 | N | **C** | **Quick state START_WITHOUT_ME** — same path; offered while assembling. |
| T112 | W | **C** | **Quick state CANT_MAKE_IT** — it is now an in-flight coordination status in its own right, not only an RSVP `declined`. The RSVP still answers plan attendance; this answers "not tonight" in the thread. |
| T114 | W | **C** | **Quick state HEADING_BACK** — named, declared and rendered, instead of being approximated by a `leaving` check-in and a Safe Return session start. It is the Returning row's first affordance. |
| T83 | W | **C** | **`ConversationDecision` — question, options, voters, resolution rule, deadline, final result** — all six, for any free-form question, not only "when shall we meet" (`services/telegraph/coordination.ts:244#projectDecision`). The three rules a naive tally gets wrong are each asserted (`test/telegraphCoordination.test.ts:388`, `:399`, `:411`). |
| T86 | W | **C** | **`Rendezvous` — checkpoint, landmark, time window, fallback point, proximity state** — five of five (`services/telegraph/coordination.ts:167#RendezvousPayload`), postable by any thread member rather than only a circle host. |
| T91 | W | **C** | **Action `MEET_HERE`** — a participant can now say "meet here" from the conversation: MEET_HERE is a coordination action (`services/telegraph/coordination.ts:600#COORDINATION_ACTIONS`) and RENDEZVOUS carries the point itself. It is no longer a circle-host-only operation with a card as a side effect. |
| T93 | N | **C** | **Action `SHARE_ROUTE`** — carried as a coordination action proposal into the thread. What it is NOT: a link into the map's route builder — the route travels as the proposal's own detail, not as a `route_plans` reference. |
| T95 | N | **C** | **Action `SHARE_AVAILABILITY`** — the action exists and reaches the thread. Its CEILING is §8.5's: `open_to_plans_windows_enabled` is seeded OFF, so on every deployment of this tree a traveler has no windows to share. The action is built; the data behind it is dark. |
| T96 | W | **C** | **Action `SHARE_LOCATION`** — it is a Telegraph action now, and the composer has a location entry (§6.1) whose message carries an explicit precision (§6.2 LOCATION, coarse by default). The separate trip-crew and Safe-Return live-share surfaces are unchanged and unrelated. |
| T97 | N | **C** | **Action `SPLIT_RIDE`** — a coordination action proposal; no canonical domain owns ride-splitting, so the proposal IS the object. |
| T99 | N | **C** | **Action `RETURN_TO_GROUP`** — a coordination action, alongside the HEADING_BACK quick state. |
| T100 | N | **C** | **Action `DO_THIS_NOW`** — a coordination action, and the §3 rail offers it on a WANT_TO_DO item (`services/telegraph/sharedContext.ts:287#availableActionsFor`). |
| T98 | W | **C** | **Action `CHECK_IN_SAFE`** — no longer circle-only: the §6.2 SAFETY kind carries a check-in from any thread, with four classes and a coarse label (`services/telegraph/messageKinds.ts:244#validateKindMessage`). The circle check-in path is untouched. |
| T105 | W | **C** | **Assembling UI: on my way, running late, meet here, ETA, pickup, arrival counts** — five of six are real: the three quick states, MEET_HERE/RENDEZVOUS, and arrival counts derived from declared states (`routes/telegraphCoordination.ts:212`). **ETA and pickup are not built**, and this row is graded C on the five the surface offers; a reader who requires all six should read it as W. |
| T104 | W | **W** | **Preparing UI: plan card, attendance, leave-by, route, availability conflicts** — leave-by is now real and the plan card and attendance were already. Route and availability-conflict detection in-thread are still absent, so three of five. |
| T106 | W | **W** | **Active UI: minimal conversation, next step, crew state, optional location scope** — the panel now IS a thread mode rather than a separate screen, and crew state is the declared-status list. There is no next-step surface and the location scope is still the separate trip-crew screen. |
| T107 | W | **W** | **Returning UI: heading back, Safe Return, shared transport, return checkpoint** — heading-back is now a first-class declared state and the return checkpoint is expressible as a RENDEZVOUS. Safe Return remains its own subsystem rather than a conversation state, and shared transport does not exist. |
| T84 | N | **W** | **`ConversationCommitment` — who agreed to what, by when, completed** — all four questions are answered by a projection over the thread's own messages (`services/telegraph/coordination.ts:374#projectCommitment`), which is a real object with a real contract. It stays W for a reason worth stating: a projection over one thread's messages is not a queryable store, so "what have I agreed to this week" cannot be answered across threads. The spec's Object row implies something a surface can list. |
| T85 | N | **W** | **`CoordinationSession`** — the session's BEHAVIOUR exists (a derived state, legal transitions, per-state affordances, arrival counts, a panel that appears and disappears) but there is no session ENTITY: nothing has an id, nothing records who started it or when it ended, and a DISRUPTED transition cannot be recorded because there is nowhere to record it. Deriving the state was the right call under Appendix A; a session object would need a table and would then be capped at W by the migration anyway. |
| T6 | W | **W** | **Pillar Act — messages/shared objects become plans, votes, meetups, navigation, coordination sessions** — four of five now: plans, votes (free-form decisions as well as meetup time polls), meetups, and coordination (as a mode, not a session object). **Navigation handoff still does not exist.** |
| T12 | N | **W** | **Semantic layer NOW** — there is now an active-coordination surface above the stream that appears only while the thread is coordinating. It stays W because it is a PANEL, not a LAYER: the message stream underneath is unchanged, so "minimal conversation" (§9's Active row) is not expressed. |

### 10.15 The §8/§9 tests, and how each was shown red

`test/telegraphCoordination.test.ts` — 42 tests, node:test, the real
projections and the real router over an in-memory PostgREST-shaped fake.

| mutation | result |
| --- | --- |
| `projectDecision` counting late votes | pass 41 / fail 1 |
| votes keyed by message id rather than by voter, so an earlier vote still counts | pass 41 / fail 1 |
| `derivedCoordinationState` returning PREPARING for a plan with no start, AND `TRANSITIONS.CANCELLED` given an outbound edge | pass 39 / fail 3 |

`travel-buddy-standalone/src/features/telegraph/__tests__/coordinationPanel.component.test.tsx`
— 12 tests against the real panel.

| mutation | result |
| --- | --- |
| the `!coordinating` early return disabled AND the "derived from the plan" label removed | 3 failed / 9 passed |
| the failed-read branch replaced with an empty coordinating panel | 1 failed / 11 passed — and it took defeating BOTH guards (`failed` and a null `data`) to get there, which is how that redundancy was measured |

### 10.16 The §8/§9 ceiling

No migration: every §8 object is a projection over `messages`, and §9's state is
derived from `meetups`. That is why fourteen rows reach C.

What is NOT claimed:

- **There is no CoordinationSession entity** (T85) and no commitment store
  (T84). Both are W, and both would need a table — which would cap them at W
  anyway until a database has it.
- **ETA does not exist anywhere in Telegraph.** §9's Assembling row names it,
  §4.3 names it, and nothing computes one. Every "ETA" mention in this section
  is a gap, not a feature.
- **SHARE_AVAILABILITY is built onto dark data.** The action reaches the
  thread; `open_to_plans_windows_enabled` is seeded OFF, so there are no
  windows to share on any deployment of this tree.
- **The panel is a panel, not a layer** (T12): the stream underneath does not
  change while the thread is coordinating, so §9's "minimal conversation" is
  unexpressed.
- **Branch, not deployment.**

### 10.17 §10 — Memory Notes, one-at-a-time save, and a recap that admits it wrote nothing

§10 is three requirements and **two prohibitions**, and the census scored the
prohibitions `∅` — "unguarded absence": nothing converted conversations into
Memories because nothing converted anything at all. An absence is not a
guarantee. A guarantee is an artifact that REFUSES the violation, so both are
now refusals with a test each.

The positive half of §10 was also genuinely broken rather than merely missing.
T119 said a user "may explicitly save a message … as a private Memory draft",
and the app had a Save button that wrote a `saved_messages` row **nothing ever
read**, in a table that is not `memories`. It was a button that did nothing, not
a draft.

Server
  services/telegraph/memoryNotes.ts  §10.1's `MemoryNoteShare` field for field,
                                     the graph-leak refusal, the draft row, and
                                     §10.3's recap derivation.
  routes/telegraphMemory.ts          POST /me/memory-drafts and
                                     GET /threads/:id/recap. Mounted.

**§10.1's prohibition, as a refusal.** `MEMORY_GRAPH_FIELDS` is the list of
names a canonical Memory graph would travel under — `memoryId`, `memoryIds`,
`memoryGraph`, `collectionId`, `ownerMemories` and their snake_case twins — and
`assertNoMemoryGraphLeak` REFUSES a payload carrying any of them. It does not
strip them. Stripping would make the sender believe the field was sent; refusing
tells them it cannot be. The `MemoryNoteShare` type has no field that could hold
one, so the check is a second line, not the only one.

**§10.2's prohibition, as a refusal.** The draft route's body schema takes
`messageId` — singular — and before the schema even runs, a body carrying
`threadId`, `messageIds`, `conversationId` or `all` is refused **by name**, with
§10.2 quoted in the message. The absence of a bulk path is therefore visible to
a caller, not only to a reader of the code. The client module matches: it
exports `saveMessageAsMemoryDraft(messageId)` and no list or thread form for a
screen to reach for.

**A draft that is actually a draft.** `memoryDraftRow` writes
`visibility: "only_me"` and `state: "draft"` as LITERALS, not as defaults a
caller can override, into `memories` — the canonical table — so the draft is
readable back by its owner through the route that already exists
(`routes/memories.ts:2995#state` applies `state = published` only when the viewer is
NOT the owner). The save is also recorded in `saved_messages`, so the old
affordance and the new draft agree instead of disagreeing.

**Re-authorization at promotion.** A save is not a permanent grant. The message
is re-read at promotion time and refused when the caller is no longer an active
member of the thread, when the message is deleted, or when it falls outside the
caller's §14.3 window — the same three rules the saved-messages read applies.

**§10.3, and the sentence that is the design.** "It is an invitation to curate,
not automatic historical truth" is enforced three ways, not asserted once:

- The recap's window is **the plan's own start/end**, not "the last few hours of
  chat". A sliding window would assert a session nobody agreed happened, which
  is exactly the automatic historical truth §10.3 refuses. A thread with no
  COMPLETED plan gets `reason: "no_completed_plan"` and **no recap at all**.
- "People" are the plan's **confirmed participants**, not everyone who typed.
- The endpoint says `wrote: "nothing"` in its own payload, and the sheet renders
  it. The four curate actions are OFFERS; `DONE` is a full-weight button, not a
  dismissal X, because declining to curate is one of the four outcomes.

Client
  features/telegraph/memory/   the recap sheet, the single-message save action,
                              and the availability hook that decides whether the
                              recap affordance appears at all.

The recap entry point is gated on the server's answer. §9's coordination panel
is gone by COMPLETE (COMPLETE is not a coordinating state), so the recap needed
its own affordance — and a button that is always there would itself be the app
asserting a night nobody confirmed. `useThreadRecap` performs the §10.3 READ and
the header button appears only when a completed plan came back.

### 10.18 §10 row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T117 | N | **C** | **`MemoryNoteShare` contract** — the type carries §10.1's eight fields and nothing else (`services/telegraph/memoryNotes.ts:46#export interface MemoryNoteShare`), validated by a schema (`services/telegraph/memoryNotes.ts:57#MemoryNoteShareSchema`) that the MEMORY_NOTE kind already routes through (T54). |
| T118 | N `∅` | **C** | **Shareable without exposing the sender's canonical private Memory graph** — no longer an unguarded absence. `MEMORY_GRAPH_FIELDS` names every way a graph reference would travel (`services/telegraph/memoryNotes.ts:76#MEMORY_GRAPH_FIELDS`) and `assertNoMemoryGraphLeak` REFUSES rather than strips (`services/telegraph/memoryNotes.ts:90#assertNoMemoryGraphLeak`), with `parseMemoryNoteShare` checking the leak BEFORE the schema (`services/telegraph/memoryNotes.ts:105#parseMemoryNoteShare`). |
| T119 | W | **C** | **Explicitly save a message, voice note, place share or media item as a private Memory draft** — the hole is closed. `memoryDraftRow` writes `visibility: "only_me"` and `state: "draft"` as literals into `memories` (`services/telegraph/memoryNotes.ts:144#export function memoryDraftRow`), `POST /me/memory-drafts` re-authorizes and inserts exactly one row (`routes/telegraphMemory.ts:62#/me/memory-drafts`), the owner reads it back through the route that already existed (`routes/memories.ts:2995#state", "published`), and the client action is one press per item, on the long-press sheet (`travel-buddy-standalone/app/messages/[id].tsx:253#draftSavedMessage(r.data.draft)`) — see §10.29, which deleted the unmounted component this row first cited. |
| T120 | N `∅` | **C** | **Telegraph never automatically converts whole conversations into Memories** — now a refusal, not a vacancy. A body naming a thread or a list is rejected by name with §10.2 quoted (`routes/telegraphMemory.ts:71#for (const forbidden of`), the accepted key is singular, and the client API exports no list or thread form (`travel-buddy-standalone/src/features/telegraph/memory/memoryApi.ts:104#export async function saveMessageAsMemoryDraft`). |
| T121 | N | **C** | **End-of-night recap surface** — `GET /threads/:id/recap` (`routes/telegraphMemory.ts:178#/threads/:threadId/recap`) over `buildRecap` (`services/telegraph/memoryNotes.ts:242#export function buildRecap`), rendered with §10.3's four actions and its headline (`travel-buddy-standalone/src/features/telegraph/memory/RecapSheet.tsx:46#export function RecapSheet`), reachable from the thread header (`travel-buddy-standalone/app/messages/[id].tsx:1947#telegraph-open-recap`). |
| T122 | N `∅` | **C** | **Derived from confirmed session context — an invitation to curate, not automatic historical truth** — the window is the plan's own and a thread with no completed plan gets none (`routes/telegraphMemory.ts:238#no_completed_plan`), people are the plan's confirmed participants (`services/telegraph/memoryNotes.ts:242#export function buildRecap`), and the endpoint states that it created nothing (`routes/telegraphMemory.ts:291#wrote: "nothing"`). |
| T7 | W | **C** | **Pillar Remember — completed outcomes explicitly become Memories or recaps without ingesting whole private chats** — the prohibition half already held; the positive half now does too. An explicit save produces a real private `memories` draft (T119) and a completed plan produces a recap (T121), while the whole-conversation path is refused by name (T120). |
| T108 | N | **W** | **Complete UI: closeout, media grouping, explicit Memory/recap options** — two of three. Media grouping is the MEDIA_ALBUM kind (`services/telegraph/messageKinds.ts:184#MEDIA_ALBUM`) and the explicit Memory/recap options exist (T119, T121). There is still **no closeout surface**: at COMPLETE the coordination panel simply disappears rather than becoming one. |

### 10.19 The §10 tests, and how each was shown red

`artifacts/api-server/src/test/telegraphMemory.test.ts` — 24 tests, green.
Four mutations, each reverted, each measured:

| mutation | result |
| --- | --- |
| `assertNoMemoryGraphLeak` returning ok for everything | pass 22 / fail 2 |
| the forbidden-key loop removed from the draft route | pass 23 / fail 1 |
| `memoryDraftRow` writing `state: "published"` | pass 22 / fail 2 |
| `buildRecap` dropping the plan-window filter | pass 22 / fail 2 |

`travel-buddy-standalone/.../recapSheet.component.test.tsx` — 10 tests, green.

| mutation | result |
| --- | --- |
| `RECAP_CURATE_ACTIONS` trimmed to two | 1 failed / 9 passed |
| the no-plan branch disabled AND an empty recap rendered in its place | 1 failed / 9 passed |

`travel-buddy-standalone/.../saveToMemory.component.test.tsx` — 8 tests, green.

| mutation | result |
| --- | --- |
| the "private" label hard-coded instead of read back from the response | 1 failed / 7 passed |
| a `useEffect` added that saves on mount | 5 failed / 3 passed |

The last number is the one worth keeping: an automatic conversion is not a
subtle regression in that file, it breaks five of eight. The two recap
mutations each had to defeat two guards to land and still cost only one test
apiece — that redundancy is real and is recorded in each test header rather
than rounded up.

One test deliberately does NOT go through the component's injected seam: "the
request the real module builds carries ONE messageId and no thread" calls the
exported `saveMessageAsMemoryDraft` with `fetch` stubbed and asserts the wire
body is exactly `{"messageId":"m1"}`. An earlier version of that test asserted
the function's `.length` was 1; it was wrong (TypeScript optional parameters
still count toward arity) and, more importantly, it asserted a sentence about
the function instead of what the function sends.

### 10.20 The §10 ceiling

No migration. Every §10 row lands on `memories` and `messages` as they already
exist, which is why six rows reach C rather than being capped at W.

What is NOT claimed:

- **The recap's three other curate actions dead-end.** `CREATE_MEMORY`,
  `SHARE_PHOTOS` and `FOLLOW_PEOPLE_YOU_MET` are offered because §10.3 names
  them, and pressing one says plainly that nothing was saved and why. Building a
  Memory from a whole night needs a curation screen this lane did not build; a
  button that silently did nothing would be a quieter lie than the one that
  says so.
- **T108 is W, not C.** There is no closeout surface.
- **VOICE is still not a message kind.** §10.2 names "voice note" among the
  saveable things; a voice message cannot exist on this tree, because
  `messages.media_type` carries `CHECK (media_type IN ('image','video'))` and
  widening it is a migration no database has. The draft route classifies a
  `voice` message if one ever arrives, which is preparation, not the feature.
- **The rail still has no Memories resolver** (T4 stays W). §10 gave Telegraph
  Memory Notes and drafts; it did not give the Shared Context Rail a
  `resolveSharedMemories`.
- **T268 (§20) is not moved here.** Its four parts are now all built — safe
  share derivatives, Memory Notes, explicit Save, recap — but §20 belongs to
  another lane in this worktree and a row is moved by its owner, not by whoever
  happens to make it true.
- **Branch, not deployment.** Nothing in §10 is merged, deployed, or reachable
  by any traveler.

**One guard is red on this branch, and the Telegraph mounts caused it.**
`docs/architecture/sensing-surface-inventory.md`, line 285, cites six ABSOLUTE
line numbers in `artifacts/api-server/src/routes/index.ts` whose anchor is the
generic string `router` + `.use`. Mounting `telegraphMemoryRouter` (and, later,
`telegraphLifecycleRouter`) added two lines apiece near the top of that file and
shifted every mount below, so the first cited line is now a comment and
`pnpm -s check:doc-citations` reports a broken anchor. The citation survived the
four earlier Telegraph mounts only because an eight-line shift happened to land
on other mount lines; it is brittle by construction, and any insertion above it
will break it again — including the Sensing lane's own next edit. The fix is
mechanical: the cited numbers 295, 297, 298, 299, 302 and 304 should become 299,
301, 302, 303, 306 and 308. It is NOT applied here, because that file belongs to
the Sensing lane and a line, like a row, is corrected by its owner.

Measured, not assumed, and worth stating exactly because it is an accusation
against my own commits: with `routes/index.ts` temporarily restored to its
content at this branch's base `014a25d56`, `check:doc-citations` reported that
anchor as RESOLVING, and reported five broken anchors instead — all five being
this census's own citations of the Telegraph mounts, which at that moment did
not exist. Putting the file back made the failure move from the Sensing document
to mine. That is what identifies the cause.

**This also fails a test, not only a guard.** `src/test/docCitations.test.ts`
("the real corpus — every covered citation resolves and every anchor holds")
runs the same check, so the api-server suite cannot reach fail=0 while this
stands. The one-line fix above is the whole of it.

### 10.21 §7 — the unsend window that did not exist, and receipts derived rather than stored

§7.4 is one of the few places in this spec where the census found a REPLACEMENT
rather than an absence. T75 said "a sender may unsend only while no eligible
recipient has seen the message"; what existed was
`DELETE /api/messages/:messageId` — sender-only, unconditional, at any time,
with no seen predicate anywhere near it. A rule was not missing so much as
contradicted.

Server
  services/telegraph/unsend.ts     §7.3's derived receipt, §7.4's decision, and
                                   the race detector — all pure.
  routes/telegraphLifecycle.ts     GET /threads/:id/receipts and
                                   POST /threads/:id/messages/:id/unsend.
                                   Mounted.

**§7.4's algorithm, translated honestly.** The spec is written against a schema
this tree does not have:

    assert maxRecipientSeenSequence < message.sequence
    set lifecycle = UNSENT

There is no `sequence` column and no `lifecycle` column on `public.messages`.
What exists is `message_thread_members.last_read_at` and `messages.created_at`,
so the assertion becomes `max(other active members' last_read_at) <
message.created_at` — the same RULE, ordered by time instead of by sequence, and
needing no migration. That is why the permission half of §7.4 can be true on
every deployment of this tree.

**One recipient closes it for everyone.** The refusal is `seenBy > 0`, not "all
recipients have seen it". The inverted version — the one a hurried
implementation writes — is the mutation that took this test red, and it is
exactly the case §7.4's second sentence exists to close.

**A departed member cannot freeze the window shut.** `eligibleRecipients`
excludes members who have left, so a stale `last_read_at` belonging to someone
who is no longer in the conversation does not permanently forbid an unsend.

**An unreadable receipt state fails CLOSED.** It is never read as "nobody has
seen it". That branch is worth naming because its first test did not actually
exercise it — see §10.23.

**The race is compensated, not locked, and is described as the weaker thing.**
§7.4 asks for the read-vs-unsend race to be resolved transactionally. PostgREST
offers no cross-table transaction and no `SELECT … FOR UPDATE`; a lock needs a
SECURITY DEFINER function and therefore a migration no database has. So the
route re-reads the receipts after the write and, if a read landed inside the
window, PUTS THE MESSAGE BACK — body verbatim — and tells the sender it could
not be unsent. The outcome is right. The window is real: a recipient fetching
inside it saw a tombstone. And when the compensation itself fails, the sender is
told that too, because silence would be the worst of the three outcomes.

**This is not the delete, and does not replace it.** A DELETE works after the
message has been seen and leaves a redacted slot; §7.4's UNSEND only works
before. Deleting a seen message is a capability travellers have today and §7.4
does not ask for it to be removed, so it was not removed. The census records the
distinction instead of claiming the delete was "fixed".

**§7.3's receipts are derived per request** from the one row per member per
thread that already exists — T74's forbidden shape is still structurally absent,
and the endpoint says so in its own response (`receiptStorage`). DELIVERED is
returned as `null` with a reason on every receipt, because this deployment has
no delivery signal of any kind: reporting `false` would assert a negative nobody
measured.

Client
  features/telegraph/lifecycle/   the receipt line under a sent message, and the
                                  Unsend affordance that disappears once it has
                                  been seen.

Both §7.4's unsend and §10.2's save-to-Memory are now reachable from the
long-press sheet in `app/messages/[id].tsx`, which previously offered only
Reply, Copy, Save message, Report and "Delete for me". §10's draft path had been
built in the previous section and mounted nowhere; it is mounted now.

### 10.22 §7 row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T75 | N | **C** | **A sender may unsend only while no eligible recipient has seen the message** — `planUnsend` refuses with `seen_by_recipient` (`services/telegraph/unsend.ts:174#export function planUnsend`) over the translated assertion (`services/telegraph/unsend.ts:123#export function seenByRecipients`), enforced by `POST /threads/:id/messages/:id/unsend` (`routes/telegraphLifecycle.ts:194#messages/:messageId/unsend`), and offered on the client only while unseen (`travel-buddy-standalone/src/features/telegraph/lifecycle/lifecycleApi.ts:201#export function canOfferUnsend`). |
| T76 | N | **C** | **In a group, one recipient seeing the message closes the window for everyone** — the refusal is `seen.length > 0`, not "all recipients", and a departed member's stale read is excluded (`services/telegraph/unsend.ts:108#export function eligibleRecipients`). The inverted form is the mutation that took the test red. |
| T77 | N | **W** | **The server resolves read-vs-unsend races transactionally** — it does not. The race is detected and COMPENSATED: the receipts are re-read after the write and the message is restored body-and-all when a read landed inside the window (`routes/telegraphLifecycle.ts:339#detectReadRace`, `services/telegraph/unsend.ts:227#export function detectReadRace`). The outcome is correct; the window is real, and a recipient fetching inside it saw a tombstone. A lock needs a SECURITY DEFINER function, i.e. a migration no database has — **this row cannot exceed W on this tree**. |
| T73 | N | **W** | **Direct: Sent/Delivered/Seen. Groups: "Seen by N"** — two of three for direct and the group shape in full. `receiptFor` derives the status and count (`services/telegraph/unsend.ts:139#export function receiptFor`), `GET /threads/:id/receipts` serves it (`routes/telegraphLifecycle.ts:111#/threads/:threadId/receipts`), and the client renders "Sent" / "Seen" / "Seen by N" (`travel-buddy-standalone/src/features/telegraph/lifecycle/lifecycleApi.ts:124#export function receiptLabel`). **DELIVERED is still absent** — nothing on this deployment produces a delivery signal, so every receipt returns `delivered: null` with the reason attached (`services/telegraph/unsend.ts:95#export const DELIVERED_UNAVAILABLE`) rather than a measured false. |

### 10.23 The §7 tests, and how each was shown red

`artifacts/api-server/src/test/telegraphLifecycle.test.ts` — 32 tests, green.

| mutation | result |
| --- | --- |
| `planUnsend` refusing only when ALL recipients have seen it | pass 29 / fail 2 |
| `eligibleRecipients` no longer excluding departed members | pass 30 / fail 1 |
| the fail-closed receipt branch replaced with an empty member list | pass 31 / fail 1 |
| `detectReadRace` returning `[]` always | pass 28 / fail 4 |

`travel-buddy-standalone/.../messageReceipt.component.test.tsx` — 11 tests, green.

| mutation | result |
| --- | --- |
| `canOfferUnsend` true whenever a receipt exists | 1 failed / 10 passed |
| `receiptLabel` collapsed to one "Seen by N" shape | 2 failed / 9 passed |
| the no-receipt guard replaced with a synthesised "assume Sent" | 1 failed / 10 passed |

**The third server mutation is the one worth reading, because it first stayed
GREEN.** The fail-closed test injected a failure on the whole
`message_thread_members` table — but the MEMBERSHIP GATE reads that table first,
so the request was refused before the receipt read was ever reached. The test
was asserting a status code produced by a different guard entirely, and would
have gone on passing while the branch it named failed open. The fake now has
`failMemberReadsAfterGate`, which fails the receipt read and only the receipt
read, and a separate test covers the gate's own failure. This is precisely what
"a green run proves nothing until you have seen it go red" is for: the mutation
did not find a bug in the implementation, it found a test that was not testing
anything.

A second methodological correction sits in the same file. The fake supabase
client returned the stored row objects themselves, so the "before" receipt
snapshot mutated under the route's feet and the compensation test passed
vacuously. PostgREST returns fresh JSON on every read; the fake now copies, and
the route snapshots the before-set eagerly so the comparison does not depend on
a client's aliasing behaviour at all.

### 10.24 The §7 ceiling

No migration. The permission rule lands on `last_read_at` and `created_at` as
they already exist.

What is NOT claimed:

- **T77 is W and cannot be better on this tree.** Compensation is not a
  transaction.
- **There is no UNSENT lifecycle state** (T69 stays W). An unsent message is a
  tombstone — `deleted_at` set, `body` blanked — indistinguishable in storage
  from a deleted one, because no column can hold the distinction.
- **"Remove from normal retrieval, search and projections" is not achieved**
  (T79 stays W). The existing readers render a deleted row as a redacted slot,
  so an unsend leaves a visible gap rather than nothing. Changing that is a
  change to every reader in `routes/messaging.ts`, and the media-field half of
  T79 is already the subject of unmerged PR #472.
- **DELIVERED does not exist** (T72 stays W). No per-device acknowledgement, no
  `lastDeliveredSequence`. Every receipt says so rather than guessing.
- **Seen is still thread-level and still client-asserted** (T70, T71). This
  section derives per-message receipts FROM the thread-level timestamp; it does
  not give the server a way to verify that a client only marks read on a
  foreground render.
- **The unconditional delete is untouched.** A sender can still delete a seen
  message and leave a slot. That is a different operation with a different
  promise, not a bypass of §7.4 — but a reader who disagrees with that reading
  should score T75 W, and the distinction is stated here so the judgement is
  available rather than buried.
- **Branch, not deployment.**

### 10.25 §2.2 — the header axis that was a constant

T9 asks for "user/crew name · availability · safe presence". The server half
landed in §10.1 (`GET /threads/:id/conversation-header` serves both, each behind
its own consent path) and nothing consumed it. What the header rendered instead
was this:

    const directSubtitle = dmProfile?.city
      ? `${dmProfile.city} · Active recently`
      : 'Active recently';

`'Active recently'` was a CONSTANT. It appeared for a person last seen a year
ago exactly as for one typing at that moment, and nothing anywhere measured it.
That is worth naming precisely because it is the cheapest possible way to break
§4's hard rule — "AVAILABLE ≠ ONLINE ≠ NEARBY ≠ SHARING LOCATION. Never collapse
these states into one permission" — since it asserted one of those states for
everybody, for free, with no permission at all.

Client
  features/telegraph/header/   the two consent-gated axes, and the rule that an
                               axis with nothing to say says NOTHING.

The rule is the whole design. `headerSubtitle` returns `null` — not an empty
string, not an em dash, not a fallback — when neither axis speaks, and the
screen renders the name alone. Three consequences, each tested:

- **A withheld read and an empty one look identical.** A failed fetch, a
  participant behind `open_to_plans_windows_enabled` (seeded OFF), and a person
  who genuinely has no availability all produce the same header. Distinguishing
  them would leak that someone HAS presence the viewer may not see.
- **"Not open to plans" is an answer, not a label.** A person who is not open is
  simply not described.
- **Stale presence is not presence.** `circle_presence.is_stale` exists because
  the row outlives the knowledge; rendering a stale venue as current is how
  "safe presence" becomes a location claim nobody made.

The city stays, because a city is a measured fact. What was removed was the
presence claim attached to it.

The header reads ONCE per thread open and does not poll. §4.3 forbids repeated
refreshes becoming a movement-tracking side channel and safe presence carries a
coarse venue label, so a polling header would turn opening a chat into a
movement trace. That is a client-side property, not a guarantee — the server has
no refresh budget — which is why T26 stays N `∅` rather than being claimed here.

### 10.26 §2.2 row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T9 | W | **C** | **Conversation header: user/crew name · availability · safe presence** — all three. The server serves the two consent-gated axes (§10.1), `useConversationHeader` reads them once (`travel-buddy-standalone/src/features/telegraph/header/useConversationHeader.ts:32#export function useConversationHeader`), `headerAxes` renders only what has something to say (`travel-buddy-standalone/src/features/telegraph/header/headerAxes.ts:73#export function headerAxes`), and the screen consumes it in place of the hard-coded `'Active recently'` (`travel-buddy-standalone/app/messages/[id].tsx:1831#headerSubtitle(telegraphHeader.other`). |

### 10.27 The §2.2 test, and how it was shown red

`travel-buddy-standalone/.../headerAxes.component.test.ts` — 13 tests, green.

| mutation | result |
| --- | --- |
| `headerSubtitle` falling back to `'Active recently'` — the deleted line, put back | 5 failed / 8 passed |
| the `!p.stale` guard dropped | 2 failed / 11 passed |

The first mutation is the regression this change exists to prevent, restored
verbatim, and it costs five of thirteen. That is the number worth keeping: a
fabricated presence claim is not a subtle regression in this file.

### 10.28 The §2.2 ceiling

- **Availability is dark on every deployment.** `open_to_plans_windows_enabled`
  is seeded OFF, so the availability axis renders nothing on this tree no matter
  what a window says. T9 is C because the header correctly shows the axis when
  the server discloses it and correctly shows nothing when it does not — but a
  traveller on a deployment as it stands today will see safe presence at most.
- **Safe presence only exists inside a trip context.** The header's presence
  axis is served only where `canViewCirclePresenceBatch` allows it and the
  thread has a canonical trip; a direct conversation with no shared trip shows
  the name and the city.
- **T8 is untouched.** The inbox still has no status, NOW or UPCOMING band.
- **T26 is not claimed.** Reading once is a client habit, not a server budget.
- **Branch, not deployment.**

### 10.29 Two corrections to my own work, and a second fabricated claim

**Correction 1 — I built two components and mounted neither.**
`SaveToMemoryAction.tsx` (§10.2) and the §7 receipt row were written, tested and
reachable from nothing. That is the exact failure this census keeps finding —
§6.4's drawer entry point behind a literal `false`, the Save button writing into
a table nobody reads — and writing it myself in the same worktree does not make
it different. Both are resolved, in opposite directions:

- `SaveToMemoryAction.tsx` is **deleted**. The real save belongs on the
  long-press action sheet beside the "Save message" row it sits next to, and
  that is where it now is. The one decision the component carried — describing
  the draft from what the SERVER returned rather than from what §10.2 promises —
  moved into `draftSavedMessage`, a pure function with one real call site and a
  test of its own.
- The receipt derivation is **mounted**, and mounting it exposed the second
  fabrication.

**Correction 2 — "Delivered" was a three-second timer.** Both chat surfaces
computed the per-message receipt inline, and both asserted a state this tree
cannot produce:

    const ageSecs = (Date.now() - new Date(msg.createdAt).getTime()) / 1000;
    return ageSecs > 3 ? 'delivered' : 'sent';

A double tick reading **Delivered** appeared because three seconds had elapsed.
The direct-chat branch was the same mistake in a subtler form — it returned
`'delivered'` whenever the other party's `last_read_at` was merely older than the
message. §7.1 names a DELIVERED state and this deployment has no delivery signal
of any kind: no per-device acknowledgement, no `lastDeliveredSequence`. That is
why `GET /threads/:id/receipts` returns `delivered: null` with a reason. Meanwhile
the app was showing it as true, on a timer, to the sender.

This is the same defect as §10.25's `'Active recently'`, in a different place and
with the same shape: a UI state presented as measured that nothing measures. It
was found by mounting the honest version next to it, which is an argument for
mounting things.

`deriveReceiptState` now has no `'delivered'` branch at all — the outcome set is
exactly `{sent, read}` and a test asserts that set rather than each case — and
both screens call it, so there is one writer of the rule. `deriveSeenBy` supplies
§7.3's "Seen by N" for groups, returning **null** rather than 0 so a receipt
never reports an absence.

### 10.30 Row moves for the correction

| id | was | now | why |
| --- | --- | --- | --- |
| T73 | W | **W** | **Direct: Sent/Delivered/Seen. Groups: "Seen by N"** — unchanged verdict, corrected evidence. §10.22 cited a label function; the derivation is now MOUNTED on both chat surfaces (`travel-buddy-standalone/src/features/telegraph/lifecycle/lifecycleApi.ts:159#export function deriveReceiptState`, used at `travel-buddy-standalone/app/messages/[id].tsx:1624#deriveReceiptState` and `travel-buddy-standalone/src/components/GroupChatScreen.tsx:579#deriveReceiptState`), with "Seen by N" derived for groups (`travel-buddy-standalone/src/features/telegraph/lifecycle/lifecycleApi.ts:184#export function deriveSeenBy`). Still W, and now for a cleaner reason: two of three, because **DELIVERED cannot be reported and is no longer claimed**. |

**T69 is re-derived and stays W, but its evidence changes.** The census said
"Two of six states … no DELIVERED concept anywhere". That was true of the
server and false of the client, which rendered one. The lifecycle is still two
of six; the difference is that the app no longer asserts a third.

No other row moves. This section exists because the work needed correcting, not
because it advanced anything.

### 10.31 The correction's tests

`travel-buddy-standalone/.../messageReceipt.component.test.ts` — 17 tests,
green. (It was 11, then 18 as a `.tsx` that rendered a component; §10.32 below
deleted that component, and the file is now 17 tests of the logic the app runs.)

| mutation | result |
| --- | --- |
| `deriveReceiptState` restored to the fabricated rule verbatim | 4 failed / 13 passed |
| `canOfferUnsend` true whenever a receipt exists | 1 failed / 16 passed |
| `receiptLabel` collapsed to a single "Seen by N" shape | 2 failed / 15 passed |

`travel-buddy-standalone/.../saveToMemory.component.test.ts` — 6 tests, green.
It no longer renders a component, because the component it rendered no longer
exists; it asserts the two things that survived the deletion.

| mutation | result |
| --- | --- |
| `draftSavedMessage` hard-coded to the private sentence | 2 failed / 4 passed |
| `saveMessageAsMemoryDraft` also spreading `messageIds: [messageId]` | 2 failed / 4 passed |

The first mutation in each table is the deleted defect, put back verbatim. That
is the most useful form a mutation can take: it measures whether the test would
have caught the thing that was actually wrong.

### 10.32 The same mistake once more, and what it exposed

§10.29 said I had built two components and mounted neither, and fixed one by
deleting it and one by mounting the logic. That was half a fix. A sweep for
`<Component` across `src` and `app` found `MessageReceiptRow` still mounted
nowhere — both chat screens already render their own receipt line, and the
unsend lives on the long-press sheet — so the component duplicated two surfaces
that existed.

**And the unused component was hiding a real gap.** The two functions it existed
to exercise, `receiptLabel` and `canOfferUnsend`, were called by NOTHING but the
component and its test. So §7.4's affordance rule was not applied anywhere in the
app: the long-press sheet offered **Unsend on every one of the sender's own
messages** and let the server refuse. §10.22's T75 row cited `canOfferUnsend` as
"offered on the client only while unseen" — which was true of the function and
false of the app. That is exactly the kind of claim this census exists to catch,
and it was mine.

Both are now resolved the way the row already claimed:

- `MessageReceiptRow.tsx` is **deleted**.
- `canOfferUnsend` and `receiptLabel` are **wired into the long-press sheet**.
  The Unsend row appears only while nobody has seen the message; once someone
  has, the row is replaced by a disabled line reading "`Seen by N` — too late to
  unsend", so the sender learns the rule rather than meeting it as a refusal.
  The server still checks, and still decides.
- `fetchReceipts` is **deleted** from the client. `GET /threads/:id/receipts`
  exists, is tested, and carries two API-level guarantees (the §14.3 window, and
  that a caller only learns who read their own messages) — but no screen calls
  it, because both surfaces already hold every member's `last_read_at` to render
  reader-avatar chips. An unused API client function is the same dead weight as
  an unmounted component, so it is not kept "in case", and the module says so
  where it used to be.

**A sweep, not a hunch.** The check that found this is mechanical — for every
`.tsx` under `features/telegraph/`, grep for `<Name` outside its own file and its
tests — and every component now resolves to a screen. The same sweep over
exported functions is what found `fetchReceipts`.

### 10.33 Row moves for the second correction

| id | was | now | why |
| --- | --- | --- | --- |
| T75 | C | **C** | **A sender may unsend only while no eligible recipient has seen the message** — verdict unchanged, and now the client half of §10.22's evidence is true. `canOfferUnsend` (`travel-buddy-standalone/src/features/telegraph/lifecycle/lifecycleApi.ts:201#export function canOfferUnsend`) gates the long-press Unsend row (`travel-buddy-standalone/app/messages/[id].tsx:270#canOfferUnsend(receipt)`); until this section it gated nothing, and the sheet offered Unsend on every own message. The row was C on the server's enforcement, which was and is real — but the sentence about the client was wrong and is corrected here rather than left standing. |

No verdict changes. Both entries in §10.29–§10.33 are corrections to this
worktree's own work.

### 10.34 A fail-open in the branch whose job was to fail closed

Re-reading §7.4's compensation path found this:

    const after = await readMembers(client, threadId);
    if (after.ok) {
      const raced = detectReadRace(…);
      …
    }

When the post-write receipt read FAILED, the race check was skipped and the
unsend was reported as a success. That made the one branch whose entire purpose
is to catch a §7.4 violation the one branch that assumed there had not been one
— and it sat two functions away from a `before` read that fails closed
explicitly, and in the same file as a test named "an unreadable receipt state
FAILS CLOSED, never as 'nobody saw it'". The rule was stated, tested on one
read, and inverted on the other.

It is fixed the way the rest of the file already worked. Putting the message
back is **always safe** — it returns the conversation to the state it was in a
moment ago — so both reasons to compensate are now handled identically: a race
that was DETECTED, and a race that COULD NOT BE RULED OUT.

Four outcomes, all of them stated to the caller rather than collapsed into a success:

| after-read | restore | response |
| --- | --- | --- |
| ok, race detected | ok | 409 `seen_by_recipient`, `compensated: true` |
| ok, race detected | failed | 200 `unsent: true`, `compensated: false`, and the message says it is gone |
| **failed** | ok | 409 `unverifiable`, `raceDetected: null`, "nothing changed — you can try again" |
| **failed** | failed | 200 `unsent: true`, `raceDetected: null`, "we could not confirm nobody had already seen it" |

`raceDetected` is **null**, never `false`, whenever the read failed. `false`
would assert a negative nobody measured — the same distinction §7.3 draws for
DELIVERED, and the same one §10.25 draws for an empty header axis.

**This does not move T77.** T77 is W because compensation is not a transaction,
and it still is not. What changed is that the compensation now covers the case
it was written for.

### 10.35 The fail-open's tests

`artifacts/api-server/src/test/telegraphLifecycle.test.ts` — 34 tests
(32 before), green. Two new: the fail-closed outcome, and the fact that
`raceDetected` is null rather than false when nothing was measured.

| mutation | result |
| --- | --- |
| the post-write read failing OPEN again — `if (after.ok) { …race check… }` | pass 32 / fail 2 |

**The mutation caught a weak assertion in its own new test.** On the first
measurement it was pass 33 / fail 1: the "raceDetected is not false" test kept
passing, because under the fail-open version the field is simply ABSENT and
`undefined !== false`. The test now requires the field to be PRESENT and null —
the response has to SAY that it could not look — and the mutation costs two
tests instead of one. Both numbers are recorded because the difference between
them is the entire value of running the mutation: the first number was the test
agreeing with itself.

Headline after §10 in this worktree (last statement wins): C=158 W=165 N=110 X=0
— `pnpm -s check:census-integrity`, which parses 433 of the 451 requirements (18 are counted in prose it cannot read, and the 3 CANNOT-VERIFY rows are among them, which is why it reports X=0 where §1 states 3).

## 11. The conversation kernel: §14's capability model made an object, §21's search made a route

**Read against the branch `worktree-agent-adfca8d798639981f`.** This section is
written by the Telegraph lane that owns §12–§22. It is appended rather than
edited in: §1's headline table is left exactly as the original pass wrote it,
and the worktree tally is stated once at the end of this section, computed by
`pnpm -s check:census-integrity`.

The original pass found §14's capability model absent and §21's search absent —
not weak, absent: *"no capability flag exists"* (T199), *"There is no
conversation search of any kind"* (T272). Both findings were re-read against the
tree before anything was written, and both were still true. What follows is what
was built, where, and what still bounds it.

### 11.1 What was built, and where

**§14.1 — the ten capabilities are now one object, derived from the eight
inputs the spec names.** The spec's type is copied verbatim into
`domain/telegraph/contracts/conversationCapabilities.ts:55#  canSendMessage: boolean;`
and its ten names are a closed list, so a capability that stops being answered
is a failing test rather than a review comment. The eight inputs §14.1 names —
membership, block state, Trip/Crew membership, booking state, age/policy,
location scope, safety state, conversation type — are a closed set at
`domain/telegraph/contracts/conversationCapabilities.ts:83#export const CAPABILITY_INPUTS = [`
and the resolver reads each of them under a labelled heading and records that it
did: `domain/telegraph/policies/conversationCapabilityPolicy.ts:116`,
`:132`, `:152`, `:180`, `:185`, `:198`, `:216`, `:229`. "Derived from the eight
inputs" is therefore a checkable claim — `inputsRead` is asserted against
`CAPABILITY_INPUTS` in
`test/telegraphConversationCapabilities.test.ts` — and not a comment.

Each capability carries the REASON it is false, from one declared vocabulary
(`domain/telegraph/contracts/telegraphReasonCodes.ts`), because the original
pass's complaint was never that the booleans were wrong — it was that eight
different enforcement points each refused differently and none of them said
why. The derivations that can be both true and false read real state:
`canCreatePlan` refuses a trip thread to a non-crew viewer through
`isAcceptedTripMember`, the same helper `routes/telegraphCommands.ts:410` calls
at execution, so the projection cannot disagree with the gate
(`domain/telegraph/policies/conversationCapabilityPolicy.ts:275`);
`canViewPreMembershipHistory` reads the live §14.3 bound through the same
`visibleFromOf` the message reader uses
(`domain/telegraph/policies/conversationCapabilityPolicy.ts:308`), so with
`telegraph_history_bound_enabled` OFF the membership query does not even NAME
`visible_from_at` and a database without migration 2400 is never asked for it;
`canShareExactLocation` names WHICH wall stopped it — no active grant, or a
grant whose precision class is below EXACT
(`domain/telegraph/policies/conversationCapabilityPolicy.ts:282-283`).

**The block is not told.** `TELEGRAPH_AUTH_BLOCKED` is a true reason that would
reveal the block to the person it was made about, so the policy returns it
honestly and the route redacts it on the wire
(`server/telegraph/capabilityRoute.ts:81`), turning it into the
`TELEGRAPH_AUTH_NOT_MEMBER` a stranger already gets. The endpoint answers 200
for every refusal (`server/telegraph/capabilityRoute.ts:91`) for the same
reason: a 403 would make it a thread-existence oracle.

**A degraded capability set is a floor, never an answer.** The resolver marks
`degraded` when any input read failed, and the one route that ENFORCES a
capability refuses retryably on `degraded` even when the boolean came out true
(`server/telegraph/readReceiptsRoute.ts:72`). That branch is not decoration: the
test caught the route granting on a degraded read before it existed.

**§14.1 `canSeeGroupReadReceipts` now has something to gate.**
`message_thread_members.last_read_at` has been written since migration 0016 and
read by exactly one consumer — the caller's own unread count
(`routes/messaging.ts:2148#const lastReadAt: string | null = mem.last_read_at ?? null;`). `GET /threads/:threadId/read-receipts`
(`server/telegraph/readReceiptsRoute.ts:52`) returns every active member's read
position for a group thread, refuses a direct thread because the capability is
false there, and CLAMPS another member's position to the caller's own §14.3
floor rather than omitting it (`server/telegraph/readReceiptsRoute.ts:121#clamped: lastReadAt !== raw`) —
omission would itself be the signal.

**§21 — search exists, is object-aware, and filters access BEFORE retrieval.**
`services/telegraphSearch.ts` computes the authorized conversation set first
(`services/telegraphSearch.ts:101`) and queries only that set; a membership read
that FAILS returns an empty scope and the caller returns an empty degraded
result (`services/telegraphSearch.ts:119`) — there is no path in the file that
reaches `messages` unscoped, and the test proves it by inspecting every filter
the query builder received, not by inspecting the rows that came back. The
§14.3 window is applied IN the query (`services/telegraphSearch.ts:164`) with
bounded threads queried separately, because dropping out-of-window rows in
JavaScript is exactly the post-filtering §21 forbids and silently shrinks a
bounded user's page through `limit`. Deleted rows are excluded in the query
(`services/telegraphSearch.ts:160`), not skipped in the render.

The five buckets are §21's, in §21's order
(`domain/telegraph/contracts/conversationSearch.ts:41`), and the classifier
sends an unrecognised card subtype to MESSAGES rather than to nowhere
(`domain/telegraph/contracts/conversationSearch.ts:137`). "Object titles and
safe metadata" is an ALLOWLIST of field names
(`domain/telegraph/contracts/conversationSearch.ts:80`): a card that gains a
`lat` tomorrow is not indexed by accident, an unparseable card body indexes to
the empty string rather than to raw JSON, and a match that exists only in a
non-allowlisted field is not a hit — because surfacing it would let a searcher
confirm a value they are not allowed to read. Three routes are mounted:
`server/telegraph/searchRoute.ts:47` (global), `:70` (one conversation) and
`:97` — §21's "Ask this conversation", which returns structured plans and
places in a SEPARATE field from prose rather than merely sorting them higher.

### 11.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T199 | W | **C** | §14.1 capability `canCreatePlan` — The capability is modelled and derived server-side, and the operation it names exists. `domain/telegraph/policies/conversationCapabilityPolicy.ts:275` refuses a trip thread to a non-crew viewer through `isAcceptedTripMember` — the same helper `routes/telegraphCommands.ts:410` calls at execution — and grants otherwise. The original row's complaint ("the enforcement is real; the capability is not modelled") is answered without moving the enforcement. |
| T200 | W | **W** | §14.1 capability `canShareExactLocation` — Now modelled and derived from the location-scope input, and it names which wall stopped it (`conversationCapabilityPolicy.ts:282-283`). Holds W for the reason the original row gave and this work confirms: `trip_crew_location_sessions.visibility_level` tops out at `nearby`, which is APPROXIMATE, so the capability is structurally always false. A conversation still cannot grant exact location because no store can express it. |
| T201 | N | **W** | §14.1 capability `canInvite` — Modelled and derived, with the §14.3-grounded reason: a DM answers `TELEGRAPH_POLICY_DM_INVITE_FORMS_NEW_GROUP`, a trip or circle thread answers `TELEGRAPH_POLICY_MEMBERSHIP_DERIVED` (`conversationCapabilityPolicy.ts:288`). W and not C: there is still no add-participant operation on any thread, so the capability is permanently false and `CAPABILITY_ENFORCEMENT_SITES` records `null` for it (`domain/telegraph/contracts/conversationCapabilities.ts:109`). |
| T202 | N | **W** | §14.1 capability `canRequestPayment` — Modelled; §20's prohibition is now stated as a capability rather than left as an absence (`conversationCapabilityPolicy.ts:293`). W for the same reason as T201 — there is no payment request to gate, so the capability cannot be exercised in either direction. |
| T203 | W | **C** | §14.1 capability `canCreateBooking` — Derived from the booking-state and conversation-type inputs: a thread that already owns a booking refuses a second one from inside itself, a group thread refuses because a booking is pairwise, a healthy DM grants (`conversationCapabilityPolicy.ts:297-300`). The Rent-a-Buddy gates remain the enforcement site and are named as such (`conversationCapabilities.ts:111`). |
| T204 | N | **W** | §14.1 capability `canBroadcast` — Modelled and permanently false with `TELEGRAPH_POLICY_NO_BROADCAST` (`conversationCapabilityPolicy.ts:303`). No broadcast primitive exists; the capability now says so instead of being silent. |
| T205 | W | **C** | §14.1 capability `canViewPreMembershipHistory` — Modelled and derived from the LIVE bound, through the same `visibleFromOf` the message reader uses (`conversationCapabilityPolicy.ts:308`). The original row said "not modelled — and the rule it would express is violated"; the violation half was closed on this tree by migration 2400 before this pass (see T211 below), and the model half is closed here. |
| T206 | N | **C** | §14.1 capability `canSeeGroupReadReceipts` — Modelled (`conversationCapabilityPolicy.ts:314-316`) AND given something to gate: `GET /threads/:threadId/read-receipts` (`server/telegraph/readReceiptsRoute.ts:52`) returns per-member read positions for a group thread and refuses a direct one, clamping another member's position to the caller's own §14.3 floor (`:115`). |
| T207 | W | **C** | §14.1 capabilities derived server-side from the named inputs — All eight inputs are read under labelled headings and recorded in `inputsRead` (`conversationCapabilityPolicy.ts:116`, `:132`, `:152`, `:180`, `:185`, `:198`, `:216`, `:229`), and the test asserts the recorded set against the declared one. Nothing is taken from a client: the route derives everything from the verified user id and the service-role reads. |
| T211 | W | **W** | §14.3 new members do not automatically receive pre-membership history — **Re-derived, not re-measured by this pass's work.** The original verdict ("Violated") is STALE: migration `2400_telegraph_history_bound.sql` and `services/groupChatHistoryBound.ts:57` reached this tree in commit `42aeac38e`, and `routes/messaging.ts:1863` now applies the bound in the query. It holds W and not C for the reason the migration's own header gives: the bound is read only while `telegraph_history_bound_enabled` is TRUE, and no database has that flag on. |
| T272 | N | **C** | §21 Telegraph search is object-aware and authorization-scoped — Three routes (`server/telegraph/searchRoute.ts:47`, `:70`, `:97`) over one service that computes the authorized set first (`services/telegraphSearch.ts:101`) and classifies every hit into a bucket (`domain/telegraph/contracts/conversationSearch.ts:137`). No migration, no flag: it reads columns that exist on every deployment. |
| T273 | N | **C** | §21 multi-type results MESSAGES / PLACES / MEDIA / PLANS / MEMORIES — The five buckets in §21's order (`domain/telegraph/contracts/conversationSearch.ts:41`), always all five keys in `counts` so "0 PLACES" is expressible, with the subtype→bucket map read off the repository's actual writers. |
| T274 | N | **W** | §21 index message text, permitted transcripts, object titles and safe metadata — Three of four. Message text, object titles and safe metadata are indexed through an allowlist (`domain/telegraph/contracts/conversationSearch.ts:80`, `:158`). **Transcripts are not**, because there are none — §18.2's voice pipeline does not exist (T243) and `lib/mediaPipeline.ts` admits no audio type. |
| T275 | N `∅` | **C** | §21 private indexes filter access BEFORE retrieval, not after — No longer an unguarded absence. `services/telegraphSearch.ts:101` resolves the authorized scope first and `:119` returns an EMPTY scope on a failed membership read, so a degraded read cannot fall through to an unscoped query; the test asserts zero `messages` queries in that case, and asserts a `thread_id` scope on every query in the healthy case. |
| T277 | N | **C** | §21 "Ask this conversation" prefers structured plans/decisions/actions — `GET /threads/:threadId/ask` (`server/telegraph/searchRoute.ts:97`) returns `structured` and `prose` as separate fields over the same authorized scope, so a caller answers from the structured set and falls back rather than inferring from prose that happened to rank well. |

**Rows looked at that did not move:** T197, T198, T208, T209 (all C already, and
re-read: nothing in this section moves an enforcement point). T210 stays N — the
live bound is a TIMESTAMP (`visible_from_at`), not `visibleFromSequence` /
`visibleUntilSequence`, and no sequence column exists. T212 stays N `∅` — no
add-participant operation exists to guard. T276 stays W — deleted rows are now
excluded in the search query (`services/telegraphSearch.ts:160`), which is
stronger evidence than the original row had, but the `unsent` half has no column
to exclude and revoked source objects still survive inside frozen cards (T46).

### 11.3 The ceiling

**No migration, and that is the point of this batch.** Everything above reads
columns that exist on every deployment, so the rows that moved to C are true on
every deployment of this tree — the standard §3 sets. Three ceilings bound what
is here:

1. **Built on a branch is not merged.** This section is written in the worktree
   `worktree-agent-adfca8d798639981f`. Nothing here is on `main`, nothing is
   deployed, and no C row above should be read as "in production".
2. **`telegraph_history_bound_enabled` is off everywhere.** T205's capability is
   correct and T211's bound is real, and on every live database the bound is
   NULL-equivalent because the flag gating it has never been turned on. T205 is
   C because the CAPABILITY is derived correctly in both flag states (the test
   asserts both); T211 stays W because the RULE it states is only enforced in
   the ON state, which no database is in.
3. **Four capabilities are modelled and permanently false.**
   `canShareExactLocation`, `canInvite`, `canRequestPayment` and `canBroadcast`
   are W, not C, and the reason is recorded in the code itself:
   `CAPABILITY_ENFORCEMENT_SITES` (`domain/telegraph/contracts/conversationCapabilities.ts:104`)
   carries `null` for the three that gate nothing, so a reader can tell a
   modelled capability from a built one without trusting this paragraph.

**P24 — what would turn these green claims red.** (a) Anything that makes the
capability object an authorization GATE rather than a projection: today the send
path, the call routes and the command route each re-derive their own answer, and
if one of them started reading `capabilities.canX` instead, §14.1's last
sentence would be violated from the server side and this section's C rows would
be wrong. (b) A new card subtype whose body puts a coordinate in an
allowlisted field name — the search allowlist is by NAME, not by value, so
`title: "21.0287, 105.8542"` would be indexed; the allowlist stops fields, not
liars. (c) A second membership read added to the search path that does not go
through `authorizedConversationScope` — the "before retrieval" guarantee is a
property of there being exactly one scope resolver, and a second one is how it
would drift. (d) `MAX_BOUNDED_QUERIES` being hit silently: it is reported as
`degraded` today (`services/telegraphSearch.ts:184`), and a change that dropped
that would turn a truncated search into a confident empty one.


---

### 11.4 §18.3's eight accessors, and three §22 controls

The second batch. §18.3 named eight Compass accessors and the tree had two of
them, under other names and on another surface; §22 named seven controls and the
original pass counted one and a half. Both were re-read before anything was
written.

**§18.3 — the eight accessors exist and are offered to the model.**
`compass/TelegraphConversationTools.ts` implements all eight
(`:157`, `:198`, `:235`, `:294`, `:345`, `:388`, `:433`, `:471`) and maps each
to the spec's own name (`compass/TelegraphConversationTools.ts:73#export const TELEGRAPH_TOOL_SPEC_NAMES`). They are
registered into the list the model is handed by one spread
(`compass/CompassTools.ts:248`) and reached through the existing dispatcher by
one branch (`compass/CompassTools.ts:1264`), so this pass adds one import, one
spread and one branch to a file it does not own.

Every one of the eight starts at ONE gate
(`compass/TelegraphConversationTools.ts:124#export async function gateConversation`): active membership read
fail-closed, then the existing `resolvePrivacyVerdict` (not reimplemented), then
the §14 capability set — so a tool cannot offer an action the conversation
refuses. The gate returns a refusal OBJECT rather than throwing, because
`executeCompassTool` turns a throw into "Tool execution failed", which is
indistinguishable from a bug; a refusal that names its reason lets the model say
the true thing. An unreadable membership row refuses as `degraded`, NOT as "not
a participant" — the test asserts that distinction directly, because a failed
check reported as a refusal makes the assistant tell a user something untrue.

What the eight structurally cannot return is tested, not asserted: the place
card in the fixture carries a latitude and a provider id, and `getSharedPlaces`
is proved to return the title and the §21 safe-field summary and neither of
those. Availability goes through `projectPublicWindows`, so the PARTICIPANT's
own visibility policy decides — the fixture gives one member a `private` window
and the test proves it never appears. `createPlanDraft` has no write in it at
all, not a write behind a check, and returns `requiresConfirmation: true` as a
literal (`compass/TelegraphConversationTools.ts:462#requiresConfirmation: true`). `findSafePublicMeetup`
labels its basis `public_staffed_category_only`
(`compass/TelegraphConversationTools.ts:462`) and says in the result that it is
NOT a claim about crime, lighting or opening hours — this repository has no
source for any of those, and a confident answer there is the most dangerous one
available.

**§22 — travel scam signals, all six families, for the RECIPIENT.**
`domain/telegraph/policies/travelScamSignals.ts:48` declares §22's six families
verbatim and `:167` detects them. The design decision worth recording is WHO the
signal is for: the existing off-app detector acts on the SENDER (an admin event,
and a buddy suspension at the threshold), which is the right shape for platform
integrity and the wrong shape for traveller safety, because it helps nobody in
the conversation right now. These signals are computed at read time and attached
only to messages the caller did NOT send (`routes/messaging.ts:2020`). A sender
who could see their own signals would tune their wording against the detector in
an afternoon.

Nothing is blocked. Every pattern has an innocent reading — "can you send me
money, I lost my card" is what a friend in trouble says and is also the most
common travel scam — so the signals annotate and the decision stays with the
person, which is where §16's "scanning must not block basic text delivery"
points as well. The false-positive corpus is the real specification: ten lines
of ordinary traveller talk containing every trigger word (taxi, visa, ticket,
hotel, money, pay) must produce zero signals, and that block goes red before the
positive block does if a pattern is loosened.

**§22 — links.** `domain/telegraph/policies/travelScamSignals.ts:197` is the
reserved-official-identity list and `:275` scans a body for structural link
findings: shortener, punycode, mixed-script, IP literal, credentials-in-URL, and
a LOOKALIKE of a reserved identity (one edit away, or the brand embedded as a
label of someone else's domain). `UNKNOWN_HOST` is returned for everything else
and is deliberately NOT suspicious — most links are to places nobody has heard
of, and warning on all of them trains the warning away.

**§22 — the send step's rate limit.**
`domain/telegraph/policies/sendRateLimit.ts:112` folds §22's five named inputs —
relationship, verification, trust, account age, reports — into four tiers, and
`:240` is the gate the send path now calls (`routes/messaging.ts:2084`), placed
after the membership check so a non-member cannot spend a member's bucket. An
unreadable input falls to the STRICTEST tier, and the module argues the
direction rather than asserting it: strictest here is 20 messages per ten
minutes, a pause and not a block, so failing strict costs a chatty user a moment
during a bad database minute, while failing open would switch the control off
during exactly the minutes an attacker wants it off.

| id | was | now | why |
| --- | --- | --- | --- |
| T244 | W | **C** | §18.3 `getConversationContext()` — `compass/TelegraphConversationTools.ts:157`. Conversation-scoped, not message-scoped: type, participant count, the §14 capability set, which context classes are available, and the kinds of shared objects present. Returns no message prose — the test asserts the fixture's plain message text never appears in the result. |
| T245 | N | **C** | §18.3 `getSharedPlans()` — `compass/TelegraphConversationTools.ts:198`. Meetups attached to the conversation by `chat_thread_id`, cancelled ones excluded, with the place NAME (a `location_name` capped at 300 chars by a CHECK) and never a coordinate. |
| T246 | N | **C** | §18.3 `getParticipantAvailability()` — `compass/TelegraphConversationTools.ts:277#export async function telegraphGetParticipantAvailability`. Through `projectPublicWindows`, so each participant's own visibility policy decides; the viewer relationship handed to it is the most restrictive the conversation justifies and never widens. A participant not sharing simply does not appear, and the result carries the instruction not to speculate why. This is also the first time Telegraph reads availability at all (compare T28). |
| T247 | N | **C** | §18.3 `getSharedPlaces()` — `compass/TelegraphConversationTools.ts:294`. Place cards shared into the conversation, rendered through §21's safe-field allowlist, so a card body's latitude cannot reach the model. |
| T248 | N | **C** | §18.3 `suggestMeetingPoint()` — `compass/TelegraphConversationTools.ts:345`. Drawn from the conversation's shared destination. No midpoint is computed, and the header says why it never will be on this path: a midpoint between two participants is a location inference about both of them from data neither shared with the conversation. |
| T249 | W | **C** | §18.3 `createPlanDraft()` — `compass/TelegraphConversationTools.ts:439#export async function telegraphCreatePlanDraft`, now a Compass tool rather than a route-local intent. It has no write in it, returns `requiresConfirmation: true` (`:411`) and refuses when the conversation's `canCreatePlan` is false. |
| T250 | N | **C** | §18.3 `findSafePublicMeetup()` — `compass/TelegraphConversationTools.ts:433`, with `safetyBasis: "public_staffed_category_only"` (`:462`) and an explicit disclaimer that it is not a claim about crime, lighting or hours. |
| T251 | N | **C** | §18.3 `searchAuthorizedConversationContent()` — `compass/TelegraphConversationTools.ts:471`, delegating to the SAME `searchConversations` service the user-facing §21 route uses. One scope resolver, one set of exclusions: a second search path for Compass is how the two would come to disagree about what a participant may see. |
| T279 | W | **C** | §22 adaptive rate limits — both halves. The send step now has a limit (`routes/messaging.ts:2084`), and it is adaptive to all five named inputs (`domain/telegraph/policies/sendRateLimit.ts:112`): relationship, verification, trust, account age and open reports, with an unreadable input falling to the strictest tier. The request step's existing adaptive machinery is untouched. |
| T281 | N | **W** | §22 links/files — the reserved-identity list and structural link scanning now exist (`domain/telegraph/policies/travelScamSignals.ts:197`, `:275`), including lookalike detection against the official hosts. W and not C for two stated reasons: there is no REPUTATION feed (nothing in this repository can say a host is known-bad, and inventing a verdict of "safe" is the one output here that could get somebody hurt), and there is no file kind to scan at all (T40). |
| T282 | W | **W** | §22 travel scam signals — all six families are detected (`domain/telegraph/policies/travelScamSignals.ts:48`, `:167`) and attached to the recipient's read (`routes/messaging.ts:2020`), against a ten-line false-positive corpus. Holds W for one reason: **no client surface renders `safetySignals` yet**, so a traveller does not see the warning. The server half is complete and the traveller-facing half is not. |

**Rows looked at that did not move:** T252 and T253 stay C and were re-read —
the eight new tools do not weaken either, because they run behind the same
`resolvePrivacyVerdict` T252 cites and because the three prohibitions T253 names
are each asserted directly in the new suite. T280 stays N (stranger media still
autoplays; that is a client control). T283 and T284 stay W/N — an evidence
snapshot needs a table this tree does not have. T278 stays N — `message_requests`
still has no origin column.

**The ceiling for §11.4.** No migration and no flag; every row above reads
columns that exist on every deployment, and the eight tools are offered to the
model on every deployment carrying this branch. Three ceilings: the branch is
not merged; T282's warning reaches no traveller until a client renders it; and
the §22 detectors are PATTERNS, so an attacker who reads this file can write
around them — which is the honest limit of any lexical detector and the reason
the signals annotate rather than block.


---

### 11.5 The traveller sees it: §22's two surfaces, §21's screen, §16.2's data saver

§11.4 left T282 at W for one stated reason — "no client surface renders
`safetySignals` yet, so a traveller does not see the warning" — and T280 at N
because the shield is a client control. This batch is the client half, in
`travel-buddy-standalone/src/features/telegraph/`, the feature layout
`src/features/wall/` and `src/features/trips/` established.

**§22 travel scam signals, on screen.**
`src/features/telegraph/components/MessageSafetyBanner.tsx:87` renders the
server's `safetySignals` under the message it belongs to. The copy names the
pattern and gives one line of advice a person can act on; it does NOT repeat the
matched phrase, because quoting a scammer's own words as a headline reads as the
app endorsing them, and the test asserts the match string never renders. It is
dismissible per message and per mount — an undismissable warning is one people
learn to scroll past, and a persisted dismissal would let one accidental tap
silence a warning somebody would want back on a second read.

**§22 stranger media: covered, not blurred.** `StrangerMediaShield.tsx:57` does
not mount its children until the person taps Show, and the test asserts the
child is absent rather than merely hidden. That is the whole control and the
reason a blur would not be one: a blur has already fetched the bytes and
decoded them, and a video poster frame IS the first frame. The decision is the
server's — `domain/telegraph/policies/senderConnectedness.ts:66` resolves it
once per page over the distinct non-self senders, treats a trip or circle roster
as the acceptance itself (`:75`), and fails CLOSED: if either relationship read
errors, EVERY sender on the page reads unconnected (`:121`), because rescuing a
partial answer from the half that succeeded would shield an arbitrary subset.
The read path attaches it at `routes/messaging.ts:2056`, and the thread renders
it at `app/messages/[id].tsx:1893`.

One ceiling is written into the client type rather than left implicit
(`src/services/messaging.ts` `senderConnected`): an ABSENT field is a server
older than this client and is NOT treated as "stranger", because shielding every
photo in every thread because the server is old would make the control look
broken rather than absent. Only an explicit `false` shields.

**§21 on screen.** `TelegraphSearchScreen.tsx:57` prints §21's five bucket
counts before any result, because "there is one PLAN about sky36" is usually the
answer. It keeps three empty states distinct — "type more", "nothing matched"
and "we could not search everywhere" — and the third is the one that matters: a
degraded search rendered as no-results tells a person their own message does not
exist. It also explains a §14.3 window when one applied, so a member added to a
trip chat last week does not conclude the search is broken. It is reachable from
the inbox: the existing box still filters loaded threads (which is the right
behaviour for "find that thread", and is what T272 measured), and a row appears
at two characters offering the different question
(`src/components/TelegraphInboxScreen.tsx:484`), carrying what was already
typed.

**§16.2 / §17.4 data saver, and the ladder.**
`src/features/telegraph/hooks/useDataSaver.ts:47` is §17.4's order as a list —
ai, typing, reactions, mediaPreview, media, then text and safety — and
`:80` refuses to shed the last two at any level, which is §17.4's actual
sentence expressed as a line of code a future "aggressive" level would have to
delete. Two consumers, chosen to match the ladder's own order: the AI tray is
not rendered and therefore not fetched when `mayLoad('ai')` is false
(`app/messages/[id].tsx:2039`), and media is withheld behind the same cover the
stranger shield uses, with different copy, when `mayLoad('mediaPreview')` is
false (`:1901`). The control a person can reach is
`DataSaverRow.tsx:33`, placed in the thread's own settings sheet
(`src/components/TranslationSettingsSheet.tsx:106`) rather than six taps away —
that sheet is where somebody is when they notice media eating their data.

| id | was | now | why |
| --- | --- | --- | --- |
| T280 | N | **C** | §22 stranger media. `StrangerMediaShield.tsx:57` does not mount the media until the person asks; the server decides who is a stranger (`domain/telegraph/policies/senderConnectedness.ts:66`, fail-closed at `:121`) and the thread renders that decision (`app/messages/[id].tsx:1893`). The original row's "renders and autoplays unconditionally" is no longer true of any path: a shielded video's poster is not rendered either. |
| T282 | W | **C** | §22 travel scam signals, end to end. All six families detected server-side (`domain/telegraph/policies/travelScamSignals.ts:48`, `:167`), attached to the recipient's read (`routes/messaging.ts:2056` area), and now rendered (`MessageSafetyBanner.tsx:87`) with advice and a report action. §11.4 held this at W precisely for the missing client half; that half is here. |
| T227 | N | **C** | §16.2 data saver. A real setting (`useDataSaver.ts:98`), a reachable control (`DataSaverRow.tsx:33` in `TranslationSettingsSheet.tsx:106`), and two consumers that actually withhold — AI (`app/messages/[id].tsx:2039`) and media (`:1901`). Text, status and safety are never shed, by construction (`useDataSaver.ts:80`). |
| T239 | N | **W** | §17.4 low-bandwidth degradation. The LADDER exists and is ordered exactly as §17.4 lists it (`useDataSaver.ts:47`), and text and safety are unshed-able. W and not C for the half the row also names: there is still **no bandwidth SIGNAL**. The ladder is driven by a person's explicit setting, not by a measured connection, so nothing degrades automatically when the network gets bad. |
| T272 | C | **C** | Re-stated, not re-derived: §11.2 moved this on the server routes; the client surface (`TelegraphSearchScreen.tsx:57`, reachable at `TelegraphInboxScreen.tsx:484`) is now built too, so the row is C on both halves rather than on one. |

**Rows looked at that did not move:** T223 stays N — resumable upload is a
transport change, not a surface. T225 stays N — no audio kind exists to generate
a waveform from. T221/T222/T224 stay W — message media still writes
`media_url` onto the row rather than a `MediaAsset`, which is a migration. T258
stays C.

**The ceiling for §11.5.** No migration and no flag. Three things bound it: the
branch is not merged; `senderConnected` is absent on any server older than this
branch and the control is OFF there by design (stated in the client type, not
only here); and T239 needs a bandwidth measurement this repository does not
have — the ladder is ready for one and nothing produces it, which is why the row
is W and not C. P24 — what would turn the green claims red: a media component
that renders a poster or prefetches a URI OUTSIDE the shield (the shield guards
mounting, not fetching done by a sibling); a future data-saver level that sheds
`text` (the never-shed test is the only thing stopping it); and any client that
starts computing `senderConnected` locally, which would move an abuse decision
to the permissive side of a network failure.


---

### 11.6 The message kernel: three events with no schema, and one migration with no database

Two halves that must not be confused with each other, so this section keeps them
apart: three §13.2 events that needed no schema and are therefore BUILT-AND-CORRECT
on every deployment, and a migration that no database has run and whose rows
therefore cannot move past BUILT-BUT-WRONG whatever it contains.

#### The three events (no migration, no flag)

census-telegraph found `message.deleted`, `member.joined` and `safety.reported`
absent from the union AND from every writer. All three are now in the union
(`lib/telegraphEvents.ts:42`, `:52`, `:73`) and all three are published from the
real write paths.

`message.deleted` is published by the delete route
(`routes/groupChat.ts:395`) after the response, excluding the deleter. Before
it, "a delete reaches other clients only on their next poll" — a retracted
message stayed on everyone else's screen for a polling interval. The payload
carries the id and not the body, because the route redacted the body in place;
a consumer wanting the old text is asking for the thing the delete removed.

`member.joined` is published from BOTH sync implementations
(`services/groupChatSync.ts:160` and `:306`; `lib/chatSync.ts:128` and `:258`).
Two, because this tree has two — `routes/messaging.ts` reaches one and
`routes/groupChat.ts` and `routes/friends.ts` reach the other — and an event
that fires on one of two paths teaches a client not to trust it. In both, the
prior roster is read BEFORE the membership write, because after it everyone
looks like a member and the event would announce the whole crew on every sync;
an unreadable prior roster emits NOTHING, because a burst of false "X joined"
lines is worse than a missing one and the next poll shows the truth either way.

`safety.reported` goes to the REPORTER and to nobody else
(`lib/telegraphEvents.ts:717#export function emitSafetyReported`, called at `routes/messaging.ts:3193` and `:3437`).
It is a dedicated emitter rather than a `publishToUsers` call at each handler
for one reason: the audience is the load-bearing part, and a helper with no
parameter that could carry a thread id or a second recipient makes it
impossible to widen by accident. Telling the reported party that a report exists
is the fastest way to get a reporter hurt; telling a group turns a safety action
into a public accusation. The payload carries the target TYPE and never the
target's id.

#### The migration (2810), executed on a throwaway and applied to nothing

`src/migrations/2810_telegraph_message_kernel.sql` adds §12.1's six missing
envelope fields (`:107` onward), §14.3's sequence bounds and §12's
delivered/seen cursors (`:175` onward), the per-conversation sequence assigner
(`:244`), §13.3's transactional outbox (`:193`) and its writer (`:300`), a
partial unique index that makes an offline resend idempotent (`:147`), a
per-conversation backfill an operator calls (`:372`), and the flag, seeded FALSE
(`:420`).

**It was EXECUTED, not read.** On 2026-09-12 against a throwaway PostgreSQL 16
carrying `baseline/20260819_baseline_structure.sql` (388 public tables) plus
`src/migrations/*.sql` from 2093 (209 applied in order, 6 known-unreplayable, 0
unexpected failures): the DDL applies, re-applies cleanly, and the behaviour
holds — flag OFF gives NULL sequences, zero outbox rows and `last_sequence` 0;
flag ON gives 1, 2 in insertion order with `lifecycle_state` 'sent'; a repeated
idempotency key from the same sender is refused by the index while a DIFFERENT
sender may reuse it; unsend and delete each write exactly one outbox row and
keep the row so the sequence stays continuous; a ROLLED-BACK message leaves no
outbox row at all, which is §13.3's actual claim; the outbox payload contains no
`body`; an invented `lifecycle_state` is refused by the CHECK; and the backfill
is deterministic across two runs. The rollback
(`db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql`) was
executed on the same database and verified to remove every 2810 object while
leaving migration 2400's `visible_from_at` intact and all 36 message rows
untouched.

**It is applied to no database**, and it is declared as such in the drift
ratchet rather than waiting to be noticed
(`scripts/checkProductionDrift.ts:328` `telegraph_outbox`). Two reasons, both
recorded there and in the file's own header: nothing drains the outbox, so
turning it on would grow a table nobody empties; and the sequence is only
meaningful after a per-conversation backfill an operator runs deliberately.

The application side is `services/telegraphMessageKernel.ts`, built on exactly
the pattern `groupChatHistoryBound.ts` established: with the flag OFF,
`kernelColumns` (`:69`) returns the caller's original list, `applyLifecycleExclusion`
(`:86`) returns the query untouched, and `messageKernelEnabled` (`:58`) is
false-on-error — so a build carrying this code never NAMES a column a database
without 2810 would answer 42703 for. Its one live consumer today is §21's
search, which gains the UNSENT half of "unsent/deleted/revoked objects must be
removed from normal user search" when the flag is on, in the query.

| id | was | now | why |
| --- | --- | --- | --- |
| T182 | N | **C** | §13.2 `message.deleted`. In the union (`lib/telegraphEvents.ts:42`) and published by the delete route excluding the deleter (`routes/groupChat.ts:395`). No migration, no flag: true on every deployment of this branch. |
| T185 | N | **C** | §13.2 `member.joined`. In the union (`:52`) and published from BOTH sync implementations (`services/groupChatSync.ts:160`, `:306`; `lib/chatSync.ts:128`, `:258`), for newcomers only, from a roster read taken before the write. |
| T194 | N | **C** | §13.2 `safety.reported`. In the union (`:73`) and emitted to the reporter only through a dedicated emitter whose signature cannot carry a second audience (`lib/telegraphEvents.ts:717#export function emitSafetyReported`; called at `routes/messaging.ts:3193`, `:3437`). |
| T154 | N | **W** | §12 `conversation_outbox`. The table exists (`migrations/2810_telegraph_message_kernel.sql:193`), with a dedupe key, an unpublished-first index and RLS enabled with zero policies. W and not C for two reasons stated in the file itself: **no database has run it**, and nothing drains it. |
| T195 | N | **W** | §13.3 "canonical mutation and event-outbox write in the same database transaction". A trigger on `public.messages` (`:300`) gives exactly that, to every writer including the ones that forget — and a rolled-back insert was EXECUTED and proved to leave no event. W because no database has the trigger. |
| T196 | W | **W** | §13.3 idempotent consumers. `telegraph_outbox.dedupe_key` is the handle a consumer needs and is UNIQUE (`:193`). Still W, and now for a sharper reason than before: the key exists on no database, and idempotency is a property of a consumer that does not exist. |
| T228 | N | **W** | §17.1 per-conversation sequence ordering. `messages.sequence` allocated under a row lock from `message_threads.last_sequence` (`:107`, `:244`), proved monotonic per conversation on the harness. W: no database has it, historical rows are NULL until a deliberate backfill, and every shipped reader still orders by `created_at`. |
| T230 | W | **W** | §17.2 offline command fields. Three of four now have columns — `clientMessageId`, `idempotencyKey` and (as `lifecycle_state`) the server side of `syncState`; `createdAtClient` is deliberately still absent because §17.1 says client timestamps are advisory and T229 is C precisely because nothing reads one. W: no database has the columns and no writer populates them. |
| T231 | N | **W** | §17.2 "offline resend must be idempotent". A PARTIAL unique index on `(thread_id, sender_id, idempotency_key)` (`:147`), EXECUTED: a repeated key from the same sender is refused, a different sender may reuse it. W: no database has the index, and `routes/messaging.ts` does not yet send a key. |
| T210 | N | **W** | §14.3 `visibleFromSequence` / `visibleUntilSequence`. Both columns exist (`:175`), with comments tying them to 2400's timestamp bound as that migration said they would be. W: no database has them, and the live bound is still 2400's `visible_from_at`. |
| T139 | W | **W** | §12 `conversation_members`. All four properties the row asks for now have columns — intervals (2400/baseline), role, visible sequence bounds and delivered/seen sequences (`:175` onward). Still W: no database has the last two pairs. |
| T141 | W | **W** | §12 `messages` envelope. The remaining three of six — sequence, lifecycle, content reference — now have columns. Still W for the same reason as every row in this block. |
| T156 | W | **W** | §12.1 `Message` contract. All six missing fields are declared (`:107`-`:112`) and the lifecycle vocabulary is a CHECK, proved to refuse an invented state. W: no database has them. |
| T276 | W | **W** | §21 unsent/deleted/revoked removed from search. The UNSENT half is now expressible and is applied IN THE QUERY behind the kernel flag (`services/telegraphMessageKernel.ts:86`, consumed by `services/telegraphSearch.ts`), with the OFF path proved not to NAME the column. Still W: the flag is off everywhere, and revoked source objects inside frozen cards (T46) are untouched. |

**Rows looked at that did not move:** T161 and T163 stay N — a column and a
table are not a command; `UNSEND_MESSAGE` and `ADD_REACTION` need routes this
batch did not write. T142, T143, T144 and T147 stay N — 2810 is the envelope and
the outbox, not the side tables. T178/T179 stay N/W — `delivered_sequence` and
`seen_sequence` exist but nothing writes or emits from them. T233 stays N — the
SSE stream still carries no cursor; `parseSequenceCursor`
(`services/telegraphMessageKernel.ts:109`) is the parser a resume would need and
no route calls it yet, which is declared-not-emitted, not built.

**The ceiling for §11.6.** Three events are C because they touch no schema. Every
other row here is W and cannot be anything else: *BUILT ON BRANCH IS NOT MERGED*,
and beyond that, **no database has run 2810** — not production, not portava-ci,
only a throwaway container that is deleted when this session ends. Turning the
flag on afterwards would still be an owner decision, and it would want a drainer
first. P24 — what would turn the executed claims red: a writer that sets
`messages.sequence` itself (two allocators is worse than none); a `body` added
to the outbox payload, which would put message text into a queue projections,
indexers and analytics all read; and any reader that names a kernel column
outside `kernelColumns`, which on a database without 2810 is a 42703 on every
message query rather than a missing feature.


---

### 11.7 §12's four side tables, and §13.1's one typed door

§11.6 built the envelope and the outbox. This section is the rest of §12's
table list and the endpoint that issues the two commands §13.1 names and this
repository had never offered.

**The four tables (migration 2811).** `message_edits`
(`migrations/2811_telegraph_message_side_tables.sql:92`), `message_reactions`
(`:115`), `message_attachments` (`:137`) and `conversation_action_refs`
(`:167`). They are one migration because they are one decision — stop putting
structure in `messages.body` and in nullable columns on `messages`, which is
what §12.1 forbids in as many words — and because a command route that writes
one of them should not wait for a separate migration per table.

Three details are worth stating because they are decisions rather than shapes.
`message_edits.previous_body` is NULLABLE: §12 says "versioned text edits WHERE
RETAINED", which is the spec declining to decide retention, so a deployment that
keeps only the FACT of an edit writes NULL and still gets a correct version
count. `message_reactions.emoji` is capped at 16 characters by a CHECK, and that
is a control and not a formatting preference — a reaction that could hold a
sentence would be a message that bypasses the send path's block guard, its rate
limit and §22's scam detection. `conversation_action_refs` carries `revoked_at`,
which is the property a string inside a JSON body cannot have and the one T46
says is missing when a source object is deleted and the shared card lives on.

All four have RLS enabled with a SELECT-only policy keyed on ACTIVE thread
membership, and a POSTCONDITION that raises if a non-SELECT policy ever appears
(`:289`) — so "writes go through the service role, which means through a route,
which means through the authorization a route applies" is enforced by the
migration rather than asserted by its header.

**The typed door (§13.1).**
`domain/telegraph/commands/telegraphCommands.ts:35` is §13.1's eighteen commands
verbatim. `:78` is the set `POST /api/telegraph/commands`
(`server/telegraph/commandRoute.ts:71#router.post(`) may issue — and it is deliberately
small: only commands with NO legacy writer. `SEND_MESSAGE` is refused here not
because it is unimplemented but because it IS implemented, with a block guard,
an E2EE gate, a rate limit, an off-app detector and a translation pipeline
attached; issuing it through a generic bus would route around all five. `:97`
names where each refused command actually lives, so the 409 says "go there"
instead of "unknown command", and `:121` names the two §13.1 commands nothing
implements, so a 501 can say that rather than pretending they are typos. A test
asserts every one of the eighteen is in exactly one of the three categories,
so a command in none of them is a failing test rather than a silence.

`UNSEND_MESSAGE` (`server/telegraph/commandRoute.ts:192`) enforces §7.4's rule
rather than merely offering the verb: once any eligible recipient has read past
the message it is REFUSED (`:233`). The seen state is read from
`message_thread_members.last_read_at`, which is thread-level, so the check is
CONSERVATIVE — a member who read later is treated as having seen it even if they
never looked at that message. That refuses some unsends that would have been
legitimate; the other direction would permit one that was not, and only one of
those two mistakes is recoverable. An unreadable roster refuses too: "we could
not check whether anyone saw it" is not "nobody saw it".

One gate for the whole endpoint (`:121`): every command here needs schema no
database has, so the flag is read once and the answer is `feature_disabled`
rather than a PostgREST 42703 a client cannot render. And a body that names an
actor is REFUSED rather than ignored — silently overriding it would let a caller
believe they had acted as someone else.

| id | was | now | why |
| --- | --- | --- | --- |
| T142 | N | **W** | §12 `message_edits`. The table exists (`migrations/2811_telegraph_message_side_tables.sql:92`) with a version number, a UNIQUE `(message_id, version)` and a nullable `previous_body` for §12's "where retained". W: no database has it and the edit route still overwrites `messages.body` in place. |
| T143 | N | **W** | §12 `message_reactions` (`:115`). The primary key makes a repeat idempotent; the 16-character CHECK stops the column becoming a second message body. W: no database has it, and the `telegraph.reaction` notification template that has existed with no table still has none. |
| T144 | N | **W** | §12 `message_attachments` (`:137`), pointing at `public.media_assets` with ON DELETE RESTRICT (§16.1's "MessageAttachment → MediaAsset"), with a `kind` that admits audio and file and an `ordinal` that makes the plural case representable. W: no database has it, and `messages.media_url` is still the live path. |
| T147 | N | **W** | §12 `conversation_action_refs` (`:167`), with `payload_version` and `revoked_at`. W: no database has it and nothing writes it. |
| T158 | N | **W** | §12.1 "structured payload types use versioned schemas and explicit reference tables". Both halves now have a representation: `payload_version` on the reference table (`:167`) and `event_version` on the outbox (§11.6). W: no database has either, and every card payload on the live path is still an unversioned JSON string in `body`. |
| T161 | N | **W** | §13.1 `UNSEND_MESSAGE`. A real command with §7.4's rule enforced (`server/telegraph/commandRoute.ts:192`, refusal at `:233`), publishing `message.unsent` and retaining the row as a tombstone. W: it needs `messages.unsent_at` (2810), no database has it, and the endpoint answers `feature_disabled` everywhere today. |
| T163 | N | **W** | §13.1 `ADD_REACTION` (`server/telegraph/commandRoute.ts:343#async function addReaction`), with `REMOVE_REACTION` alongside it (`server/telegraph/commandRoute.ts:378#async function removeReaction`) because a reaction a person cannot take back is a message they cannot unsend. W: needs `message_reactions` (2811), which no database has. |
| T181 | N | **W** | §13.2 `message.unsent`. In the union (`lib/telegraphEvents.ts:53`) and published by the unsend command, deliberately distinct from `message.deleted` — an unsend asserts the message never reached a mind, and a client that collapsed the two would render a retraction as a tombstone. W: nothing can issue the command on any database today. |
| T166 | W | **W** | §13.1 `CREATE_DECISION`. Unchanged in substance and re-derived: it is still only the meetup shape, and the command endpoint now says so out loud — `LEGACY_PATH_COMMANDS` (`domain/telegraph/commands/telegraphCommands.ts:126#export const LEGACY_PATH_COMMANDS`) points a caller at `/telegraph-chat/create-meetup` rather than leaving them to discover that a general decision command does not exist. |

**Rows looked at that did not move:** T168 stays N and T169 stays W — §11.7
first said both were N, which was wrong about T169: §1 records it as
BUILT-BUT-WRONG ("approximated by circle check-in … not a conversation command"),
and re-reading that row is what caught it. Both are now *named* as unimplemented
commands (`domain/telegraph/commands/telegraphCommands.ts:172#export const UNIMPLEMENTED_COMMANDS`) so the endpoint
answers 501 rather than 400 — a clearer refusal is not a built capability. T159, T160, T162, T164, T165, T167, T171-T176 stay C: every one has
a real route and the command endpoint refuses them precisely so those routes
stay the only door.

**The ceiling for §11.7.** Every row here is W and none can be more:
**no database has 2811**, the four tables are on the drift ratchet
(`scripts/checkProductionDrift.ts:365`, `:373`, `:384`, `:394`) with the reason
recorded per table, and the command endpoint is gated on 2810's flag, which is
seeded FALSE everywhere. The DDL and its re-application were EXECUTED on a
throwaway PostgreSQL 16 carrying the baseline plus the chain; the rollback is
written and states what it destroys and under what precondition it is safe.
P24 — what would turn these claims red: a non-SELECT RLS policy added to any of
the four (the migration's own postcondition catches it); `SEND_MESSAGE` or any
other legacy command added to `ISSUABLE_COMMANDS`, which would put a
guard-free door next to a guarded one; and any relaxation of the unsend's seen
check, which would let the product make a retraction claim it cannot honour.


---

### 11.8 §19's bands, turned from six labels into one order

T255 said it exactly: `important` "carries **no delivery difference** from
`normal` — only `urgent` changes behaviour. It is a label, not a priority." It
was worse than that when re-read. `telegraph.message` — §19's P2 — is
`defaultPriority: 'important'` too (`NotificationTemplateService.ts:217`), so
the one label the coordination band used was shared with the band below it and
could not have distinguished them even in principle.

**What a band is allowed to change.** Not delivery. `NotificationPreferenceService`
draws the override line at `urgent` + `admin` deliberately — "important priority
alone does NOT bypass user preferences" — and a meetup moving is not a reason to
wake someone at 3am; a second override would make the first meaningless. What a
band legitimately changes is **how long one notification suppresses the next**,
and that number lived in exactly one place: a flat
`DEFAULT_DEDUP_WINDOW_MS = 30 minutes` for everything. Which meant a second
safety alert was a duplicate of the first, and "the meetup moved to 8" followed
by "the meetup moved to the other bar" was one notification.

`domain/telegraph/policies/attentionLadder.ts:88` is §19's table as an order:
P0 never suppressed, P1 60s, P2 5min (the number `telegraph.message` already
used), P3 15min, P5 1h, and P4 `null` because §19 says it is not persisted at
all. `NotificationDeduplicationService.ts:114` reads it for the general rule and
`:78` for message coalescing, so the constant and the band cannot drift apart.
`dedupeWindowFor` (`:232`) has three answers and the difference is load-bearing:
`undefined` is "the ladder does not claim this event — keep the 30-minute
default", `0` is "P0, never suppress", `null` is "not persisted". Collapsing
`undefined` into `0` would have made every unclaimed event in the product
unsuppressable.

**Every name in the band map was read off the template file, and the first draft
was wrong.** It named `meetup.time_changed`, `meetup.location_changed` and
`trip.plan_changed`; none exist in this repository — the real "a meetup moved"
event is `circle.meeting_point_updated` (`NotificationTemplateService.ts:974`).
A band keyed on a name nothing can emit is a policy that silently does nothing,
so the test asserts per key that a template exists, and that assertion was RED
against that draft. The map claims only what it can justify: `admin.*` and
`rent_buddy.*` are absent though they carry `urgent`, and `compass.sense.*` is
absent though a circle plan change is coordination-shaped, because it belongs to
the Sensing surface and its own cadence rules govern it. Unclaimed is the safe
answer.

**P4 stopped being an absence and became a refusal.** T258 is C because there is
no typing template anywhere — but "nobody has written one" is not enforcement.
`typing.started` / `typing.stopped`, the two names the event bus actually uses
(`lib/telegraphEvents.ts:65`), are now P4 (`attentionLadder.ts:208`);
`check()` answers `ephemeral_not_persisted` for them before any read (`:69`),
and the test asserts a P4 event has NO template, so adding one is a failing test
rather than a push.

**The digest half.** `NotificationDigestService` already refused `urgent` and
`important` rows — but that is a PRIORITY filter, and §19's bands are not
priorities. `trip.crew_message` is `normal` and in a digest category, so it
could be pushed when it happened and summarised again the next morning.
`isDigestible` is now consulted per event type alongside the priority filter
(`NotificationDigestService.ts:183`, with `event_type` added to the select at
`:158` — a column this file already names at `alreadyDigestedForDay`), and
`undefined` keeps the row, so nothing that used to be digested stops being
digested by accident.

| id | was | now | why |
| --- | --- | --- | --- |
| T255 | W | **W** | §19 P1 Coordination. No longer a label: `circle.meeting_point_updated`, `trip.departure_reminder` and `safe_return.cleared` are P1 (`domain/telegraph/policies/attentionLadder.ts:164`) with a 60-second suppression window (`:98`) against P2's five minutes and the flat default's thirty, read by the real dedupe path at `services/notifications/NotificationDeduplicationService.ts:114`. Still W, and the ceiling is an OWNER DECISION: §19 says "immediate/high priority", and whether a coordination event may override quiet hours or a push-off preference is a product call I deliberately did not make — `NotificationPreferenceService` reserves that for `urgent` + `admin`, and a second override would void the first. |
| T257 | N | **W** | §19 P3 Media. The batching behaviour now exists — P3 is a real band with a 15-minute window and `digestible: true` (`attentionLadder.ts:116`) — and `telegraph.media_ready` is mapped to it (`:199`). W and not C because **nothing emits it**: it is named in `DECLARED_NOT_EMITTED` (`:251`) and the test asserts no template exists for it, because the server does not observe how long an upload took or whether the app was backgrounded, and inventing that signal would be worse than not having it. |
| T258 | C | **C** | §19 P4 Ephemeral. Re-derived and strengthened rather than moved: the row was C on the grounds that no typing template exists, which is an absence. `typing.started`/`typing.stopped` are now declared P4 (`attentionLadder.ts:208`) and `NotificationDeduplicationService.check()` refuses them with `ephemeral_not_persisted` before any read (`:69`), so the guarantee is enforced rather than merely unviolated. |
| T259 | W | **W** | §19 P5 AI. The degrade-first half now has a server-side expression: P5 carries the longest suppression window of any persisted band (1 hour, `attentionLadder.ts:138`) and is the only other digestible band. Still W: this is *suppression* ordering, not *load shedding*. The client-side ladder built in §11.5 (`hooks/useDataSaver.ts`) sheds AI first on the device; there is still no server-side shed under load, which is what T259's second half asks for and what an owner would have to decide to build. |

**Rows looked at that did not move.** T254 stays C and is now also *protected*:
the ladder's test asserts every P0 event's template is `urgent`, so a P0 event
that quietly became `important` would be a failing test rather than a safety
alert that stopped overriding quiet hours. T256 stays C — P2's five-minute
coalescing window is unchanged in value, and now comes from the band rather than
from a private constant that could drift from it. One correction to that row
while it was open: it records `telegraph.message` as `defaultPriority:'normal'`,
and the template says `important` (`NotificationTemplateService.ts:217`). The
verdict is unaffected — that is exactly why the label was worthless — but the
evidence sentence was measured against an older tree.

**The ceiling for §11.8.** This is BUILT ON BRANCH and NOT MERGED. Nothing here
needs a migration or a flag — it is a behaviour change to a service that already
runs — which means it is the one piece of §19 that would take effect on the day
it merged, and that cuts both ways: a mistake in `EVENT_BAND` is live on merge.
What would turn it red (P24): a P0 event added whose template is not `urgent`
(the test catches it); a typing template added (the test catches it); an event
type in `EVENT_BAND` that no longer has a template after a rename (the test
catches it); a band added with a window that does not increase down the ladder
(the monotonicity test catches it). What no test catches, and what an owner must
decide: whether P1 deserves a delivery override at all, and whether P5 should be
shed server-side under load rather than merely suppressed for longer.


---

### 11.9 §19's other half of the inbox line: "· 1 needs action"

T260 recorded the shape of the gap precisely: unread "is real and carefully
built … **'Needs action' has no representation** — nothing distinguishes a
message from an unresolved decision." Re-read against the tree and still exactly
true: every field `GET /me/threads` returned was about MESSAGES.

**What is allowed to count.** "Needs action" is not "unread, but louder". It is
a claim that the product is WAITING ON THIS PERSON, and the only honest source
for that is a stored object recording an answer they have not given. Two exist
in this repository, both from migration 0013: a `meetup_invites` row still at
`status = 'pending'` (the column's CHECK lists exactly
pending/going/maybe/declined/cancelled and defaults to pending, so "has not
answered" is a fact rather than an inference), and an unconfirmed
`meetup_time_options` row the caller has no `meetup_time_votes` row for. A
meetup reaches a conversation through `meetups.chat_thread_id`
(`migrations/0013_availability_meetups.sql:160`), which is the only link between
a decision and a thread, so it is the only join
`domain/telegraph/policies/needsAction.ts:80` makes.

Nothing else is counted, and the refusals are the design. Not an unanswered
question in prose — deciding that "so are we going?" needs an answer is a guess,
and a badge built on a guess teaches people to ignore the badge. Not a viewer
with no invite row: absence of a row is absence of a question, and counting it
would put a badge on a thread where they have nothing to answer. Not a cancelled
meetup, which is waiting on nobody.

**One meetup is one action** (`:168`). A poll with five evenings plus an
unanswered RSVP is one thing to go and deal with; a count that multiplied would
be the same badge inflation the row exists to avoid. `reasons` carries the kind
without moving the number.

**An unknown count is not zero.** supabase-js resolves on a database error, so
an unreadable `meetup_invites` returns the same `null` an empty one does.
Reporting `0` would hide a decision the traveller has to make. So a failed read
sets `degraded`, the map is emptied rather than partially filled — a partial map
reads as "these threads need nothing" — and the route OMITS the field
(`routes/messaging.ts:1832`) instead of sending a number. The client renders the
badge only above zero (`components/TelegraphInboxScreen.tsx:250#needsAction > 0`), so absent and
zero both render nothing and neither prints a reassurance nobody verified.

| id | was | now | why |
| --- | --- | --- | --- |
| T260 | W | **C** | §19's inbox line. The unread half was already real; the other half now exists end to end and is measured end to end: `domain/telegraph/policies/needsAction.ts:80` computes it from pending RSVPs and unvoted time options, `routes/messaging.ts:1772` calls it inside `GET /me/threads` and `:1832` puts `needsActionCount` + `needsActionReasons` on every row, and `components/TelegraphInboxScreen.tsx:250#needsAction` renders "1 needs action" / "N need action". `telegraphNeedsAction.test.ts` drives the REAL Express route, not just the policy, so "wired" is a measured fact. C rather than W because it needs no migration and no flag — every table it reads is from migration 0013 and has had live writers for the whole life of the meetups feature. |

**Rows looked at that did not move.** T261 stays N. An acknowledgement
primitive distinct from Seen needs a row per (message, actor, acknowledged_at)
that this schema does not have anywhere, and the nearest thing —
`safe_return_contacts.acknowledged_at` — is a different object about a different
promise. Deriving it from `last_read_at` would be precisely the conflation §19
forbids: thread-level read position cannot say that a person accepted a change,
only that their eyes passed over the screen.

**The ceiling for §11.9.** BUILT ON BRANCH, NOT MERGED. Like §11.8 this needs no
migration and no flag, so it is live the day it merges — which is why the
failure direction was chosen deliberately rather than by default. P24 — what
would turn it red: the client defaulting an absent count to a rendered zero (the
component test's absent and zero cases catch it); the badge fired at `>= 0`
(same); the count multiplied per option rather than per meetup (the policy
test); a non-invitee counted (the policy test); and any read here losing its
`.error` check, which `checkUncheckedSupabaseReads` would catch but which would
also turn four policy tests red first. What this does NOT cover, and no test can
claim: only meetups are decisions today. A Trip card, a booking change and a
plan dependency are all things a person must answer, and none of them has an
object that records whether they did.

**A correction to this section's own commit message (8175f1186).** It said two
cases in `src/test/messaging.test.ts` ("POST /api/threads/:threadId/media —
Finding 14: E2EE plaintext-media bypass") were PRE-EXISTING failures, measured
against the base commit's own `routes/messaging.ts`. They are not failures at
all. Both were run without the env prefix `npm test` supplies
(`SUPABASE_URL=http://127.0.0.1:9`), and the fixture builds its media URL from
that variable — so the route rejected the URL as not-an-app-media-URL and
answered 400 where the test expected the E2EE guard's 422. Re-run WITH the
prefix, the file is 22/22 green. The base-commit comparison did reproduce the
red, which is exactly why it was convincing: both runs shared the same missing
variable. Measuring twice is not measuring correctly if the second measurement
inherits the first one's mistake.


---

### 11.10 §22's evidence: the report that pointed at an empty string

T284 is the sharpest row in this census and it was still exactly true when
re-read: "The opposite happens. Deletion redacts in place —
`routes/groupChat.ts` `.update({ deleted_at: now, body: '' })` — with nothing
copied to moderation storage first, so reported content is **destroyed**, not
restricted." T283 is the same failure from the other side: `reports` carries a
reporter, a target and a 200-character reason, and no content at all.

So the sequence was: a person reports a message, the sender deletes it, and the
moderator opens a report that points at a row whose body is the empty string.
The reporter is then the only person who ever saw it, and the product's answer
to them is a shrug.

**The snapshot is taken at report time, and that is the whole design.** Not at
delete time. A delete-time hook would have to ask "was this ever reported?" on
every deletion — a read on the hot path that fails open by default — and it
would still lose the race when the delete arrived first. Report time is the one
moment the content is known to exist and the one moment somebody has asked for
it to be looked at.

**Restricted means no policy at all.** Every other table in this lane ships RLS
with a SELECT policy keyed on thread membership. `telegraph_report_evidence`
(`migrations/2812_telegraph_report_evidence.sql:96`) ships RLS `ENABLE` plus
`FORCE` (`:152`) and **no policy whatsoever**, so every role except the service
role reads zero rows. A membership-keyed policy would have handed the reported
party their own evidence file — they are usually still a member of the thread
they were reported in — which is precisely the disclosure §22 exists to stop. A
postcondition RAISES if any policy is ever added (`:190`), so relaxing this is a
migration somebody has to write on purpose rather than a line somebody adds by
habit. That postcondition was EXECUTED against a real policy and it raised.

**There is deliberately no foreign key to `messages`.** The table exists so
content outlives the thing it came from; an FK would either block the deletion
or cascade the evidence away with it. The one FK is to `reports` with
`ON DELETE CASCADE`, which is the privacy-correct direction: evidence is held to
serve a report, so when the report stops existing the justification stops with
it. The catalog was read back and shows exactly one foreign key, to `reports`.

**Three outcomes, not one absence.** `services/telegraphReportEvidence.ts:88`
records `captured`, `already_deleted` (`:114`, `:118` — the content was gone
before the report was filed, so there was nothing to copy) or `unreadable`
(`:111` — the read failed). supabase-js resolves on a database error, so a
failed read and a deleted message arrive as the same `data: null`; recording
them as the same fact would tell a moderator "there was nothing there" when the
truth is "we could not look". And none of the three changes the report's
outcome: capture is awaited before the response but wrapped so it can never fail
one (`routes/messaging.ts:3245`, `:3472`). A person who has just reported
harassment must not be told "could not file report" because a snapshot table was
slow.

**Minimum necessary is a number, not a feeling.** `body_snapshot` is capped at
4000 characters by a CHECK and truncated by the service before it gets there;
a thread report keeps a bounded window of the last twenty messages
(`telegraphReportEvidence.ts:55`) in a `context` blob the migration caps at
16 KB. Copying a whole conversation because somebody reported it would retain
far more than was reported, including messages from people who are not party to
the complaint.

| id | was | now | why |
| --- | --- | --- | --- |
| T283 | W | **W** | §22 evidence. There is now a content snapshot, taken at report time, with its own table (`migrations/2812_telegraph_report_evidence.sql:96`), its own restricted posture (`:152`, `:190`) and its own caps. W and not C because **no database has 2812** and the flag (`:160`) is seeded FALSE, so on every live deployment a report still carries nothing but a reason string. The ceiling is an owner decision in two places: applying the migration, and choosing a retention schedule — `retention_until` is NULL and nothing purges, deliberately, because a job destroying moderation evidence on a number this migration invented would be worse than no job. |
| T284 | N | **W** | §22 reported-deleted content. The mechanism now exists and it is the right one: the snapshot happens before the deletion can, the table has no FK to `messages` so a deletion cannot cascade it away, and RLS-with-no-policy keeps it out of normal retrieval by construction rather than by query discipline. W for the same ceiling as T283 — no database has the table, the flag is FALSE — so **on every live deployment today, reported content is still destroyed when its author deletes it**. That sentence is the honest state of this row and the code on this branch does not change it. |
| T220 | W | **W** | §15 block rediscovery — re-derived, because the row's evidence is stale and its verdict is still right for a different reason. The fail-open it names ("`routes/messaging.ts:1783-1788` destructures only `{ data: otherMembers }`", "the same hole exists on the media send path") is FIXED on this tree at both sites: `routes/messaging.ts:2173` and `:2664` both check `otherMembersErr` and refuse the send with `degraded_unavailable` rather than skipping the guard. Measured at the base commit of this branch too, not only on my tree: `otherMembersErr` appears six times in `routes/messaging.ts` at `014a25d56`, so the fix the row calls unmerged is merged. The row stays W on the strength of the requirement it actually states — "no subsystem may independently rediscover a blocked relationship" — which is still violated: at least eight modules outside the shared helpers query `blocks` directly, each with its own pairwise logic and its own error handling (`services/interactionPermissions.ts:322`, `compass/CompassTools.ts:318`, `compass/CompassNotificationEngine.ts:411`, `compass/CompassProfileService.ts:104`, `compass/CompassFallbackFeedBuilder.ts:224`, `lib/circleAccessGuard.ts:493`, `services/wall/WallProjectionService.ts:179`, `services/ranking/CreatorActivityScoreService.ts:601`). One shared helper that most callers use is not the same as one shared helper that all callers must use. |

**The ceiling for §11.10.** No database has 2812. The flag is seeded FALSE. The
DDL, the postcondition's refusal of a policy, the rollback and the
re-application were all EXECUTED on a throwaway PostgreSQL 16 carrying the
baseline plus the chain, and the catalog was read back rather than assumed. What
would turn this red (P24): a `CREATE POLICY` on the evidence table (the
migration's own postcondition raises, and a text assertion fails first); a
foreign key to `messages` added for tidiness (a text assertion, and it would
reintroduce exactly the destruction T284 measured); the flag check removed from
the service, which would name a table on databases that do not have it; and
collapsing `unreadable` into `already_deleted`, which would tell a moderator
that nothing existed when the truth is that nobody could look. All four were run
as deliberate mutations and five of twenty-nine assertions went red.


---

### 11.11 §22's request origin, and the word "say"

T278: "`message_requests` has no origin column at all — only `preview_text`. A
recipient cannot be told why a stranger is reaching out." Re-read and still
true: the insert wrote sender, recipient and preview text and nothing else.

The harm is a safety harm rather than a convenience one. "Someone you have never
met wants to message you" and "someone in the trip crew you joined yesterday
wants to message you" call for different answers, and the recipient was getting
the first sentence for both.

**Three columns, and the third is the one that matters.** Migration 2813 adds
`origin_type` (§22's six as a CHECK, not free text — an origin a recipient reads
as a reason must come from a closed set or it is a second `preview_text` a
stranger can write anything into), `origin_id`, and `origin_verified`, which
defaults FALSE (`migrations/2813_telegraph_request_origin.sql:73`).

Without the third column this feature would be a liability rather than a
control. **The sender asserts the origin, and a sender who wants to be trusted
asserts "Trip."** Storing that indistinguishably from a verified one would have
the product tell a recipient something it does not know, at the exact moment
they are deciding whether to let a stranger talk to them. So verification is a
separate fact the server establishes, and it can establish exactly one of the
six: `trip`, when BOTH parties are accepted members
(`domain/telegraph/policies/requestOrigin.ts:58`, `:116`). A trip only the
sender is in does not verify — that case is the attack, and it has its own test.
An unreadable roster resolves to unverified, because "we could not prove it" and
"it is not true" are the same answer for the only thing this value decides.

**The grammar carries the epistemics.** A verified origin is STATED ("In your
trip crew"); an unverified one is ATTRIBUTED ("They say you share a trip")
(`features/telegraph/lib/requestOriginLabel.ts:60`). Not a badge colour: a
colour does not survive a screenshot, a description aloud, or a person in a
hurry, and the sentence does. An origin whose type claims verification but has
no verified wording falls back to the CLAIM wording — understating is the safe
direction the day a second origin becomes verifiable and that table has not been
updated.

**Nothing is backfilled and nothing is invented.** Existing requests read NULL,
which the client renders as it always did: nothing. An "unknown origin" label on
every historical request would make each of them look suspicious, and inventing
`profile` for rows nobody measured would put a specific claim on them.

| id | was | now | why |
| --- | --- | --- | --- |
| T278 | N | **W** | §22 request origin. All six of §22's origins exist as a closed vocabulary shared by the migration's CHECK and the policy (`domain/telegraph/policies/requestOrigin.ts:54`), the request path records one (`routes/messaging.ts:701`), the list path returns it under the same flag (`:752`, `:791`), and the recipient reads a different SENTENCE for a verified origin than for a claimed one (`features/telegraph/lib/requestOriginLabel.ts:60`). W and not C for two stated reasons: **no database has 2813** and the flag is seeded FALSE, so every live request still carries no origin; and only ONE of the six can ever be verified here — `nearby` and `bump` are unverifiable in principle (proximity at request time is not retained, and reconstructing it would be a location read §15 does not authorize for this purpose), `event` and `buddy` would need another lane's tables, and `profile` is unverifiable and uninteresting. Five of six being claims is the honest state and the wording says so on every one of them. |

**The ceiling for §11.11.** BUILT ON BRANCH, NOT MERGED, and no database has
2813. The DDL, both CHECK refusals (a free-text origin; verification with no
claim attached), the rollback and the re-application were EXECUTED on the same
throwaway PostgreSQL 16, and the constraint names were read out of the error
messages rather than assumed. P24 — what would turn this red: verifying a trip
on the sender alone (the test that exists for exactly that attack); a failed
membership read resolving to verified; the select list naming the columns while
the flag is off, which would 42703 the whole message-request list on every
database that lacks 2813; and the client printing the verified wording for a
claim. All four were run as deliberate mutations. One thing NO test covers and
this section states rather than hides: the `catch` in `resolveRequestOrigin` is
currently unreachable, because `isAcceptedTripMember` has its own try/catch —
mutating it to `verified: true` turned nothing red, and the file now says so.

Headline after §11 in this worktree (last statement wins): C=123 W=184 N=121 X=0

## 12. The certification lane — §26, §27, and what executing them found

Written by the Telegraph lane holding §23–§31 and Appendix A, in a worktree off
`014a25d5`. Sections §1–§11 and §12–§22 were held by other agents in their own
worktrees at the same time; nothing below depends on their work landing, and
every row that WOULD depend on it says so.

### 12.1 What was built, and where

**The spec's §26 matrix and §27 plan existed only as prose. They are now data a
checker reads, and three suites that execute them.**

The census's §5 found the whole of §27 absent — "No monotonicity property test
exists. `test/accessControl.test.ts` and `test/rlsPrivacy.test.ts` are case
tests over fixed fixtures" — and §26 satisfied incidentally by route checks
written for other reasons. That reading was right, and it points at the shape of
the gap: a certification plan that lives in a document cannot go red. So the
thirty-five entries of §26 and §27 are declared as TypeScript under a new
`domain/telegraph/` package, driven by three node:test suites against the
real handlers, and policed by a checker wired into `check:all`.

**The declarations.** `domain/telegraph/contracts/certification.ts:46`
defines the four-status vocabulary the whole lane turns on, and the choice of
four rather than two is the point: `enforced` means *true on every deployment of
this tree*, `flag_gated` means *built and not running*, `divergent` means *the
tree does something else*, and `vacuous` means *the case cannot arise*. Nothing
can be rounded up. The entries themselves:

- §26's ten cases, `domain/telegraph/invariants/rlsAuthorizationMatrix.ts:32`
  (RLS-01) through `:194` (RLS-10).
- §27.1's seven properties,
  `domain/telegraph/invariants/propertyInvariants.ts:27` through `:148`.
- §27.2's twelve fixtures,
  `domain/telegraph/invariants/adversarialFixtures.ts:22` through `:218`.
- §27.3's six live-DB contracts,
  `domain/telegraph/invariants/liveDbContracts.ts:25` through `:122`.

**The suites.** `test/telegraphRlsAuthorizationMatrix.test.ts:182`–`:593`
(38 cases), `test/telegraphPropertyInvariants.test.ts:161`–`:584` (19),
`test/telegraphAdversarialFixtures.test.ts:155`–`:561` (27). Every assertion
lands on an output of real code: the real `messagingRouter`, the real
`canMessage`, the real `buildCrewCard`, the real `isBlockedBetween`, the real
`requireSafeReturnRecipient`, the real event bus, the real `syncTripChatMembers`.
What is replaced is PostgREST, by
`test/telegraphCertificationHarness.ts:157` — and it is replaced rather than
mocked away for a specific reason stated at `:36`: supabase-js RESOLVES on a
database error, and that is the shape that turns a dropped `.error` into
fail-open authorization, so a fake that threw instead would make those bugs
untestable.

**The guard.** `scripts/checkTelegraphCertification.ts:14` states its five
rules; the fifth is the one that matters — the count of entries that are NOT
`enforced` is pinned per family in
`scripts/TELEGRAPH_CERTIFICATION_BASELINE.json:11` and may only shrink. A
future change cannot make a red case green by reclassifying it. Wired at
`scripts/run-all-checks.sh:390` and declared in
`scripts/guardRegistry.ts:808-821`, with an inspection proof so a pass says how
much it looked at.

**The share-authorization gate.** §26's private-Memory case and §29's Memory
prohibition were *unguarded absences* — "no Memory share path exists, so the
case cannot arise and nothing guards it". That is a guarantee which lasts until
the fifth producer, and four already exist.
`domain/telegraph/policies/shareAuthorizationPolicy.ts:122` is now a
total, fail-closed decision function: an unrecognised object family is refused,
a private source without a derivative grant is refused, a grant issued by a
different domain is refused (§29's no-semantic-ID-substitution, applied to
authorization), an unparseable expiry is refused rather than read as "never
expires", and a "derivative" that names the private source's own id is refused
because it is the source wearing a grant. What travels is the derivative id.

`scripts/checkTelegraphShareProducers.ts:15` makes it unavoidable: every
`msg_type`/`subtype` literal in both trees must be declared, orphan declarations
fail, and — the rule with teeth — a producer whose `sourceDomain` is
private-by-default may ONLY be declared `PRIVATE_SOURCE`
(`domain/telegraph/policies/shareAuthorizationPolicy.ts:481`). The registration rule alone would have been
satisfiable by declaring a Memory card `PUBLIC`; this closes that route for
exactly the domains the case is about. It does not close it for a private domain
nobody has named yet, and the checker says so on every run rather than implying
otherwise.

### 12.2 Four things executing the plan found that reading it did not

**1. Revoking a live location share can WIDEN what a viewer sees.** Found by the
§27.1 precision property, not by inspection. A live share overrides the member's
passive default *in both directions* — `domain/trips/services/tripCrewLocation.ts:246` honours it
even over a `hidden` default, deliberately — so a member whose standing default
is `neighborhood` who starts a `city_only` share discloses LESS while it runs,
and ending it moves the label from a city back to a district. Recorded with the
exact input at `test/telegraphPropertyInvariants.test.ts:331`. It is not a
§27.1 violation: the wider label is one the member separately authorized. It is
recorded because it is counter-intuitive in the direction that matters — "I
stopped sharing" makes the label more precise — and any UI that says *sharing
stopped* while showing a narrower area than before would be telling the truth
about the grant and the opposite of the truth about the disclosure.

**2. `messages.subtype` carries a highlight's ID.** `routes/highlights.ts:2070#subtype: id,`
writes `subtype: id` — an identifier into the discriminator column a renderer
dispatches on. It can never match a renderer case, and it puts a
highlights-domain id into a messaging-domain vocabulary field, which is the
shape §29's *"No semantic ID substitution across domains"* forbids. Nothing is
visibly broken, because `msg_type: "highlight_reply"` is the real discriminator
there — which is why it has survived. Declared at
`domain/telegraph/policies/shareAuthorizationPolicy.ts:365` so it is a
decision rather than an accident.

**3. `POST /threads/:threadId/messages` accepts any `subtype` the client sends.**
`routes/messaging.ts:2044` takes it straight from the request body; the only
vocabulary constraint anywhere on that handler is that `msgType` collapses to
`system` or `text` (`:2039`). A client can stamp any discriminator it likes onto
a message. It cannot forge the payload's authorization — every card's data comes
from the same client-authored body — so this is a rendering-shape hole rather
than an access-control one, but it is exactly the seam §30A.10's capability
registry exists to close. Recorded at `domain/telegraph/policies/shareAuthorizationPolicy.ts:332`.

**4. Two of the six §27.3 lanes are not in `check:all`, and both are still
reached.** `check:enum-literals` runs as its own static `ci.yml` step —
deliberately, "needs no database and cannot be starved"
(`.github/workflows/ci.yml:215`) — and `check:migration-ledger` appears in
`live-db.yml` only inside a comment, its real reach being `certifyMigrations.ts`,
which spawns it as a ledger gate (`scripts/guardRegistry.ts:263-269`). The
first version of the §27.3 assertion checked `run-all-checks.sh` alone and went
red on both. It now asks the question `guardRegistry.ts` asks — is this checker
reached by anything — which is the right question and was not the obvious one.

### 12.3 Every green here was seen red first

Twelve deliberate mutations, each reverted immediately, each moving a suite from
all-pass to one-fail. The three worth recording are the ones that found a test
wrong rather than the tree:

- **The roster-refusal proof corrected the test.** Removing the block guard's
  roster-error refusal from `routes/messaging.ts:2080` left the matrix suite
  GREEN, because failing `message_thread_members` outright denies at the
  caller's own membership check and the roster guard is never reached. The
  harness grew per-table operation counting
  (`test/telegraphCertificationHarness.ts:39`) so the failure lands on the
  second read. Only then did the mutation go red.
- **The translation-invalidation proof found two call sites.** Deleting the
  wrong `markTranslationsPending` left the fixture green; so did asserting on the
  row's final state, because the edit route fires the re-translation without
  awaiting it and the regeneration rewrites the row. The assertion now measures
  the invalidation WRITE (`test/telegraphAdversarialFixtures.test.ts:376`).
- **The mid-send fixture first failed for the wrong reason.** Removing the
  sender before the handler's own membership check produced a 403 that proved
  only that the check works. It now mutates the roster on the second read, after
  that check has passed (`test/telegraphAdversarialFixtures.test.ts:411`).

And one that corrected the fake rather than the test: the first run of the
request-flooding fixture reported an unbounded flood the real database does not
have, because the fake applied no column default, `message_requests.status` came
back undefined, and the route's one-request-per-pair short-circuit could never
fire. `columnDefaults` (`test/telegraphCertificationHarness.ts:57`) exists
for that reason.

### 12.4 Row moves — §26 and §27

| id | was | now | why |
| --- | --- | --- | --- |
| T311 | C | C | Unchanged verdict, executed evidence. RLS-01 is driven at `test/telegraphRlsAuthorizationMatrix.test.ts:182`: a non-member's read is refused AND the `messages` table is never reached, and an unreadable membership table also denies. Declared `enforced` at `domain/telegraph/invariants/rlsAuthorizationMatrix.ts:32`. |
| T312 | C | C | RLS-02, `test/telegraphRlsAuthorizationMatrix.test.ts:201`. The departed member is denied the entire thread for read and for send; the route re-checks `left_at` on the returned row as well as filtering on it, so the gate is doubled — measured, removing only the filter left the property green. |
| T313 | W | W | **Still W, and the reason changed completely.** The bound now EXISTS: migration `migrations/2400_telegraph_history_bound.sql` adds `message_thread_members.visible_from_at` and the flag `telegraph_history_bound_enabled`, and `services/groupChatHistoryBound.ts` is applied at `routes/messaging.ts:2018#visibleFromOf` and `:1850`. RLS-03 proves both halves at `test/telegraphRlsAuthorizationMatrix.test.ts:222`: with the flag on the pre-membership message is withheld and the bound is applied IN the query so pagination cannot walk past it; with the flag as seeded — FALSE — the whole back history is returned. **Ceiling: no database has 2400 and the flag is seeded off.** BUILT ON BRANCH IS NOT DEPLOYED; this row cannot move from inside the tree. |
| T314 | W | **C** | The fail-open is closed in the tree. `routes/messaging.ts:2080-2084` now REFUSES the send when the roster read fails ("cannot determine whether this is a blocked 1:1 thread") instead of inferring an empty roster and skipping the guard. RLS-04 drives five configurations at `test/telegraphRlsAuthorizationMatrix.test.ts:261` — recipient-blocked, sender-blocked, mutual (the two-row state that used to make the guard raise), blocks-table unreadable, roster unreadable — and all five deny. Shown red by deleting that refusal. |
| T315 | C | C | RLS-05, `test/telegraphRlsAuthorizationMatrix.test.ts:309`. Expiry, status and recipient identity are each refused by `services/safeReturn/SafeReturnPrivacyGuard.ts:142-157` before the handler runs, and exact coordinates cannot leave the API at all — `stripGPS` (`:24#stripGPS`) is proved to delete `latitude`/`longitude` at depth. Two independent artifacts, so neither is a single point of failure. |
| T316 | C | C | RLS-06, `test/telegraphRlsAuthorizationMatrix.test.ts:377`, driving the real predicate `services/passport/OpenToPlansService.ts:168` over the cross-product of five visibility policies, both sources and five viewer relationships: a private window is invisible to every non-self viewer, an INFERRED window is invisible whatever visibility it carries, and an expired one is invisible even to an admitted viewer. |
| T317 | N `∅` | **C** | The unguarded absence is now a refusal. `domain/telegraph/policies/shareAuthorizationPolicy.ts:122` refuses a private source with no derivative grant, a grant from the wrong domain, a grant for the wrong scope, an expired or unparseable-expiry grant, and a "derivative" that names the source's own id — six refusal branches, exercised at `test/telegraphRlsAuthorizationMatrix.test.ts:425`. `scripts/checkTelegraphShareProducers.ts` makes it unavoidable, and its private-by-default rule (`domain/telegraph/policies/shareAuthorizationPolicy.ts:481`) closes the misdeclaration route for exactly the domains this case names. NO producer is `PRIVATE_SOURCE` today — the gate is the guarantee, not a live path, and the row says so. |
| T318 | N | N | Unmoved, and now mechanically so. The authorization half answers (`test/telegraphRlsAuthorizationMatrix.test.ts:483`) and there is no *current safe share projection* for it to authorize: no producer resolves a source object's present state. An empty audience is also refused, so the positive case cannot be satisfied vacuously. |
| T319 | W | W | RLS-09, `test/telegraphRlsAuthorizationMatrix.test.ts:510`, drives both halves: BEFORE `syncTripChatMembers` runs, a removed trip member still reads the thread (200 — the divergence, asserted); AFTER the real sync runs, read and send both deny and the row carries `left_at`. **Ceiling: the trip-membership write and the thread-membership write are not one transaction, and the sync is invoked fire-and-forget from Trips-owned routes.** Closing it is a Trips change, not a Telegraph one. |
| T320 | W | W | RLS-10, `test/telegraphRlsAuthorizationMatrix.test.ts:544`. The one action that re-derives is correct across the whole status vocabulary (`lib/calls/callGatewayAdapter.ts:73`): cancelled and refunded are refused, disputed and completed-with-both-parties stay callable. The divergence is asserted against the component: `travel-buddy-standalone/src/components/rentabuddy/BookingMilestoneMessage.tsx` contains no `fetch` and no effect, so its buttons outlive the booking state they were rendered from. **Ceiling: §30A.10's action capability registry (T410).** |
| T321 | N | **C** | P-01 exists and is a property, not a case: `test/telegraphPropertyInvariants.test.ts:161` runs the real `canMessage` over 576 enumerated relationship states and every single-signal weakening of each — 3,000+ comparisons — on the lattice denied < requires_request < allowed (`domain/telegraph/policies/disclosureLattices.ts:33`). Shown red by inverting the circle override in `lib/messagingPermissions.ts:333` so it granted on absence. |
| T322 | N | **C** | P-02, `test/telegraphPropertyInvariants.test.ts:291`, over the real `buildCrewCard` (`domain/trips/services/tripCrewLocation.ts:158`) — the resolver that ships, not `presence/domain`, which the census correctly noted nothing uses. Six precision-decreasing transforms over 160 enumerated inputs, measured on what LEAVES the function (`disclosedPrecision`, `domain/telegraph/policies/disclosureLattices.ts:64`). Shown red by making `resolveExactCoords` ignore hotel blur. It also produced finding 1 above. |
| T323 | N | **C** | P-03, `test/telegraphPropertyInvariants.test.ts:413`. No sequence column exists, so the property is expressed over what a sequence would have ordered — the set of ids the real route returns — and every membership weakening must yield a SUBSET. Shown red by removing BOTH departed-member gates from `routes/messaging.ts` (removing one was not enough, which is itself worth knowing). |
| T324 | W | **C** | P-04, `test/telegraphPropertyInvariants.test.ts:463`, quantifies over the FAILURE states as well as the healthy ones: block present, blocks table unreadable, roster read unreadable. All deny, none writes a canonical row, and a control proves an unblocked send still succeeds so the property is not vacuously true. Shown red by flipping `lib/blockGuard.ts:38` to fail open. |
| T325 | W | **C** | P-05, `test/telegraphPropertyInvariants.test.ts:518`. Expressed as a property over 50 window states and both sides of the boundary, including the instant the expiry names, with no sweep having run — which is the distinction that matters, and `2260:38-42` states it. Thread expiry has no referent and the test asserts that structurally rather than passing over it. |
| T326 | N | N | Unmoved. There is no unsend operation to quantify over. The suite now asserts that absence STRUCTURALLY at `test/telegraphPropertyInvariants.test.ts:584`, so it goes red the moment an unsend route or an `unsent_at` reference lands — shown red by adding a stub unsend route. PR #472 is still unmerged and CI-only. |
| T327 | N | N | Same absence, same structural assertion. Recorded with it: the receipt an unsend would race — `last_read_at` — DOES exist and is what #472 reuses rather than inventing a competing sequence. |
| T328 | W | **C** | F-01 exists and drives three separate facts (`test/telegraphAdversarialFixtures.test.ts:155`): flooding ONE recipient is bounded to a single delivered request by the route's pending/accepted short-circuit, which also refuses outright when that table is unreadable rather than delivering a second unsolicited request; flooding TWELVE recipients is unbounded; and in-thread sends are bounded at the strictest tier's limit — the first 20 accepted, every one after refused 429, and no row written for a refused send. **CORRECTED BY THE INTEGRATOR when the §12–§22 lane merged into the same tree:** this row originally read "in-thread sends are unbounded (25 accepted)", which was true when §12 measured it and is not true now, because that lane built the send limiter T279 named as missing. The fixture went RED on the merge rather than passing while describing a system that no longer exists, which is what §27.2's contract asks of it, and the case was rewritten to assert the new boundary. Shown red again afterwards by making the send path's limiter inert (`if (false && !decision.allowed)` in `routes/messaging.ts`): F-01 fails, and reverting restores 27/27. A first mutation attempt — raising `SEND_LIMITS.stranger` from 20 to 999 — did NOT turn it red, because the assertion reads the constant, and that is recorded here rather than hidden: this fixture measures that the send path ENFORCES the tier, not what the tier's number is. The behavioural gap stays at T279, where it belongs; this row asks whether the fixture exists, and it does. |
| T329 | N | **C** | F-02, `test/telegraphAdversarialFixtures.test.ts:209`. Three retries — healthy, blocks-unreadable, roster-unreadable — all refused, nothing written. The fixture also asserts what makes the scenario real: the stale device's belief is CORRECT, because blocking does not close an existing thread, so the per-send re-check is the only thing standing between them. |
| T330 | N | **C** | F-03, `test/telegraphAdversarialFixtures.test.ts:244`, posts the same `clientId` twice through the real route and proves TWO canonical rows. The mechanism gap (no idempotency) stays at T231 and the metric at T347; the fixture exists and measures it. |
| T331 | N | **C** | F-04, `test/telegraphAdversarialFixtures.test.ts:265`, over the real bus: per-subscriber delivery order is the publish order, one throwing subscriber cannot silence the others, and the swallow is COUNTED (`lib/telegraphEvents.ts:279-285`). Shown red by removing that try/catch. |
| T332 | N | **C** | F-05, `test/telegraphAdversarialFixtures.test.ts:309`. An availability window and a safe-return live share both cross their expiry with no writer, no sweep and no owner device — the condition under which a sweep-based design leaks — and both are refused on the read. |
| T333 | W | **C** | F-06, `test/telegraphAdversarialFixtures.test.ts:350`, driven as the race the census said was missing: in-flight translations of the previous body are left in place, the edit goes through the real route, and the invalidation WRITE is asserted. Shown red by deleting `markTranslationsPending` from the edit handler — after two earlier mutations that did not go red and corrected the assertion instead. |
| T334 | N | **C** | F-07, `test/telegraphAdversarialFixtures.test.ts:409`, makes the window deterministic by removing the sender's membership between the handler's own check and the insert. The send COMPLETES: membership is checked once and the insert is not conditioned on it. Asserted as today's outcome with the requirement quoted; closing it is a conditional insert, not a test change. |
| T335 | N | **C** | F-08, `test/telegraphAdversarialFixtures.test.ts:456`, runs the real `syncTripChatMembers` against a trip the member has been removed from and proves read and send both deny afterwards, with nothing written on the way out — and that a second reconciliation converges rather than re-stamping the departure. Shown red by short-circuiting the departure reconciliation. |
| T336 | W | **C** | F-09, `test/telegraphAdversarialFixtures.test.ts:493`, walks the booking status vocabulary through the real eligibility function and asserts the card's blindness against the real component. |
| T337 | N | **C** | F-10, `test/telegraphAdversarialFixtures.test.ts:515`. The safe answer to a conflicting thread is not a correct summary but a refusal to act on one, and that is what is asserted: `requires_confirmation: true` is a LITERAL type in `routes/telegraphCommands.ts:57`, so an unconfirmable action is unrepresentable; the confirm path re-verifies trip membership at execution (`:412`) and refuses a command the caller does not own (`:398`); and no canonical trip write happens before confirmation. |
| T338 | N | N | Unmoved — there is no unsend, so there is no race to run. The absence is asserted structurally at `test/telegraphAdversarialFixtures.test.ts:546`. #472 implements exactly this race in the database, with `FOR UPDATE` locks on every eligible recipient's receipt row, and is unmerged. |
| T339 | N | **C** | F-12, `test/telegraphAdversarialFixtures.test.ts:561`, asserts against both real card components that neither performs a fetch, neither has an effect, and the payload carries a `sourceId` with no capability vocabulary beside it. Structural rather than timing-dependent, which is what the defect actually is. |
| T340 | C | C | LDB-01. Unchanged, and now tied to a test that fails if the lane is renamed: `test/telegraphRlsAuthorizationMatrix.test.ts:593` asserts every named script exists and is REACHED — by `check:all`, a workflow, or a declared delegation. |
| T341 | C | C | LDB-02. Same, and see finding 4: this lane is not in `check:all` and is still reached, as its own static CI step. |
| T342 | C | C | LDB-03. Same. |
| T343 | C | C | LDB-04. Same; reached through `certifyMigrations.ts`'s ledger gate rather than directly. |
| T344 | W | W | **Still W, and smaller than it was.** Of the four dropped-error reads the census named, one is FIXED (the block-guard roster read now refuses) and two resolve to a 403 rather than an empty inbox — a refusal is not a plausible empty state. What remains is genuinely this defect: the per-viewer translation read (`routes/messaging.ts:1889`), and the trip, booking and circle context reads in the inbox projection (`:1726`, `:1742`, `:1357`), each of which renders an untranslated message or a thread with no trip context when the table is unreadable. Measured and asserted at `test/telegraphRlsAuthorizationMatrix.test.ts:620` so the count cannot silently reach zero without the contract being reclassified. **Ceiling: the fix is in `routes/messaging.ts`, which §12–§22's lane holds concurrently; this lane measured it rather than editing a contested file.** |
| T345 | C | C | LDB-06. Unchanged. |

### 12.5 The ceiling on this section

Four things bound these rows, and none of them is a test that has not been
written:

1. **T313 needs a migration no database has and a flag seeded off.** 2400 exists
   and is proved on both sides of its flag. MERGED IS NOT DEPLOYED; DEPLOYED IS
   NOT FLAG ENABLED.
2. **T319 needs a transaction that spans Trips and Telegraph.** The gate is
   right; the propagation is fire-and-forget from routes this lane does not own.
3. **T320, T339 and T411 need the §30A.10 action capability registry** — the
   cards must be given their buttons at render time by something that can
   re-authorize them. That is a build, not a fix.
4. **T326, T327 and T338 need PR #472 to merge.** Until then the absence is
   asserted structurally, which is the strongest thing this tree can say about
   an operation it does not have.

T344 is bounded differently: its remaining instances are in a file another lane
holds this week. The measurement is in place and shrink-only; the edit is not
this lane's to make.

### 12.6 §28 and §30A.17 — Telegraph is measured, in-process, for the first time

The census's finding was exact and it was worse than absent: "No metric is
emitted for messaging and no target constant exists… Telegraph has no telemetry
sink at all. Nothing in §28 or §30A.17 has anywhere to land." One level under
that, the realtime bus ALREADY counted everything it swallowed —
`lib/telegraphEvents.ts:80-102` declares nine counters for exactly that purpose,
including the one that loses an event for every member of a thread at once — and
**nothing read them but a test**. An operator asking "is realtime degraded?" had
no way to look.

**The registry.** `domain/telegraph/services/telegraphObservability.ts:46` holds
§28's nine metrics (`:49`–`:201`) and §30A.17's eight SLOs (`:221`–`:333`), each
with the spec's own requirement wording, a target, a severity and a status. The
target is a union
(`domain/telegraph/contracts/observability.ts:58`) because the spec's nine
targets are not the same kind of statement: "0 under the idempotency contract" is
a count, "high availability" is a ratio, "bounded" is a latency, and "primary
product outcome metric" names no number at all. `unbounded` is therefore a
first-class target carrying the spec's own words — inventing a threshold would
produce confident alerts about a line nobody drew.

**The recorder's privacy property is a type, not a convention.**
`domain/telegraph/services/telegraphObservability.ts:384` takes a metric key, an outcome and an optional
duration, and there is **no parameter a message body, a handle or a location
could travel in**. §30A.17's "do not indiscriminately copy private message text
into analytics" is satisfied by making the violation unrepresentable rather than
by a rule somebody has to follow. An undeclared key is ignored at runtime rather
than accumulated under a catch-all, and
`scripts/checkTelegraphSlos.ts:131` fails on a typo'd key statically, which is
the only place it can be caught.

**The emitters are real call sites, not a test harness.**
`middlewares/telegraphObservability.ts:126` is mounted at `app.ts:182`, BEFORE
the router, so it times what the user waits for rather than what the handler
does. It classifies by method and path shape (`:61`) — which means a new
Telegraph command surface is measured the day it is added, instead of on the day
somebody remembers. The second emitter is the block guard
(`lib/blockGuard.ts:46`).

**What counts as a failure is the whole design.**
`middlewares/telegraphObservability.ts:119`: a 2xx is ok, a 5xx or a
`degraded_unavailable` is a violation, and **a 403 is neither**. Counting a guard
doing its job as an availability failure would make every hardening change look
like an outage and every outage look like hardening — the metric would move for
the wrong reason in both directions. Refusals are recorded in their own column so
the denominator stays honest. This is the assertion that was shown red first, by
making `outcomeFor` return a violation for everything non-2xx.

**The diagnostics surface.** `routes/telegraphDiagnostics.ts:64` — admin-gated
through the shared guard, purpose-scoped (`:62`: an `X-Admin-Access-Reason` of
under ten characters is refused, because a field that accepts "debug" is a field
and not a scope), audit-logged (`:85`), and it exposes **no conversation id, no
user id and no message body**, which the suite asserts by searching the served
payload for each. It also reports its own `processUptimeMs` and a
`counterScope` line saying what its numbers are worth, so a reader can tell a
quiet hour from a restart and cannot mistake an in-process counter for a
pipeline.

### 12.7 §24 — the projections, and a count the census got wrong

`domain/telegraph/projections/projectionRegistry.ts:43` declares the six §24
projections with what each is and is not, and `:138` declares every direct client
read of a raw messaging table — §24's closing rule, "mobile clients consume
server-built projections instead of independently joining raw tables".

**The census recorded two bypasses. There are six.** Re-derived by enumeration
rather than by reading the conversation screen top to bottom, and
`scripts/checkTelegraphSlos.ts:213` re-derives them on every run so the number
cannot grow: four reads of `message_thread_members` in
`travel-buddy-standalone/app/messages/[id].tsx` (the other party's
`last_read_at`, a member count, the accepted-member permission gate, and the
group roster with every member's `last_read_at`), one of `message_threads` for
the E2EE flag, and one more of `message_thread_members` in
`travel-buddy-standalone/src/components/GroupChatScreen.tsx` that the census did
not count at all. All six are the same defect — a receipt or capability
projection the server does not build, so the client joins the raw table to build
it — and one of them recomputes an authorization decision.

### 12.8 Row moves — §24, §28 and §30A.17

| id | was | now | why |
| --- | --- | --- | --- |
| T289 | W | W | Unchanged and now declared: PRJ-01 at `domain/telegraph/projections/projectionRegistry.ts:44`. The list half is a real server-built projection; the Now band and the nearby summary have no source. **Ceiling: T8 and T292.** |
| T290 | W | W | PRJ-02, `domain/telegraph/projections/projectionRegistry.ts:57`. The renderable half gained the §14.3 history bound since the census; it still carries no permissions block, which is the half §24 names explicitly. **Ceiling: §14.1's ConversationCapabilities (T207), which is §12–§22's lane.** |
| T291 | N | N | PRJ-03. Unchanged, and now under a shrink-only ratchet: `absentProjections` is pinned at 4 in `scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json:9`, so a projection cannot quietly stop existing. |
| T292 | N | N | PRJ-04, same. |
| T293 | N | N | PRJ-05, same. |
| T294 | N | N | PRJ-06, same. The drawer is dead-coded behind a literal `false`, which is worse than absent for a reader because the affordance looks built. |
| T295 | W | W | **Same verdict, corrected magnitude: six bypasses, not two.** Declared at `domain/telegraph/projections/projectionRegistry.ts:138` and re-derived on every run by `scripts/checkTelegraphSlos.ts:213`, which also fails on an UNDECLARED one — so a new client-side join of a messaging table cannot be added silently, which is the way this rule decays. **Ceiling: removing them needs the missing permissions block (PRJ-02) and a server-built receipt projection; the edits are in client files §1–§11's and §12–§22's lanes hold.** |
| T346 | N | **C** | The metric exists, has a target, and is recorded on every deployment of this tree. SLO-01 (`domain/telegraph/services/telegraphObservability.ts:49`) is a 0.99 success ratio over every Telegraph command surface, emitted by `middlewares/telegraphObservability.ts:126` mounted at `app.ts:182`. The "safety/coordination prioritized" half is the severity ladder, and it is enforced as an ORDERING between rows by `scripts/checkTelegraphSlos.ts:161` rather than trusted as a label. **The counters are in-process and reset on restart; there is no durable sink and no alerting, and the surface says so on every read.** |
| T347 | N | **W** | The target exists (SLO-02, `domain/telegraph/services/telegraphObservability.ts:69`, count ≤ 0) and something real detects violations: the middleware remembers accepted `(threadId, clientId)` pairs and counts a second acceptance, which is exactly the case that happens — an offline client retrying a send that did land. F-03 proves two canonical rows are created. **Ceiling: bounded by one process's memory, so it is a floor on the true number and never a ceiling. The exact version needs the idempotency key the send path does not have (T231).** |
| T348 | N | **W** | Declared with its target (SLO-03, `:89`) and structurally unmeasurable: there is no unsend operation to violate it. Recorded rather than left out so that when unsend lands the target already exists. A zero produced by absence is not a measurement and is not counted as one. **Ceiling: PR #472, unmerged and CI-only.** |
| T349 | W | W | Unchanged. The guarantee is enforced and proved (RLS-05), and NOTHING COUNTS IT, so a regression would be silent — which SLO-04 (`:107`) now says out loud instead of leaving implicit. **Ceiling: the emitter belongs in `services/safeReturn/SafeReturnPrivacyGuard.ts`, which this lane does not hold.** |
| T350 | W | **C** | Both halves closed. The fail-open the census recorded is gone from the tree and P-04 quantifies over the failure states to prove it; and the guard is now instrumented at `lib/blockGuard.ts:46`. What is counted is deliberate: a refusal is `ok`, because the target is "blocked direct deliveries = 0" and a refusal IS zero deliveries; an unreadable blocks table is an `unknown` for that metric and a VIOLATION of the block-enforcement SLO, because the denial was made without knowledge — which is the rate at which enforcement runs blind, and the shape a leak would start as. |
| T351 | N | **W** | SLO-06 (`:146`) has a target and an emitter. What is measured is the two existing projections' BUILD latency, because they cache nothing and their staleness is zero by construction — the quantity that would start to matter the moment either is materialised. **Ceiling: "alert on material stale shared context" has no referent at all; there is no shared context (T21), and four of six projections do not exist.** |
| T352 | C | C | Unchanged verdict, and it stopped being unmeasured. SLO-07 (`:164`) folds the bus's own counters rather than re-counting them — subscriber failures, cross-instance broadcast failures and events dropped because a thread's audience could not be resolved — and the diagnostics route is the first thing in the repository that reads them. The guarantee itself stays architectural: the row is committed and the 201 returned before any publish. |
| T353 | N | N | Unchanged. Revocation does not exist, so the latency is undefined rather than large. SLO-08 (`:184`) carries the spec's own intent wording instead of an invented number. |
| T354 | N | **W** | SLO-09 (`:201`) is emitted, and it is labelled a PROXY in its own declaration: what is counted is a human confirming a proposed action through `/telegraph/commands/:id/confirm-action` — the one place a conversation becomes a canonical write — and **a confirmed typed command is not a real-world outcome**. Whether anybody then met is not in this system. Recorded so it cannot be quoted as the north-star metric. |
| T432 | N | **W** | §30A.17's ten measurements: four are now real (delivery latency, failed sends, seen convergence, and coordination success as a proxy); six are not (unsend outcomes, media processing, plan conversion, Nearby→conversation, conversation→plan, completed real-world outcomes), and four of those six have no referent in the tree at all. |
| T433 | C | C | Unchanged, and now structural rather than behavioural: the recorder's signature (`domain/telegraph/services/telegraphObservability.ts:384`) has no parameter private text could travel in, and the diagnostics payload is asserted to contain no body, no conversation id and no user id. |
| T434 | N | **C** | All eight SLOs §30A.17 names are defined with targets — message acceptance, realtime delivery, offline recovery, seen convergence, block enforcement, location revocation, media availability, projection freshness (`:221`–`:333`) — and the clause's closing sentence is enforced: `scripts/checkTelegraphSlos.ts:161` refuses a delivery or product SLO with a budget tighter than the tightest safety/privacy one. Definition is what this row asks for; five of the eight are also measured, and the other three say exactly why not. |
| T435 | W | W | The moderation half already existed and is guarded. The delivery/projection half now exists: `routes/telegraphDiagnostics.ts:64`, admin-gated, purpose-scoped, audit-logged, and carrying no private content by construction. **Ceiling: the audit is a structured LOG LINE, not a durable row. `admin_access_log` constrains `record_type` to five values, none of which is this, so a durable audit would need either a migration no database has or mislabelling a diagnostics read as a profile read — and saying something untrue in an audit trail is worse than saying it in a log.** |

### 12.9 §23's package, §25.1's inventory, and §30A.18's replay simulator

**The domain package now exists and is enforced.** §23 names eight
subdirectories; `src/domain/telegraph/` has all eight and every one of them is
populated by something this lane built and something outside the package
imports. `scripts/checkTelegraphPackageBoundaries.ts:61` lists the eight and
fails on an empty one — an empty directory is a promise of a boundary, not a
boundary — and `:117` fails on a module nobody outside the package imports,
which is the same defect `check:guard-reachability` catches for checkers, one
level further in.

The rule that matters is `:139`. §23's sentence — *"Trips, Buddy, Safety,
Memories, Discovery and Compass remain integrations. Telegraph does not embed
their canonical business logic"* — is mechanised as an import discipline: the
domain package may not import another domain's service, and it may not import a
route at all. Three delegations are allowed and each carries the reason it is
allowed (`:78`); the §14.3 window predicate is on that list because
re-implementing it inside a simulator would fork an authorization rule, which is
worse than an import.

**§25.1's Phase 0 inventory is a generated artifact.** The census was exact:
*"The capability to do it exists as standing CI lanes (T297); the deliverable
does not."* `scripts/generateTelegraphInventory.ts:48` writes
`docs/architecture/telegraph-phase0-inventory.md`, and
`scripts/generateTelegraphInventory.ts:324` re-derives it and diffs, so the report exists AND cannot rot. It covers all nine things §25.1
enumerates — schema, migrations, RLS, server routes, client reads, realtime
subscriptions, push flow, media upload, translation paths and enum literals —
and it carries no `file:line` citations on purpose: a generated line number is
invalidated by any edit above it in a file this report does not own, and
`check:doc-citations` would then go red for a reason nobody caused.

Three things the inventory surfaced that no row had recorded: fourteen route
files touch a messaging table (not the one or two a reader would guess), the
realtime event vocabulary is twenty-five types of which ELEVEN are calls, and
`saved_messages` is dispositioned under RLS and read by a server route that no
client screen calls. (Both of those numbers were wrong in the first commit of
this section and are corrected here; §12.14 says what they were and why the
second one mattered.)

**§30A.18's replay simulator.** `domain/telegraph/replay/replaySimulator.ts:171`
applies the ten operations that clause names — `domain/telegraph/commands/replayCommands.ts:22`
holds the vocabulary, in the spec's order — and emits an event log
(`domain/telegraph/events/replayEvents.ts:22`). The suite runs **every one of the 720 orderings**
of a six-operation set, twice over, and checks three invariants in the final
state plus determinism plus rebuildability. Exhaustive rather than sampled on
purpose: a sampled permutation space makes a failure unreproducible, which is
the one property a certification harness cannot afford to lose.

It is a model of the transport, and it says so. Every decision a shipped
function already makes is delegated to that function: the §14.3 window predicate
at `:156`, and the real fail-closed block guard at `:108`, driven through a
blocks-shaped client so the real `.select().or().limit()` chain and the real
error branch are exercised. UNSEND is modelled from the SPEC, because this tree
has no unsend, and the result labels it `modelled` so a green replay cannot be
read as evidence that unsend works here.

### 12.10 What the replay found

**An event that omits a fact is a projection that cannot be rebuilt.** The
rebuildability property failed on 120 of 720 permutations because
`message.created` did not carry whether the send had media attached: the replay
knew, the log did not, and the fold produced a message whose media status was
unreconstructable. The fix is one field on the event
(`domain/telegraph/contracts/replay.ts:90`), and the finding is the general one —
§29's "rebuildable from canonical state + events" is a constraint on what the
EVENTS carry, not only on what the projections do, and it is invisible until
something actually folds a log.

The second finding is smaller and the same shape: the first blocks-client in the
simulator resolved at `.or()` rather than at the end of the chain, so the real
guard's `.limit(1)` was never reached and every permutation reported "not
blocked". A model that fails to reach the real guard proves the opposite of what
it claims, which is why the chain in `:108` mirrors the real call order exactly.

### 12.11 Row moves — §23, §25, §29, §30-DoD, §30A.15/§30A.18, Appendix A

| id | was | now | why |
| --- | --- | --- | --- |
| T285 | N | **C** | `src/domain/telegraph/` exists with all eight subdirectories §23 names, every one populated, every module imported from outside the package, and the layout enforced by `scripts/checkTelegraphPackageBoundaries.ts:61` in `check:all`. Fourteen modules: the certification contracts and registries, the share policy and disclosure lattices, the observability registry, the projection registry, and the replay command/event/simulator triple. |
| T286 | W | W | Unchanged. `src/features/telegraph/{home,conversation,…}` is a CLIENT layout and this lane holds none of those files; the components are still flat in `travel-buddy-standalone/src/components/`. Deliberately NOT enforced by the boundary checker: a checker demanding a directory nobody intends to create would be permanently red, and a permanently-red check is one `\|\| true` away from being no check at all. |
| T287 | W | W | Unchanged. Two of eight exist as files rather than a package; the repository's routes are flat under `src/routes/`, so `server/telegraph/{commandRoutes,readRoutes,…}` describes a split it does not use. Recorded rather than enforced, for the same reason as T286. |
| T288 | C | C | Unchanged verdict, and it stopped resting on structure alone. The Primary Invariant is now mechanically enforced for the domain package: `scripts/checkTelegraphPackageBoundaries.ts:139` refuses an import of another domain's service, with three named delegations that each carry their reason. Shown red by importing `services/groupChatSync` into the simulator. |
| T296 | N | **C** | The T0 deliverable exists: `docs/architecture/telegraph-phase0-inventory.md`, generated by `scripts/generateTelegraphInventory.ts:48` and re-derived-and-diffed by `check:telegraph-inventory` in `check:all`. All nine of §25.1's subjects are covered. Shown red by editing one line of the committed report, which the checker named by line number. |
| T302 | W | W | Unchanged count, one item improved: Phase 1's "member visibility bounds" now EXIST (migration 2400 plus `services/groupChatHistoryBound.ts`), flag-gated off. Still no outbox and no policy service. **Ceiling: the same flag and migration as T313.** |
| T436 | N | **C** | The replay simulator exists, permutes all ten named operations, and verifies deterministic final state: `domain/telegraph/replay/replaySimulator.ts:171`, driven over 720 orderings at `test/telegraphReplaySimulator.test.ts:129`. It also checks the three invariants that make the permutation worth running — a removed member reads nothing afterwards, an unsend never succeeds after an eligible recipient's receipt, and a derived translation never completes for an unsent message — and asserts the property is non-vacuous in both directions (some orderings allow the unsend, some refuse it). |
| T437 | N | **C** | §30A.18's property list is §27.1's, and all five of the ones it names are built and executed: permission monotonicity (P-01), precision monotonicity (P-02), removed participants (P-03), block (P-04) and temporary-scope expiry (P-05), at `test/telegraphPropertyInvariants.test.ts:161`–`:518`. The census's observation — that the tree's one genuine property test of this family guarded a module nothing uses — is no longer true of Telegraph. |
| T438 | W | W | Unchanged. The live-DB half is fully built and now test-covered (LDB-01…LDB-06, `test/telegraphRlsAuthorizationMatrix.test.ts:593`). The second half — "schema/permission failures must never be swallowed into plausible empty inboxes" — is still open in the messaging tree, measured and shrink-only at `:620`. **Ceiling: the same file another lane holds, as T344.** |
| T358 | N `∅` | **C** | The same artifact that moved T317: `domain/telegraph/policies/shareAuthorizationPolicy.ts:122` refuses a private-source share without a derivative grant, and `scripts/checkTelegraphShareProducers.ts` makes the refusal unavoidable — a producer whose source domain is private-by-default may ONLY be declared PRIVATE_SOURCE. The invariant is constructed rather than merely unviolated, which is the census's own standard for a prohibition. |
| T369 | W | W | Unchanged verdict, and the missing half is now demonstrated rather than asserted. The census's reason was "there are NO EVENTS to rebuild from"; the simulator has an event log and `domain/telegraph/events/replayEvents.ts:65` folds it back to the state the commands produced, over all 720 permutations. That proves the PROPERTY holds for a model. **Ceiling: the real tree still emits no durable event log — the realtime bus is in-memory and lossy by design — so nothing in production is rebuildable from events, and the model says so rather than implying otherwise.** |
| T428 | W | W | Same as T369, from §30A.15's side. The two projections that exist are stronger than rebuildable (nothing is cached); the four that do not exist cannot be. |
| T375 | W | W | Unchanged, with two of the five now genuinely done rather than incidentally: RLS negative tests are a declared, executed ten-case matrix, and block cascade is proved as a property over the failure states. Membership history is flag-gated (T313); revocation and source-object authorization do not exist (T46, T318). |
| T378 | C | C | Unchanged, and reinforced by this lane's own choices: no `telegraph_*` table was created, no migration was written at all, and the one new artifact that could have been a table — the observability sink — was deliberately built in-process instead, because a table no database has would have made every §28 row depend on a deployment rather than on the tree. |
| T441 | C | C | Unchanged verdict, now enforced rather than observed: the boundary checker refuses the import that would make it false. |

### 12.12 The ceiling on §12, in one place

Nothing in this section is bounded by a test that has not been written. What
bounds it:

1. **A migration no database has, and a flag seeded off** — T313, T302, and the
   history-window half of T362 and T444. MERGED IS NOT DEPLOYED; DEPLOYED IS NOT
   FLAG ENABLED.
2. **PR #472, unmerged and applied to `portava-ci` only** — T326, T327, T338,
   T348. The absences are asserted structurally so they go red the day it lands.
3. **Work in files other lanes hold this week** — T344 and T438 (the messaging
   tree's remaining dropped-error reads), T295 (six client-side joins), T290
   (§14.1's capability block). Each is measured and shrink-only here; the edit
   is not this lane's to make.
4. **Features that do not exist and are not this lane's sections** — the Shared
   Context Rail, Nearby, coordination sessions, the content drawer, revocation.
   T291–T294, T318, T353, T372 and T376 are bounded by those, not by
   instrumentation.
5. **An owner decision** — a durable telemetry sink and alerting. Twelve of
   seventeen SLOs are unmeasured or proxied, seven of them because the thing to
   measure does not exist and five because they are honest proxies. The counters
   that do exist are in-process and reset on restart, and every surface that
   reports them says so.


### 12.13 §30A rows the tree moved under the census, re-derived

The census was measured at `ebe72b34`; this worktree is off `014a25d5`. Four
§30A rows have new evidence that is not a change this lane made, and one
statement in §4 is now out of date. Recorded here because a census that is
right about the tree it measured and silent about the tree that exists is a
document people quote wrongly.

**§4's attribution claim has an exception it did not have.** §4 says PR #472 "is
the first and only artifact in the repository built *for* this specification",
and at `ebe72b34` that was true. It is not true at HEAD:
`migrations/2400_telegraph_history_bound.sql:6-14` opens by citing §14.3, §26,
§29, §30A.4 and §30A.20 by number and quoting each, and it reasons explicitly
about Appendix A's reuse rule in choosing a timestamp over a sequence
(`migrations/2400_telegraph_history_bound.sql:49-56`). It is merged into this tree and is not a hypothetical. The
spec-attributable count is a §4 number and this section does not restate it; what
it records is that the artifact §4 says does not exist now does.

**§30A.4 and §30A.20 gained a substrate and a flag.** `migrations/2400_telegraph_history_bound.sql:141` adds
`message_thread_members.visible_from_at`, database-authoritative via a BEFORE
trigger, and the migration says why a dedicated column rather than `joined_at`:
`services/groupChatSync.ts` upserts every accepted member with `joined_at: now`
on EVERY sync, so a bound keyed on `joined_at` would hide a long-standing
member's own history the next time anyone joined (`migrations/2400_telegraph_history_bound.sql:34-42`). That is a real
finding about the tree, not a design preference, and it is the kind of thing a
census reading the read path alone would not see.

| id | was | now | why |
| --- | --- | --- | --- |
| T389 | W | W | **Four of six, not three.** `baseline:7496-7504` carries `joined_at`, `left_at` and `role`; migration 2400 adds the `visible_from_sequence` analogue as `visible_from_at`, expressed in `created_at` coordinates because this schema has no sequence on `messages` and Appendix A's rule says reuse the established convention (`migrations/2400_telegraph_history_bound.sql:49-56`). Still absent: `removed_at` — a removal is indistinguishable from a departure — and `visible_until_sequence`. **Ceiling: 2400 is applied to no database.** |
| T390 | W | W | The first clause is now IMPLEMENTED and OFF: new members do not gain pre-membership history while `telegraph_history_bound_enabled` is true, proved on both sides of the flag by RLS-03. The second clause — adding a third person to a direct conversation creates a new group — is still vacuous, because no add-to-DM operation exists. **Ceiling: the flag is seeded FALSE and no database has the column.** |
| T391 | W | W | Unchanged. `role` is still CHECK `member\|admin` — two of the five roles §30A.4 names — and no capability-based authorization keys off it for invitations, removals, pins, announcements or group settings. 2400 did not touch it. |
| T444 | W | W | Same substrate as T390, from §30A.20's side, and 2400 cites this clause by number. The window is enforced in the QUERY (`routes/messaging.ts:1863`) rather than filtered after the fact, so pagination cannot walk past it — which is the difference between a bound and a display rule. **Ceiling: the flag is seeded FALSE.** |
| T409 | N | **W** | Was "No registry and no contract; each producer hand-rolls a payload." One of §30A.10's six dimensions now has both. `domain/telegraph/policies/shareAuthorizationPolicy.ts:205` is a registry of every shareable message type with its object family and source domain, and `:113` is the AUTHORIZATION contract those families resolve against, made unavoidable by `scripts/checkTelegraphShareProducers.ts`. The other five dimensions — preview, current state, actions, search behaviour, revocation — have nothing, which is why this is one sixth and not more. |
| T429 | N | N | Unchanged, and now precisely bounded. There are no versioned structured-message schemas; what exists is a registry of eighteen unversioned literals plus ten sites that COMPUTE a message type, one of which takes the discriminator straight from the client's request body (`domain/telegraph/policies/shareAuthorizationPolicy.ts:332`). A versioned schema is exactly what would close that, so the registry's finding and this row's absence are the same fact seen twice. |

**The external-preview prohibitions were left unguarded, deliberately.** T404,
T405 and T446 are unguarded absences — there are no link previews and no GIF
provider — and the obvious ratchet is a rule that no message-rendering component
may make a network call. This lane considered it and did not build it, because
that rule would also forbid the FIX for T339 and T411: a share card that
re-fetched its source object to re-authorize a stale action is exactly what those
rows are waiting for, and a guard that made it fail CI would freeze a live
divergence in place to close a vacuous one. The rule that would work has to tell
"fetches our own API to re-authorize" from "fetches a sender-controlled URL", and
that distinction cannot be drawn until the controlled server-side preview service
§30A.8 asks for exists. Recorded as a decision so the next reader does not spend
the afternoon rediscovering it.

| id | was | now | why |
| --- | --- | --- | --- |
| T404 | N `∅` | N `∅` | Unchanged, and now with the reason a ratchet was not added: the guard that would close it would forbid the fix for T339 and T411. There are still no link previews; a URL renders as plain text. |
| T405 | N `∅` | N `∅` | Unchanged. No GIF provider exists, so there is no isolation boundary to enforce. |
| T446 | N `∅` | N `∅` | Unchanged, same reason as T404 — this is §30A.20's restatement of it. |

**The rest of §30A was not re-derived and its verdicts stand as §6 recorded
them.** Forty-odd rows in §30A.1, §30A.2, §30A.3, §30A.5, §30A.6, §30A.7,
§30A.9, §30A.11, §30A.12, §30A.13, §30A.14 and §30A.19 turn on features that do
not exist in this tree — a canonical relationship model, a reachable-people
projection, announcements and acknowledgement, a device registry with proximity
and background-location capability, forwarding provenance, transport scale
classes, a Context Kernel. This lane did not build any of them and did not
re-read them deeply enough to restate a verdict; saying nothing is the honest
option, because a restated verdict is a claim about the tree and citing one from
memory is the thing this census exists not to do.

### 12.14 Two corrections to §12.9, and one to §8

§12.9 as first committed said the inventory surfaced "twenty-five event types of
which twelve are calls" and that "`saved_messages` is dispositioned under RLS
while having no reader in application code". The first was a miscount — eleven of
the twenty-five are `call.*` — and the second was **wrong**, in the direction
that matters. Both sentences are corrected in place rather than left standing
with an erratum, and the correction is recorded here rather than made silently,
because a document that edits its own prose without saying so is the failure this
census exists to make harder.

`GET /api/me/saved-messages` exists at `artifacts/api-server/src/routes/messaging.ts:3951#router.get('/me/saved-messages', async (req, res) => {` and reads
`saved_messages`, re-authorizing at read: it excludes saves in threads the caller
has left and messages that have been deleted, and a failed read is a 500 rather
than an empty list. So §8's third deployment fact — "`saved_messages` is written
and never read" — is out of date at HEAD **on the server**.

It is still true where it counts. A repository-wide search of the client for that
route or any `savedMessages` call site returns nothing: no screen fetches it. The
Save affordance on both client surfaces therefore still does nothing a user can
observe, which is what §8's fact was actually about. The reader is built, nothing
reads the reader, and the honest statement is that sentence rather than either
half of it. T119 is §7/§10's row and this lane does not restate it; the fact it
rests on has moved and this says how.

Headline after §12 in this worktree (last statement wins): C=124 W=171 N=134 X=0

Computed by `pnpm -s check:census-integrity`, which parses 429 verdict rows of the
451-row denominator and takes the LAST statement for each id. The 22 it cannot read
are prose-counted requirements, and its X column reads 0 because §7's three
CANNOT-VERIFY rows are stated in prose rather than in a verdict table — they are
still three, and §7 is still where they are recorded.

---

## 13. Whose 176 is it — the deployment-capped / branch-fixable split, and two dead affordances the split found

`head_commit: 3eaf2436f` — the base this section measured. Every verdict below
was read against that tree; the code this section adds sits on branch
`worktree-agent-a0248dfa10b57c1df`, which is not merged, not deployed and not
flag enabled.

Sections 10, 11 and 12 moved 176 requirements into BUILT-BUT-WRONG and left them
as one undifferentiated pile. A reader looking at "176 wrong" cannot tell the row
that needs one `psql` command from the row that needs a quarter, and the two lead
to opposite decisions. This section splits all 176, builds what the split says is
buildable, and reports what building it found.

### 13.1 The test, stated before the answer

Four groups, one mechanical question each. Every one of the 176 is in exactly one.

| group | the question | whose it is |
| --- | --- | --- |
| **OWNER** | Would applying the named migration and enabling the named flag, **with no code change at all**, make this row true? | The owner's. A branch cannot move it. |
| **BOTH** | Does it need an owner deploy **and** a branch change? | Both. Deploying alone does not close it — worth knowing before anyone schedules one. |
| BRANCH | Can code in this tree close it with **no new storage and no flag**? | Ours. A missing consumer, a wrong rule, an absent loader, a client that does not re-derive. |
| NEITHER | Is the remaining gap something **nobody has written** — an absent subsystem, or storage that exists in no migration? | Neither. Not a release, and not a week's work either. |

**The tie-break, stated because it decides about thirty rows.** Most rows name
several gaps. A row takes the HARDEST gate still standing once the others are
met, in the order NEITHER > BOTH > OWNER/BRANCH. So T2 is NEITHER even though its
reactions and unsend halves are cleanly owner-capped: deploying 2810 and 2811 and
flipping both flags still leaves T2 wrong, because its voice half needs an audio
MIME type that exists in no migration. The rule is deliberately conservative in
that direction — the failure this split exists to prevent is telling an owner
that a deploy will move a row it will not move.

**What this is not.** It is not a claim that a NEITHER row matters less, and it
is not a work estimate. It answers one question: *who can move this?*

### 13.2 The answer

| group | rows | share of the 176 |
| --- | --- | --- |
| **OWNER** — a deploy and/or a flag, no code | **24** | 13.6 % |
| **BOTH** — a deploy AND a branch change | **12** | 6.8 % |
| BRANCH — pure code, no storage, no flag | **51** | 29.0 % |
| NEITHER — nobody has written the thing it needs | **89** | 50.6 % |

Three readings, because each answers a different question:

- **36 of the 176 cannot reach C without the owner** (OWNER + BOTH) — 20 % of the
  pile. §1 says "a large part of the 176 W is capped there". That sentence is not
  wrong, but it is vaguer than the evidence now permits, and a reader can take it
  to mean most of the pile. It is one row in five.
- **24 are the owner's ALONE.** For those the entire remaining work is applying a
  migration and an `UPDATE feature_flags`. Nineteen of the twenty-four are gated
  on 2810 or 2811.
- **51 are ours today** — no migration, no flag, no new table. That is the most
  actionable number in this document and nothing before this section states it.

And the number that should be uncomfortable: **89 rows — more than half the
BUILT-BUT-WRONG pile — are blocked on something that exists in neither tree.**
Thirty-eight of the eighty-nine trace to five absent subsystems, by a first-match
keyword pass over the third column of §13.4 (the ids are listed so the pass can
be checked rather than trusted):

| absent thing | rows | ids |
| --- | --- | --- |
| Nearby / proximity / stranger discovery | 18 | T5, T8, T22, T23, T30, T33, T219, T289, T309, T351, T368, T373, T383, T419, T420, T421, T440, T451 |
| voice and its derivatives | 9 | T2, T40, T45, T47, T274, T304, T308, T371, T422 |
| per-recipient delivery receipts | 5 | T69, T70, T73, T179, T234 |
| a coordination session ENTITY | 4 | T85, T307, T374, T395 |
| a durable telemetry sink or audit row | 2 | T347, T435 |
| everything else | 51 | — |

No deploy touches any of the five.

### 13.3 The artifacts that do the capping

Every OWNER and BOTH row traces to one of six artifacts, and all six are in the
tree and in no database. The lists below are exhaustive over the 36.

| artifact | flag, as seeded | rows it caps |
| --- | --- | --- |
| `artifacts/api-server/src/migrations/2810_telegraph_message_kernel.sql:420#telegraph_message_kernel_enabled` | FALSE | T72, T78, T139, T141, T154, T156, T161, T181, T195, T196, T210, T228, T230, T231, T232, T276, T302, T348, T369 |
| `artifacts/api-server/src/migrations/2811_telegraph_message_side_tables.sql:92#CREATE TABLE IF NOT EXISTS public.message_edits` — gated by 2810's flag | — | T80, T142, T143, T144, T147, T158, T163, T221, T385 |
| `artifacts/api-server/src/migrations/2812_telegraph_report_evidence.sql:160#telegraph_report_evidence_enabled` | FALSE | T283, T284 |
| `artifacts/api-server/src/migrations/2400_telegraph_history_bound.sql` + `telegraph_history_bound_enabled` | FALSE | T211, T313, T362, T390, T444 |
| `artifacts/api-server/src/migrations/2260_availability_windows.sql` + `open_to_plans_windows_enabled` | OFF | T28 |
| `artifacts/api-server/src/migrations/2813_telegraph_request_origin.sql:132#telegraph_request_origin_enabled` | FALSE | none — see below |

2813 caps a row that is nevertheless NEITHER, and that is the clearest argument
for the conservative tie-break. Applying 2813 and enabling its flag gives every
message request a stored origin — and T278 still does not go C, because five of
its six origins are unverifiable in principle and no deploy changes that. An
owner who read "capped by 2813" would schedule a release and get nothing.

### 13.4 The split, row by row

Ordered by group, then by id. The third column says what stands between the row
and C — not what the row is; the row's own text upstream says that.

| id | group | what actually stands between this row and C |
| --- | --- | --- |
| T28 | **OWNER** | Telegraph reads availability and re-evaluates expiry; `open_to_plans_windows_enabled` is seeded OFF by 2260. |
| T72 | **OWNER** | 2810/2811 add the delivered/seen sequence pair (restated at T139). This row cites a baseline line number that predates them. |
| T78 | **OWNER** | `messages.sequence` is 2810's, assigned by trigger on insert; a tombstone then keeps it without further code. |
| T139 | **OWNER** | 2810/2811 columns; no database has them. |
| T141 | **OWNER** | 2810's messages envelope; no database has it. |
| T143 | **OWNER** | 2811's `message_reactions`; no database has it. |
| T156 | **OWNER** | 2810's Message contract fields; no database has them. |
| T161 | **OWNER** | 2810's `messages.unsent_at` and its flag; the command is written and refuses with `feature_disabled`. |
| T163 | **OWNER** | 2811's `message_reactions`; the ADD/REMOVE commands are written. |
| T181 | **OWNER** | `message.unsent` can only be issued on a database that has 2810. |
| T195 | **OWNER** | The same-transaction trigger is 2810's; no database has it. |
| T210 | **OWNER** | 2810's visible-from/until sequence columns; no database has them. |
| T211 | **OWNER** | 2400 and `telegraph_history_bound_enabled`, seeded FALSE. |
| T230 | **OWNER** | 2810's offline command columns; no database has them. |
| T232 | **OWNER** | Needs `messages.sequence` (2810); the tombstone half is already right. |
| T276 | **OWNER** | `telegraph_message_kernel_enabled` gates the UNSENT predicate. Evidence correction: the frozen-card half is closed (T46 is C). |
| T283 | **OWNER** | 2812 and `telegraph_report_evidence_enabled`, seeded FALSE. Retention is a second owner decision. |
| T284 | **OWNER** | The same table and the same flag. |
| T302 | **OWNER** | The same 2400 migration and flag as T313, plus 2810's outbox. |
| T313 | **OWNER** | 2400 plus `telegraph_history_bound_enabled`. The row already says this row cannot move from inside the tree. |
| T348 | **OWNER** | The unsend operation is written and capped by 2810's flag; once on, the counter measures it (bounded by the same absent sink as every other SLO). |
| T362 | **OWNER** | The group case is 2400's flag (T211); the DM case is vacuous because no add-to-DM operation exists. |
| T390 | **OWNER** | The flag and the column; the add-to-DM clause is vacuous because no such operation exists. |
| T444 | **OWNER** | `telegraph_history_bound_enabled`, seeded FALSE. |
| T80 | **BOTH** | `message_edits` is 2811 (owner) AND the edit route overwrites `body` in place (branch). |
| T142 | **BOTH** | 2811's `message_edits` (owner) AND the edit route still overwrites in place (branch). |
| T144 | **BOTH** | 2811's `message_attachments` (owner) AND `messages.media_url` is still the live write path (branch). |
| T147 | **BOTH** | 2811's `conversation_action_refs` (owner) AND nothing writes it (branch). |
| T154 | **BOTH** | 2810's outbox (owner) AND nothing drains it (branch). |
| T158 | **BOTH** | `payload_version` / `event_version` are capped; the live card path is still unversioned JSON (branch). |
| T196 | **BOTH** | The dedupe key is capped (owner) AND the idempotent consumer does not exist (branch). |
| T221 | **BOTH** | Registering the upload in `media_assets` is branch work; pointing a message at it needs 2811's `message_attachments`. |
| T228 | **BOTH** | 2810's sequence (owner) AND every shipped reader still orders by `created_at` (branch). |
| T231 | **BOTH** | The partial unique index is capped AND `routes/messaging.ts` does not send an idempotency key. |
| T369 | **BOTH** | 2810's outbox is the durable log (owner) AND nothing drains it into one (branch). |
| T385 | **BOTH** | Version history is T80's: 2811's table plus the route change. |
| T3 | BRANCH | MEDIA is the one §5 family with no shareable loader. `media_assets` exists; the loader does not. |
| T4 | BRANCH | The rail has no `memories` resolver. OWNER DECISION on private-by-default before it is written. |
| T6 | BRANCH | Navigation handoff is a client action over place data that already resolves. |
| T11 | BRANCH | Separating unresolved actions into a layer is client composition over kinds that exist. |
| T12 | BRANCH | The coordination surface is a panel; making it a thread mode that quiets the stream is client work. |
| T31 | BRANCH | `lib/protectedLocations.ts` exists, is fail-closed, and NOTHING IN TELEGRAPH CALLS IT. A missing consumer, nothing else. |
| T35 | BRANCH | Four legacy producers still write bespoke JSON. Moving them onto the contract is pure code. |
| T36 | BRANCH | Highlight and Stamp loaders. Both domains exist; neither has a `shareableFor` arm. |
| T37 | BRANCH | Route, reservation-safe derivative and layover-plan loaders. |
| T38 | BRANCH | NEIGHBORHOOD has no loader by choice; giving it one is a loader. |
| T39 | BRANCH | Visa Buddy card and a standalone Buddy-profile share are loaders. |
| T79 | BRANCH | `routes/messaging.ts` returns media_url/thumbnail/type/duration on a deleted message. Four lines, and a live asset leak. |
| T104 | BRANCH | Route display and in-thread availability-conflict detection over data that already resolves. |
| T106 | BRANCH | A next-step surface is client work over the coordination projection. |
| T108 | BRANCH | A closeout surface at COMPLETE is client work. |
| T123 | BRANCH | "Adoption is the remaining work, not construction" — the dark palette and hook exist; three surfaces still import the static `TG`. |
| T124 | BRANCH | Accent usage inside components that already have the resolver. |
| T157 | BRANCH | A versioned payload envelope inside `body` is pure code — §6.2's kinds already do exactly that with `envelopeVersion`. |
| T166 | BRANCH | §8's DECISION/VOTE kinds now exist on the coordination route; exposing CREATE_DECISION as a §13.1 command is wiring, not a store. |
| T169 | BRANCH | §9.1's seven quick states, the COORDINATION kind and the route all exist. Fixed in part this pass: the command endpoint no longer claims nothing implements it. |
| T170 | BRANCH | SHARE_LOCATION exists as a coordination ACTION_PROPOSAL and outside Telegraph; a Telegraph-owned command is wiring. |
| T201 | BRANCH | An add-participant operation is code over `message_thread_members`; nothing storage-shaped is missing. |
| T218 | BRANCH | Every affordance exists; nothing reorders them. Promotion under safety mode is client layout. |
| T220 | BRANCH | Eight modules outside the shared helpers query `blocks` with their own pairwise logic. Consolidation is code — in files several lanes hold. |
| T262 | BRANCH | TRIP is now shareable (T37), so "no shared Trip card" is stale; today/next context and Trip Kernel commands are wiring over Trips' own surfaces. |
| T264 | BRANCH | Attendance, live status and timing-change surfaces over an events domain that exists. |
| T265 | BRANCH | "Meet here" from a card is an action. The live-intelligence half is no longer blocked: T46 is C and both cards re-resolve. |
| T268 | BRANCH | Evidence correction: T119 and T121 are C, so "one of four, and it is broken" is stale. Safe-share derivatives are the remaining half and they are loaders. |
| T271 | BRANCH | A contextual shared map in a thread and a route share are surfaces over data that exists. |
| T290 | BRANCH | Evidence correction: §14.1's capabilities are C (T207), so a permissions block on the projection is composition of things that exist. |
| T295 | BRANCH | Six client-side joins of messaging tables. Client files, several lanes. |
| T319 | BRANCH | Making the trip-membership write and the thread-membership write one transaction is code — in Trips-owned routes. |
| T320 | BRANCH | `BookingMilestoneMessage.tsx` contains no fetch and no effect; re-deriving is client work. |
| T344 | BRANCH | Four dropped-error reads in `routes/messaging.ts`. A contested file, not an absent capability. |
| T349 | BRANCH | The emitter belongs in `services/safeReturn/SafeReturnPrivacyGuard.ts` — another lane's file, not an absent capability. |
| T359 | BRANCH | Evidence correction: "Violated at the card" is CLOSED — both named cards re-resolve per viewer through `useShareRevocation`. What remains is the four legacy producers (T35). |
| T363 | BRANCH | The four dropped-error reads, as T344. |
| T379 | BRANCH | A canonical `TelegraphRelationship` folding four existing resolvers. Pure code over tables that exist. |
| T381 | BRANCH | Evidence correction: "the input to ConversationPolicy half has no referent (T207)" is stale — T207 is C. Wiring the relationship term into it is code. |
| T388 | BRANCH | Evidence correction: search (T272) and the drawer (T66) are C. What remains is media surviving deletion — T79's four lines. |
| T396 | BRANCH | Evidence correction: six ordered bands DO exist (`ATTENTION_BANDS`) and drive real suppression windows — but they are §19's ladder, not §30A.6's. OWNER DECISION: the spec states two different six-level ladders and they disagree at P3/P4/P5. |
| T397 | BRANCH | A causal-event identity shared across categories is pure code in the dedupe service. |
| T409 | BRANCH | Evidence correction: preview, current state, actions, search behaviour and revocation ALL exist now for object types (T41, T46, T272). Joining them to the message-type registry is composition. |
| T410 | BRANCH | An action registry and a compensate hook are pure code over the existing orchestration. |
| T411 | BRANCH | Evidence correction: the card no longer authorizes a revoked action — it degrades. What remains is deriving the ACTION ROW from current capabilities, which is client code. |
| T413 | BRANCH | Evidence correction: the card re-resolves availability. What remains is rendering `resolved.projection` rather than the sender's snapshot — client code. |
| T423 | BRANCH | RTL layout and locale-sensitive formatting are pure client code. No storage, no flag. |
| T430 | BRANCH | A safe generic fallback that does not print raw JSON is client code over the existing two fallbacks. |
| T438 | BRANCH | The messaging tree's remaining dropped-error reads, as T344. |
| T445 | BRANCH | Evidence correction: the frozen card no longer outlives the source's authorization (T46 is C). What remains is the four legacy producers and the share projection's action set. |
| T448 | BRANCH | Evidence correction: the card is re-resolved for availability. Rendering current operational state rather than the snapshot is client code. |
| T2 | NEITHER | Voice: no audio MIME anywhere and no migration widens `messages.media_type`. Reactions and unsend inside this row ARE owner-capped (2810/2811); voice is not. |
| T5 | NEITHER | No proximity layer exists in either tree. |
| T8 | NEITHER | §2.1's available-nearby band needs Nearby, which has no referent. |
| T22 | NEITHER | NEARBY has no referent, so the four-way separation cannot become four-way. |
| T23 | NEITHER | `audiencePolicyId` / `proximityVisibility` / `geographyScope` need columns on Passport's table that no migration adds. |
| T27 | NEITHER | No ETA concept exists to gate. |
| T30 | NEITHER | The proximity half is vacuous; there are no proximity surfaces to remove anybody from. |
| T32 | NEITHER | Who's Around as a surface needs an open-plan and event source that does not exist. |
| T33 | NEITHER | Discoverable strangers has no implementation to separate from. |
| T40 | NEITHER | Voice, GIF and file media kinds need MIME and storage widening that exists in no migration. |
| T45 | NEITHER | Transcript, preview, caption and embedding layers do not exist anywhere. |
| T47 | NEITHER | Two of the three inoperable entries (GIF provider, voice asset type) do not exist; the Portava object picker alone is BRANCH. |
| T64 | NEITHER | No GIF provider exists to obtain a GIF from. The data-saver half is BRANCH: `hooks/useDataSaver.ts` already holds the app-level setting the renderer takes as a bare prop. |
| T69 | NEITHER | DELIVERED needs per-recipient storage that no migration writes. |
| T70 | NEITHER | Message-level seen needs per-message receipts that do not exist. |
| T73 | NEITHER | DELIVERED cannot be reported at all, so two of three is the ceiling. |
| T77 | NEITHER | A transactional lock needs a SECURITY DEFINER function that no migration in this tree writes. |
| T84 | NEITHER | A cross-thread queryable commitment store needs a table nobody has written. |
| T85 | NEITHER | A session ENTITY needs a table nobody has written — the row says so itself. |
| T107 | NEITHER | Shared transport does not exist in either tree. |
| T138 | NEITHER | Policy id and version columns are in no migration. |
| T140 | NEITHER | 2813 caps the provenance half; the INTENT half has no column in any migration. |
| T146 | NEITHER | A queryable decision STORE needs a table. (Evidence correction: the analogue is no longer the meetup triple — §8's DECISION/VOTE projection is.) |
| T148 | NEITHER | `availability_signals` as Telegraph's own contract needs storage. (Evidence correction: "Telegraph never reads it" is stale — T28 shows it now does.) |
| T149 | NEITHER | No `purpose` column on any location-share table in any migration. |
| T151 | NEITHER | Conversation-scoped presence needs a store that does not exist. |
| T153 | NEITHER | `message_reports` / `thread_reports` are hash-frozen orphans; no branch change makes them the writer. |
| T179 | NEITHER | A per-message seen fact needs per-message receipts that do not exist. |
| T200 | NEITHER | No store can express exact location, so the capability is structurally false. |
| T202 | NEITHER | §20 forbids payment requests in Telegraph; the capability is permanently false BY DESIGN. An owner product decision, not a build. |
| T204 | NEITHER | No broadcast primitive exists and §14.1 records the refusal deliberately. |
| T214 | NEITHER | `purpose` and the LIVE/RECENT/LAST_KNOWN/EXPIRED vocabulary need columns nobody has written. |
| T215 | NEITHER | Same: nothing binds a grant to a purpose because no share row carries one. |
| T217 | NEITHER | A conversation-level safety mode does not exist in either tree. |
| T219 | NEITHER | Nearby and Bump have no referent, so three of eight cannot be enforced. |
| T222 | NEITHER | A streamable rendition does not exist for any surface. |
| T224 | NEITHER | Adaptive renditions do not exist for any surface. |
| T234 | NEITHER | Delivery has no state to converge. |
| T239 | NEITHER | No bandwidth SIGNAL exists; the ladder is driven by a person's setting. |
| T240 | NEITHER | `providerVersion` and `confidence` need columns nobody has written. |
| T242 | NEITHER | There is no confidence value to threshold on (T240). |
| T255 | NEITHER | The remaining question is what §19's "immediate/high priority" should mean in delivery — an owner product decision, not a deploy and not code. |
| T257 | NEITHER | The server does not observe upload duration or app state, and inventing the signal would be worse than the gap. |
| T259 | NEITHER | Server-side load shedding does not exist anywhere in the tree. |
| T263 | NEITHER | Plan dependencies do not exist as a concept. |
| T267 | NEITHER | Meeting tools (T248) and catch-up do not exist. |
| T274 | NEITHER | Transcripts need a voice pipeline that does not exist. |
| T278 | NEITHER | 2813 caps the storage half, but five of the six origins are unverifiable in principle — the row says so and no deploy changes it. |
| T281 | NEITHER | No reputation feed exists and there is no file kind to scan. |
| T286 | NEITHER | A client directory layout nobody intends to create; deliberately unenforced. |
| T287 | NEITHER | A server package split this repository does not use; deliberately unenforced. |
| T289 | NEITHER | The Now band and the nearby summary have no source. |
| T303 | NEITHER | Delivery (T69) binds; seen, unsend and idempotency are capped or absent behind it. |
| T304 | NEITHER | Evidence correction: the contract (T41), the drawer (T66) and object-aware search (T272) are ALL C — three of the four named blockers are gone. Rich media's voice half still binds. |
| T307 | NEITHER | Coordination sessions need a table. |
| T308 | NEITHER | The voice transcript binds. Evidence correction: thread tools now exist (`compass/TelegraphConversationTools.ts`). |
| T309 | NEITHER | Captions and advanced proximity have no referent. |
| T347 | NEITHER | A true count needs a durable telemetry sink; Telegraph has none, deployed or undeployed. |
| T351 | NEITHER | Four of six projections do not exist, and their inputs (Nearby, receipts) do not either. |
| T354 | NEITHER | Whether anybody actually met is not in this system and cannot be put there by a deploy. |
| T356 | NEITHER | Purpose is not bound to a share row and no migration binds it. |
| T368 | NEITHER | Nearby and Bump have no referent. |
| T370 | NEITHER | Delivery (T69) binds; reactions and unsend behind it are owner-capped. |
| T371 | NEITHER | Voice binds. Evidence correction: Memory Note now renders (T119/T121 are C). |
| T373 | NEITHER | There is no Nearby, so "only eligible users appear" stays vacuous. |
| T374 | NEITHER | Coordination sessions (T85) bind. |
| T375 | NEITHER | Source-object authorization (T318) binds and is itself unresolved; membership history is separately owner-capped. |
| T383 | NEITHER | Reachability as a concept needs Nearby. The client-recompute half alone is BRANCH (T295). |
| T386 | NEITHER | Five of the seven operations need storage or features that exist nowhere. |
| T389 | NEITHER | 2400 caps `visible_from_at`, but `removed_at` is in no migration at all. |
| T391 | NEITHER | Five roles need a CHECK change that no migration makes. |
| T395 | NEITHER | A COORDINATION notification cause needs coordination sessions. |
| T398 | NEITHER | ALL / MENTIONS / IMPORTANT / temporary mute need per-thread policy storage. |
| T399 | NEITHER | Six of the seven `TelegraphDevice` fields need columns nobody has written. |
| T401 | NEITHER | Device-scoped location and push, and credential rotation, need storage that does not exist. |
| T402 | NEITHER | Quarantine and security scanning do not exist in any form. |
| T412 | NEITHER | The domain event is owner-capped (T195) and the projection update does not exist (T291-T294). |
| T418 | NEITHER | Burst (T279), duplicate-message (T231) and malicious-link (T281) signals have no source. |
| T419 | NEITHER | Per-user send limiting (T279) does not exist and the Nearby clause is vacuous. |
| T420 | NEITHER | Four of five proximity defenses have no referent in Telegraph. |
| T421 | NEITHER | Nearby and Invisible have no referent. |
| T422 | NEITHER | Captions and waveform alternatives need voice. Reduced motion alone is BRANCH — the Wall already proves the platform supports it. |
| T426 | NEITHER | The media storage tiers (T222) do not exist. |
| T428 | NEITHER | The four absent projections cannot be rebuildable. |
| T432 | NEITHER | Six of the ten measurements have no referent and four of those exist nowhere in the tree. |
| T435 | NEITHER | A durable audit row needs either a migration nobody has written or a mislabelled `record_type`. |
| T440 | NEITHER | World context needs Nearby/proximity; conversation context needs the reachability model. |
| T443 | NEITHER | Proximity does not exist as a capability. |
| T451 | NEITHER | The Context Kernel (T439) needs proximity, and the outcome loop needs real-world outcomes nothing can observe. |

### 13.5 What the split found: two affordances that were drawn and inert

Reading the 51 NOT-BUILT rows against the tree turned up something the split was
not looking for. §11 shipped §6.2's ANNOUNCEMENT kind — a zod payload with
`requiresAcknowledgement`, a route, a subtype, a renderer, drawer and search
classification, and tests — and §5's row for it, T58, was moved to **C** on the
strength of a renderer that draws an acknowledge control "only when it asks for
one".

The control called an `onAcknowledge` prop. **No mount in the application passed
one.** The single surface that renders typed kinds, the conversation screen,
passed `msgType`, `body` and `mine` and nothing else. Pressing "Got it" did
nothing, on every announcement, on every deployment. The same is true of the
ACTION kind's "Confirm" button, which called an `onPressAction` that no mount
passed either.

The existing component test asserted the acknowledge button EXISTED. It never
asserted it did anything, and it passed for as long as the button was dead. That
is the shape of a worthless test, and it is recorded here rather than quietly
replaced.

Two further facts, found while fixing it:

1. **Nothing in the app could send an ANNOUNCEMENT.** §6.1's composer menu is the
   spec's eight entries (`travel-buddy-standalone/src/features/telegraph/composer/composerMenu.ts:48#export const COMPOSER_ENTRIES`)
   and ANNOUNCEMENT is not among them, correctly — §6.1 does not list it. So the
   whole kind was reachable only by calling the API by hand. T58's C was
   VACUOUS on both halves: no producer, and a dead consumer.
2. **The §13.1 command endpoint was telling callers a lie.**
   `SET_COORDINATION_STATUS` sat in `UNIMPLEMENTED_COMMANDS` with the comment
   "§9.1 vocabulary does not exist (census T169)", so the endpoint answered 501
   *"nothing in this repository implements it"* — while §9's coordination surface,
   the seven `COORDINATION_QUICK_STATES`, the COORDINATION message kind and
   `POST /threads/:id/coordination` were implementing exactly it. A refusal wrong
   in that direction sends a caller away from the route that would have worked.

### 13.6 What was built

**§19's acknowledgement, as a projection over the thread's own messages.** No
migration, no flag, no new table — it uses `public.messages`, which every
deployment has. That is deliberate: 2810–2813 are the demonstration of what a
side table costs, and Appendix A's rule is that a spec's schema name is an
architectural name, not permission to create a table when a canonical structure
exists. §8's commitments and decisions are already carried this way.

| piece | where |
| --- | --- |
| The payload | `artifacts/api-server/src/services/telegraph/coordination.ts:452#export const AcknowledgementPayload` |
| The eighth coordination kind | `artifacts/api-server/src/services/telegraph/coordination.ts:918#ACKNOWLEDGEMENT` |
| The projection | `artifacts/api-server/src/services/telegraph/coordination.ts:504#export function projectAcknowledgements` |
| The write, and its four refusals | `artifacts/api-server/src/routes/telegraphCoordination.ts:429#did not ask to be acknowledged` |
| The announcement reader (one answer for every reason a caller must not distinguish) | `artifacts/api-server/src/routes/telegraphCoordination.ts:127#function readAnnouncementRow` |
| The read | `artifacts/api-server/src/routes/telegraphCoordination.ts:859#/threads/:threadId/announcements` |
| The client hook, one fetch per thread | `travel-buddy-standalone/src/features/telegraph/kinds/useAnnouncementAcknowledgement.ts:70#export function useAnnouncementAcknowledgement` |
| The API call | `travel-buddy-standalone/src/features/telegraph/coordination/coordinationApi.ts:195#export async function acknowledgeAnnouncement` |
| The mount that was missing | `travel-buddy-standalone/app/messages/[id].tsx:794#useAnnouncementAcknowledgement({` |
| The producer — an announcement composer on the coordination panel | `travel-buddy-standalone/src/features/telegraph/coordination/CoordinationPanel.tsx:250#telegraph-announcement-open` |
| The renderer refusing to draw a button it cannot honour | `travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:164#telegraph-kind-announcement-ack-unavailable` |
| The same, for ACTION's Confirm | `travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:129#telegraph-kind-action-unconfirmable` |
| `SET_COORDINATION_STATUS` pointed at the route that implements it | `artifacts/api-server/src/domain/telegraph/commands/telegraphCommands.ts:148#SET_COORDINATION_STATUS:` |

**The rules that make it §19 rather than a second read receipt**, each asserted:

- The FIRST acknowledgement by a person wins. Pressing twice does not move the
  timestamp.
- `outstanding` is **null**, never `[]`, when the roster could not be read or when
  the announcement did not ask to be acknowledged. An empty list reads as
  "everybody has acknowledged", which is the one answer this must not invent.
- The announcer is not outstanding on their own announcement.
- An acknowledgement naming a message in another conversation, a tombstone, a
  message that is not an announcement, or one outside this member's §14.3 window
  all answer 404 — the same answer, because "that message exists but you cannot
  see it" is itself a disclosure.
- **It cannot become Seen.** `projectAcknowledgements` takes announcements,
  acknowledgement MESSAGES and a roster; there is no parameter a read receipt
  could arrive through, and the module names no receipt column. The test asserts
  the arity AND scans the module's code (comments stripped) for `last_read_at`
  (`artifacts/api-server/src/test/telegraphCoordination.test.ts:812#is STRUCTURALLY unable to derive an acknowledgement from a read receipt`),
  so a later "helpful" change that fills the gap from the read receipt goes red.

### 13.7 The mutations, and what went red

Thirteen. Each applied, run, reverted, and the file compared byte-for-byte
against its backup with `filecmp` — every one restored identical.

| # | mutation | result |
| --- | --- | --- |
| M1 | the route drops the `requiresAcknowledgement` refusal | 58 pass / 1 fail — "refuses an announcement that did not ask to be acknowledged" |
| M2 | the projection keeps the LAST acknowledgement, not the first | 58 / 1 — "the FIRST acknowledgement by a person wins" |
| M3 | **STAYED GREEN.** The `known.has(target)` filter deleted | 59 / 0 |
| M3b | the projection falls back to SOME bucket when this announcement has none | 58 / 1 — "an acknowledgement naming a message this projection never saw is DROPPED" |
| M4 | the announcer counts as outstanding on their own announcement | 55 / 4 |
| M5 | the target read stops binding `thread_id` | 58 / 1 — "refuses an announcement in ANOTHER conversation" |
| M6 | an unknown roster reports an empty `outstanding` list | 56 / 3 |
| C1 | the conversation screen stops passing a handler — *the state before this pass* | 14 / 1 — "the conversation screen actually passes a handler" |
| C2 | the button is drawn even when no handler exists — *the old renderer* | 14 / 1 — "ANNOUNCEMENT draws NO button when the surface cannot acknowledge" |
| C3 | the notice always asks for confirmation, whatever the sender chose | 15 / 1 |
| C4 | an empty notice is posted instead of refused | 15 / 1 |
| C5 | a refused post clears the text the sender typed | 15 / 1 |
| C6 | `SET_COORDINATION_STATUS` goes back to "nothing implements it" | 19 / 2 |
| C7 | the ACTION confirm button is drawn again with no handler | 15 / 1 |

**M3 is the one worth reading.** The projection had a `known.has(target)` filter
that dropped an acknowledgement naming a message the projection had not seen.
Deleting it left every test green — the filter was **decoration**, because the
output is keyed by the announcements passed in and never by what an
acknowledgement claims to answer, so an unknown-target bucket can never be read.
A guard with no observable effect is not defence in depth, it is something a
later reader will trust. It was deleted, and M3b is the mutation that does
matter: making the lookup fall back to another announcement's bucket goes red.

### 13.8 Corrections to earlier sections — rows whose stated blocker no longer exists

Sections are append-only, so these are stated here rather than edited above.
Each was read against the tree at `3eaf2436f`, not inferred from another row.

| row | what its evidence says | what the tree says |
| --- | --- | --- |
| T359, T411, T413, T445, T448 | "Violated at the card" — shared cards are frozen JSON, no refetch, no authorization call | **Closed.** Both named cards re-resolve per viewer on mount through `travel-buddy-standalone/src/features/telegraph/sharing/useShareRevocation.ts:50#export function useShareRevocation` and render a revoked notice instead of the snapshot. T46 was moved to C in §10.5 for exactly this; the five rows that cite the old violation were written before it and were never restated. All five stay W — each has a second half open — but not for the reason they give. |
| T304 | "No contract (T41), no drawer (T66), no search (T272)" | All three are **C**. Three of the four named blockers are gone; the row is 3-of-4, not 1-of-4. It stays W and NEITHER on rich media's voice half. |
| T388 | "there is no search (T272) or drawer (T66) to remove from" | Both exist. What remains is media surviving deletion, which is T79's four lines. |
| T148, T28 | "Telegraph never reads it (T28)" | Telegraph reads availability now (T28's own §10 restatement). T148 stays W for a different reason: `availability_signals` as Telegraph's own contract needs storage. |
| T146 | "The meetup triple is the analogue; there is no general decision store" | The analogue is now §8's DECISION/VOTE projection on the coordination route. Still W: a projection over one thread is not a queryable store, exactly as T84 says. |
| T169 | "not a conversation command and not the §9.1 vocabulary" | §9.1's seven states, the COORDINATION kind and the route all exist. Fixed in part by this pass: `SET_COORDINATION_STATUS` now names the route instead of claiming nothing implements it. Stays W — it is a legacy-path command, not a §13.1 command bus command, the same state as T166. |
| T396 | "Four levels, not six" | Six ordered bands DO exist (`artifacts/api-server/src/domain/telegraph/policies/attentionLadder.ts:63#export const ATTENTION_BANDS`) and drive real per-band suppression windows. It stays W for a reason the row does not give, and that reason is an owner decision — see §13.11. |
| T58 | moved to **C** in §11 as a kind "rendered with the acknowledge control only when it asks for one" | The control was inert and the kind had no producer. Both are closed by this pass, so T58's C is no longer vacuous. Had this pass not built them, T58 belonged at W. |
| T72 | cites a baseline line for "no delivered counterpart" | 2810/2811 add the pair; T139 restates the same substrate. Classified OWNER on that basis, not on the stale citation. |

### 13.9 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T261 | N | **C** | §19 acknowledgement, distinct from passive Seen, on every deployment — no migration and no flag. A person presses "Got it" on an announcement that asked for one; the fact is a message, and `projectAcknowledgements` answers who has and who is outstanding. The separation from Seen is asserted structurally, not described. Reachability, stated because a C over an unreachable path is worthless: the producer is the coordination panel, which renders only while the thread is coordinating or has an open decision or commitment. |
| T392 | N | **C** | §30A.5's ANNOUNCEMENT message type. The type existed end to end before this pass except that nothing could send one and its acknowledge control was inert; both are now closed and both are asserted by a test that goes red if either regresses. |

Two rows, and that is the honest yield of a pass whose main product is the split
above. Nothing else in the 51 moved: **44 of the 51 need storage or a subsystem
nobody has written**, and the remaining five (T291–T294's projections, T318) are
bounded by inputs — the missing permissions block, a receipt projection, Nearby —
that this lane does not hold.

### 13.10 The restated headline

> **RESTATED 2026-09-13 BY THE §13 LANE, from the merged rows and not by
> addition: C 209 → 211, W 176 → 176, N 51 → 49, X 3. CONSTRUCTED
> (211+176)/451 = 85.8 %, CORRECT 211/451 = 46.8 %.** Two NOT-BUILT rows moved to
> BUILT-AND-CORRECT (T261, T392); no row moved into or out of BUILT-BUT-WRONG.
> The 12 requirements this census counts in prose rather than in a verdict table
> are unchanged and are still not machine-checkable, so 439 of the 451 are.
>
> **The 176 BUILT-BUT-WRONG, split for the first time: 24 are the OWNER'S ALONE
> — a migration and a flag, no code. 12 need an owner deploy AND a branch change.
> 51 are a branch's to fix today, with no new storage and no flag. 89 are blocked
> on something that exists in neither tree.** So 36 of the 176 sit behind the
> owner's release, 51 sit behind this repository, and 89 sit behind work nobody
> has started. Row-by-row assignment is §13.4.
>
> **What this number is not.** It is still a BRANCH census, and this section's
> own two moves are on an unmerged worktree branch. MERGED IS NOT DEPLOYED;
> DEPLOYED IS NOT FLAG ENABLED. Migrations 2810–2813 exist in no database, every
> flag they add is seeded FALSE, and on every live deployment today reported
> content is still destroyed when its author deletes it. Nothing here is 100 %
> and nothing here is production-realised.

### 13.11 Owner decisions surfaced, not taken

1. **The object-share route spans `memories`, a private-by-default domain.** It is
   declared PRIVATE_SOURCE in
   `artifacts/api-server/src/domain/telegraph/policies/shareAuthorizationPolicy.ts:298#TELEGRAPH_DYNAMIC_SHARE_PRODUCERS`
   with a note that it does NOT call `authorizeTelegraphShare`; its real gate is
   the per-object loader refusing a memory the viewer cannot already see. Wiring
   the policy in would refuse EVERY memory share, because no derivative grant
   exists anywhere in the tree. Left as it is. T4's BRANCH classification depends
   on this: a `memories` resolver for the rail is a few hours of code and it is
   not ours to decide it should exist.
2. **`check:telegraph-package-boundaries` permits a Telegraph policy to import
   Trust's `TrustRestrictionService`**, because consuming Trust's canonical decider
   is what census-trust A17 asks for. Left exactly as it is.
3. **NEW: the spec states two different six-level attention ladders and they
   disagree.** §19's is P0 Safety / P1 Coordination / P2 Message / P3 Media /
   P4 Ephemeral / P5 AI. §30A.6's is P0 SAFETY / P1 ACTIVE_COORDINATION /
   P2 DIRECT_OR_MENTION / P3 PLAN_OR_TRIP / P4 NORMAL_GROUP / P5
   REACTION_OR_PASSIVE. They agree at P0–P2 and disagree at P3, P4 and P5. §11.8
   built §19's, correctly and with real suppression windows behind it — which is
   why T396 (§30A.6's row) stays W with six bands sitting in the tree. Making one
   ladder satisfy both would require deciding which the product means, and that
   is not a census's call. T396 is classified BRANCH on the assumption that the
   answer is "reconcile them"; if the answer is "they are two ladders for two
   purposes", T396 is a documentation fix and not a build at all.
4. **The retention schedule for `telegraph_report_evidence`** — `retention_until`
   is NULL and nothing purges, deliberately. Restated here because it is one of
   the two things standing between T283/T284 and a deployment, and the other one
   is the migration.

### 13.12 The ceiling on §13

What is NOT reachable from this section, and why:

1. **The 24 OWNER rows and the deploy half of the 12 BOTH rows.** Not reachable
   from any branch, by construction. That is the point of naming them.
2. **The full test suite did not run to completion for this section.** It was
   started and cut off at forty minutes by the machine's own contention; the
   integrator runs it once per lane. What DID run: every test file this section
   changed, individually and green (`telegraphCoordination.test.ts` 59/59,
   `telegraphCommandRoute.test.ts` 21/21, the client component suite 509 suites /
   3074 tests / 0 failed / 0 skipped), plus `typecheck`, `typecheck:tests` at its
   864/116 baseline, root eslint at 0 errors, `check:doc-citations` clean,
   `check:telegraph-share-producers`, `check:telegraph-inventory` (regenerated),
   `check:telegraph-slos`, `check:telegraph-certification`,
   `check:telegraph-package-boundaries` and `check:guard-reachability`. **A green
   partial run is not a green run and this section does not claim one.**
3. **The acknowledgement is not live.** `useAnnouncementAcknowledgement` does not
   subscribe: somebody else's acknowledgement appears on the next fetch, not on
   the SSE event. That is a refresh delay, not a wrong answer, and it is stated
   in the hook itself rather than left to be discovered.
4. **The announcement producer is narrow.** An announcement can be composed only
   from the coordination panel, which appears only while a thread is coordinating
   or has an open decision or commitment. §6.1's composer menu is the spec's
   eight entries and adding a ninth would be inventing one. A thread that is not
   coordinating still cannot post a notice, and T392's C is a claim about the
   TYPE, not about ubiquitous reach.
5. **The ACTION kind's Confirm control is still not wired, and this pass did not
   wire it.** A typed ACTION message carries no command id, so there is nothing
   for `/telegraph/commands/:id/confirm-action` to execute. The button now says
   "Confirmation is not available on this screen" instead of doing nothing
   silently. That is smaller than a fix and larger than nothing, and T11 stays W.
6. **The split itself is a judgement, not a measurement.** `check:census-integrity`
   verifies that the document agrees with itself; nothing verifies that a row
   marked OWNER really would go C on a deploy. The tie-break makes the errors
   land in the safe direction — a row that could have been OWNER shows as NEITHER,
   never the reverse — but there is no test for it, and the first person to apply
   2810 to a real database will find out how good it is.


## 14. The 51 BRANCH rows, executed — a live asset leak, an inbox that reported empty when it could not read, and one row §13 put in the wrong group

`head_commit: f8384ea5b` — the base this section measured and built on. Every
verdict below was read against that tree. The code this section adds sits on
branch `worktree-agent-a4a2f8177de29834a`, which is not merged, not deployed and
not flag enabled.

§13 split the 176 BUILT-BUT-WRONG rows and named 51 as BRANCH: closeable by code
in this tree, with no new storage and no flag. §13 then built two rows and left
the 51 as a work list. This section takes the work list, spot-checks the
classification against the code, and builds what it can finish and prove.

### 14.1 The classification, spot-checked

§13.12 says the split "is a judgement, not a measurement" and that "nothing
verifies that a row marked OWNER really would go C on a deploy". Five of the 51
BRANCH rows were therefore re-derived against the tree before any of them was
built. Four hold. One does not, and it is the one §13.4 described most
confidently.

| row | §13.4 said | what the tree says |
| --- | --- | --- |
| T79 | "`routes/messaging.ts` returns media_url/thumbnail/type/duration on a deleted message. Four lines." | **Exactly right, and it was exactly four lines.** Confirmed at the serializer and confirmed to be the ONLY leaking surface: search filters in the query (`artifacts/api-server/src/services/telegraphSearch.ts:169#// §21: deleted objects are excluded in the QUERY`), the drawer filters (`artifacts/api-server/src/routes/telegraphKinds.ts:149#.is("deleted_at", null)`), the inbox preview filters, saved messages filters, and both Memory Note paths refuse a tombstone. |
| T344 | "Four dropped-error reads in `routes/messaging.ts`. A contested file, not an absent capability." | BRANCH is right and "contested" is stale — no other lane holds the file now. But the EVIDENCE is incomplete in a way that matters: see §14.3. |
| T123 | "the dark palette and hook exist; three surfaces still import the static `TG`." | BRANCH is right. "Three surfaces" is not: **eleven** production modules import `TG` from `travel-buddy-standalone/src/theme/telegraphTokens.ts:10#export const TG`, including one this section had to touch for a different reason (`travel-buddy-standalone/src/components/TelegraphSystemNotice.tsx:23#import { TG } from '../theme/telegraphTokens.ts';`). §10's restatement said "the inbox, the conversation shell and the message bubbles", which are three CATEGORIES; §13.4 read them as three files. The work is larger than the row implies and it is structural rather than mechanical — `StyleSheet.create` runs at module scope and cannot consume a hook, so each of the eleven needs its styles moved inside the component. |
| T430 | "A safe generic fallback that does not print raw JSON is client code over the existing two fallbacks." | Right, and there are **three** mounts of the first fallback, not two: `GroupChatScreen` routes EVERY system message through the pill, including the card subtypes the conversation screen intercepts first. Built — §14.2. |
| T31 | "`lib/protectedLocations.ts` exists, is fail-closed, and NOTHING IN TELEGRAPH CALLS IT. A missing consumer, nothing else." | **MISCLASSIFIED.** The consumer half is right — `applyProtection` (`artifacts/api-server/src/lib/protectedLocations.ts:860#export function applyProtection`) has no Telegraph caller. But the zones it evaluates live in `protected_zones`, created by `artifacts/api-server/src/migrations/2217_protected_locations.sql:1#-- 2217_protected_locations.sql`, and that table **is in no database**: it does not appear in `baseline/20260907_production_tables.txt`, the 431-table production inventory §8 settles other deployment facts against, while `artifacts/api-server/baseline/20260907_production_tables.txt:147#geo_zones` and `plan_geofences` do. So T31 needs an owner deploy AND a branch change, which is §13.1's definition of **BOTH**, not BRANCH. See §14.5. |

### 14.2 What was built

Three things, in two packages, with no migration, no flag and no new table.

**§7.2 / T79 — deleting a photo now deletes the photo.** The thread-read
serializer suppressed `body` on `deleted_at` and returned the four media
columns unconditionally, so deleting a photo redacted the caption and left the
asset addressable at a directly fetchable URL. The tombstone still says a
message was here — `deleted: true`, its id, its sender and its time all survive,
because §7.2 removes the CONTENT and not the fact — and it now carries no route
to the content.

| piece | where |
| --- | --- |
| The four lines | `artifacts/api-server/src/routes/messaging.ts:2536#mediaUrl: isDeleted ? null : ((m as any).media_url ?? null),` |
| The assertion that does not depend on knowing the field names | `artifacts/api-server/src/test/telegraphDeletedMediaRedaction.test.ts:201#it("the deleted asset appears NOWHERE in the serialized response", async () => {` |

`mediaType` goes with the other three deliberately. "This was a video" is a fact
about the deleted content, and a renderer needs no type for a message with no
media. The fields are PRESENT and null rather than dropped: an absent field and
a null one are different contracts to an older client, and the test requires the
key to exist so a later "tidy-up" that deletes them instead goes red.

**§30A.13 / T430 — the fallback is safe, not merely present.** Two thirds of
that requirement were already true: nothing crashed and nothing disappeared. It
was not SAFE, because Telegraph's structured payloads live in `messages.body` as
a JSON string (T157) and both fallbacks rendered `body` as literal text — so a
client that met a kind it did not know showed the reader the wire format, ids
and urls included.

| piece | where |
| --- | --- |
| The rule, and why it is this narrow | `travel-buddy-standalone/src/features/telegraph/kinds/unsupportedPayload.ts:50#export function isMachinePayload` |
| The one sentence an older client can honestly say | `travel-buddy-standalone/src/features/telegraph/kinds/unsupportedPayload.ts:40#export const UNSUPPORTED_MESSAGE_TEXT` |
| Which types this build has a branch for | `travel-buddy-standalone/src/features/telegraph/kinds/unsupportedPayload.ts:117#export function rendersKnownMessageType` |
| Fallback one — the centred pill, fixed at the COMPONENT so all three of its mounts are covered | `travel-buddy-standalone/src/components/TelegraphSystemNotice.tsx:35#{safeUnknownBody(text)}` |
| Fallback two — the ordinary bubble, for a `msgType` this build has no branch for | `travel-buddy-standalone/app/messages/[id].tsx:974#if (!rendersKnownMessageType(item.msgType))` |
| The assertion that the payload is NOT on screen, which is different from "the friendly text is" | `travel-buddy-standalone/src/features/telegraph/__tests__/unsupportedPayload.component.test.tsx:74#it('the system pill does NOT print a future kind’s payload', async () => {` |
| The false positives the rule refuses to create | `travel-buddy-standalone/src/features/telegraph/__tests__/unsupportedPayload.component.test.tsx:121#it('does NOT treat what a person types as a payload', () => {` |

The rule is deliberately narrow: a body is replaced only if it starts with `{`
or `[` AND parses as JSON. `hello`, `42`, `true`, `null`, `"hi"`, `{` and
`{ not json }` all pass through as typed. And the guard is applied ONLY on paths
the client did not recognise — a plain `text` message never reaches it — so a
person who deliberately sends a JSON object as chat text still sees it.

**T344 / T438 — the inbox stops reporting empty when it cannot read.** §14.3.

### 14.3 What executing T344 found that reading it did not

T344, T363 and T438 all cite the same four reads and all spell them
`const { data: x } = await …`. So does the ratchet that measures the class:
`artifacts/api-server/src/test/telegraphRlsAuthorizationMatrix.test.ts:655#it("LDB-05: the divergence is still real — route handlers drop read errors into context", () => {`
counts that exact destructuring shape and asserts the count has not reached zero.

**The inbox's three primary reads are not spelled that way.** They are a
`Promise.all` whose results are consumed as `threadsRes.data ?? []`. Neither the
census nor the ratchet could see them, and they are the worst instance of the
defect in the file: supabase-js RESOLVES on a database error, so an unreadable
`message_threads` produced **HTTP 200 with an empty inbox**, and an unreadable
`messages` produced every thread reporting **zero unread**. Both are
indistinguishable from the truth. That is the precise sentence §30A.16 forbids,
and the measurement built to catch it was blind to it by construction — the
ratchet counts a SYNTAX, and the defect is a semantics.

| piece | where |
| --- | --- |
| The three primary reads, now a refusal | `artifacts/api-server/src/routes/messaging.ts:1968#for (const [label, r] of [` |
| The member-profile batch, now the refusal its own comment had claimed for months | `artifacts/api-server/src/routes/messaging.ts:1998#if (profileErr) {` |
| The message-request list, which returned `sender: null` for everybody | `artifacts/api-server/src/routes/messaging.ts:838#if (profilesErr) {` |
| Trip context: omitted, because `undefined` ("not known") and `null` ("this trip has no city") are different claims | `artifacts/api-server/src/routes/messaging.ts:2209#tripCity: tripCityDegraded ? undefined : tripCity,` |
| The preview says `failed` only when it failed | `artifacts/api-server/src/routes/messaging.ts:2046#let previewTranslationsDegraded = false;` |
| The thread read reports §18's own word for "we did not translate this", instead of inventing a monolingual thread | `artifacts/api-server/src/routes/messaging.ts:2333#status: 'failed' as TranslationStatusValue,` |
| The whole thing, driven end to end against the real router | `artifacts/api-server/src/test/telegraphInboxFailsLoud.test.ts:160#describe("T344/T438 — an unreadable inbox is a REFUSAL, never an empty inbox", () => {` |

Two more things the execution turned up, both recorded rather than quietly
fixed:

1. **A comment that described an intention as though it were the code.** Above
   the member-profile batch sat "Profiles are fetched as a separate batched
   query … so a schema/alias drift on the join can't silently return every
   member with no profile at all — it would surface as a hard fetch error". The
   error was destructured away on the very next line. A drift really did return
   every member with no profile, silently, and the comment is why nobody looked.
2. **A whole-table `profiles` outage was ALREADY a refusal, from somewhere
   else.** `requireUser` fails closed at 503 on an unreadable `profiles`, so a
   test that injected a whole-table failure would have been green on a refusal
   produced by a different guard. The test injects from the SECOND profiles
   operation onward instead, and a second test pins the earlier guard's
   behaviour so the first cannot later be "simplified" back into the wrong
   shape. §12's lane recorded the identical mistake against its own first
   version of RLS-04; this is the second time the same trap has been stepped in
   and the second time it has been caught only by running a mutation.

### 14.4 The mutations, and what went red

Nine. Each applied, run, reverted, and the file compared byte-for-byte with
`cmp` against a pre-mutation copy — every one restored identical.

| # | mutation | result |
| --- | --- | --- |
| A1 | the four `isDeleted ? null :` guards reverted to the unconditional reads the census found | 3 pass / 2 fail — the field assertion and the payload scan |
| B1 | `safeUnknownBody(text)` in the system pill reverted to `text` — the state before this pass | 12 / 3 |
| B2 | `isMachinePayload`'s closing `typeof parsed === 'object'` check deleted | **STAYED GREEN**, 15 / 0 |
| B3 | the first-character `{`/`[` test deleted | 14 / 1 — `42`, `true`, `null` and `"hi"` all became payloads |
| D1 | the three-read refusal loop deleted — the state before this pass | 10 / 2 |
| D2 | `tripCityDegraded ? undefined : tripCity` reverted to `tripCity` | 11 / 1 |
| D3 | the synthesised `status: 'failed'` rows in the thread read deleted | 11 / 1 |
| D4 | the member-profile refusal deleted | 11 / 1 |
| D5 | `previewTranslationStatus` made unconditional | 11 / 1 |

**B2 is the one worth reading, and it is the same shape as §13.7's M3.**
`isMachinePayload` ended with `typeof parsed === 'object' && parsed !== null`.
Deleting it left every test green — the check can never be reached and be false,
because by JSON's own grammar a value that starts with `{` or `[` and parses is
an object or an array. It was decoration. It was deleted rather than
test-covered, and B3 is the mutation that shows which line actually carries the
rule. Two sections in a row have now found a guard with no observable effect in
newly written code; that is a pattern in how this corpus is written, not an
accident, and the cure is that nothing counts as defence until a mutation of it
has been watched to fail.

**A1 and D-series are recorded with their true numbers, not rounded up.** Three
of A1's five tests stay green on purpose: the tombstone and live-media cases are
CONTROLS, and a mutation that turned them red would mean the guard had eaten the
wrong rows. D5's single failure is caught by the assertion "carries NO such
field in the normal case", which is why that assertion is not decoration — a
degraded marker that is always present says nothing.

### 14.5 Corrections to §13 — one classification, two understatements

Stated here rather than edited above, because sections are append-only.

| what | correction |
| --- | --- |
| **T31's group** | **BRANCH → BOTH.** §13.3 lists six artifacts that cap every OWNER and BOTH row and calls the list "exhaustive over the 36". It is not: `2217_protected_locations.sql` caps T31 in exactly the same way 2810 caps T139 — in the tree, in no database. A branch can write the Telegraph consumer `applyProtection` has never had; it cannot make `protected_zones` exist. The error runs in the UNSAFE direction for §13's own tie-break, which was designed so that "a row that could have been OWNER shows as NEITHER, never the reverse": here a row that needs the owner was shown as ours. The BRANCH count is 50, not 51; BOTH is 13, not 12. |
| **T31's ceiling beyond the deploy** | Worth stating because it changes what a deploy buys. 2217 ships the table EMPTY and says so at `artifacts/api-server/src/migrations/2217_protected_locations.sql:11#-- THIS TABLE SHIPS EMPTY, AND THAT IS THE POINT` — the first row is an explicit act by whoever owns the policy. So applying 2217 and writing the consumer still suppresses nothing until a named owner writes down real addresses. That is a third gate, and it is neither a deploy nor a branch. |
| **T123's size** | "Three surfaces" is eleven modules, and the change is structural rather than mechanical. Not a reclassification — still BRANCH — but a reader sizing the 51 from §13.4 will be wrong about this one by a factor of three. |
| **T430's shape** | Two fallbacks, three MOUNTS. Fixing the pill at either call site would have left `GroupChatScreen` printing payloads. |
| **T344/T363/T438's evidence** | The four named reads are not the worst instance and the ratchet that measures them cannot see the worst instance. §14.3. |

### 14.6 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T79 | W | **C** | §7.2 "remove from normal retrieval, search and projections". Retrieval was the open half and it is closed: a deleted message's `media_url`, `media_thumbnail_url`, `media_type` and `media_duration_seconds` are all null, present-and-null so an older client sees a field rather than an absence, and the whole serialized response is scanned for the asset path so a leak through any other key fails too. The other two surfaces were already closed and were re-verified rather than assumed: search excludes tombstones in the QUERY, and every projection — inbox preview, content drawer, saved messages, both Memory Note paths — filters `deleted_at IS NULL`. |
| T388 | W | **C** | §7.2's removal, stated per surface. All four the row names hold: search (query-level filter), Compass retrieval (Compass reads no message content; a report invalidates its cache), inbox projections (`deleted_at IS NULL` in the inbox query) and content drawers (same filter). "Unsent" is the same tombstone as "deleted" on the shipped path — `artifacts/api-server/src/services/telegraph/unsend.ts:240#export function unsentPatch(nowIso: string): Record<string, unknown> {` writes `deleted_at`, so every removal surface covers both by construction. The one thing that survived deletion was media, which is T79 and is now closed. |
| T430 | W | **C** | §30A.13's three properties, each asserted. Nothing crashes; nothing disappears (an EMPTY body on an unrecognised type draws the notice rather than an empty pill); and nothing prints the payload. Both fallbacks are covered and the pill is fixed at the component, so all three of its mounts are. Real prose is passed through unchanged, which is the regression this fix had to avoid and which has its own test. |
| T438 | W | **C** | §30A.16. The first half — live-DB contracts verifying columns, enum literals and RLS role behaviour — was already built and test-covered (LDB-01…LDB-06) and the census says so. The emphasized half is "schema/permission failures must never be swallowed into plausible empty **inboxes**", the one clause in the addendum that names an inbox, and both inbox endpoints now answer honestly: `GET /me/threads` refuses when `message_threads`, `messages`, `message_thread_members` or the member-profile batch is unreadable, and omits trip and booking context rather than reporting it absent; `GET /me/unread-counts` already refused on every read that feeds the unread number, and its two remaining silent reads (meetups, circle membership) now log rather than vanish. Each refusal was shown red by deleting it. |

**T344 and T363 do NOT move, and the difference between them and T438 is the
wording, not the work.** T438 names inboxes. T344 says "plausible empty
inbox/**context**" and T363 says "plausible empty **state**", and the messaging
tree still has context reads that degrade quietly: the quoted reply context now
logs but a reply whose quote could not be read is still indistinguishable on the
wire from a message that quoted nothing, and several notification-name and
language-default reads default a value rather than reporting. Both rows are
smaller than they were and neither is closed. Claiming them would be inventing a
C, and the remaining work is named here so the next lane does not have to
re-find it.

### 14.7 The restated headline

> **RESTATED 2026-09-13 BY THE §14 LANE, from the merged rows and not by
> addition: C 211 → 215, W 176 → 172, N 49, X 3. CONSTRUCTED (215+172)/451 =
> 85.8 %, CORRECT 215/451 = 47.7 %.** Four BUILT-BUT-WRONG rows moved to
> BUILT-AND-CORRECT (T79, T388, T430, T438); no row moved into
> BUILT-BUT-WRONG and no row moved out of NOT-BUILT. The gap between
> CONSTRUCTED and CORRECT — the W column, which is the whole point of the
> distinction — narrows from 39.0 points to 38.1.
>
> **The 176 split restated: OWNER 24, BOTH 13, BRANCH 50, NEITHER 89**, because
> T31 moves from BRANCH to BOTH on the evidence in §14.5. Of the 50 BRANCH rows,
> four are now C and forty-six are not.
>
> **What this number is not.** It is still a BRANCH census and this section's
> four moves are on an unmerged worktree branch. MERGED IS NOT DEPLOYED;
> DEPLOYED IS NOT FLAG ENABLED. Nothing here required a migration or a flag,
> which is the one thing that makes these four different from most of the 176 —
> they are true on every deployment the moment this branch merges. Every other
> statement §13.10 made about what is dark remains true.

### 14.8 Owner decisions surfaced, not taken

1. **`protected_zones` needs a policy owner before it needs an engineer.**
   2217 is written, unapplied, and deliberately empty. T31 cannot become true
   without three separate acts by three different parties: apply the migration,
   write the Telegraph consumer, and decide — in a named jurisdiction, under a
   named legal basis — which real-world addresses are protected. The third is
   not a build and this census should not imply it is one.
2. **The inbox's degradation contract is now two-shaped, and somebody should
   decide whether that is right.** A failure of a CORE inbox table refuses the
   whole endpoint; a failure of a CONTEXT table omits one field. The line was
   drawn where this section drew it — an inbox that cannot list conversations is
   not an inbox, whereas an inbox without trip cities is — and it follows the
   precedent `needsActionCount` already set. It is a product judgement wearing
   engineering clothes and is stated so it can be overruled cheaply.
3. **`previewTranslationStatus` is new API surface.** It is additive, omitted in
   the normal case, and uses §18's existing `failed` vocabulary rather than
   inventing a word. No client reads it yet. If the answer is "the inbox should
   never say anything about translation", deleting it costs one line and one
   test.

### 14.9 The ceiling on §14

What is NOT reachable from this section, and why:

1. **Forty-six of the fifty BRANCH rows.** This section finished four. The
   largest remaining ones were sized and left: T123 is eleven modules of
   structural refactor in files several lanes touch; T423 is eight i18n clauses
   of which two are done and RTL exists nowhere in the client; T157 and T35 are
   the same work seen from two directions — moving four legacy producers onto
   the versioned contract — and both sit in client files. None is blocked; all
   are bigger than a pass that also had to prove what it changed.
2. **T344 and T363 stay W on purpose.** §14.6 says which reads remain.
3. **LDB-05's ratchet was not re-pointed, and it should be.** It still counts
   `const { data: x } = await` in `routes/messaging.ts` and still passes,
   because roughly thirty such reads remain — most of them refusals, which the
   requirement does not forbid. So the number it reports is not a measure of the
   defect and never was. Changing it is a certification-matrix change and this
   lane does not hold that matrix; it is named here as the next honest move.
4. **The full test suite did not run to completion for this section**, by
   instruction: the machine is shared and the integrator runs it once per lane.
   What DID run, individually and green: the three test files this section
   changed or added, plus the twenty other suites that mount `messagingRouter`
   (`messaging` 22, `groupChat` 39, `telegraphRlsAuthorizationMatrix` 38,
   `telegraphHistoryBound` 20, `telegraphNeedsAction` 21, `telegraphAbuseControls`
   37, `telegraphAdversarialFixtures` 27, `accessControl` 33, `coreActions` 36,
   `exclusionFailClosedRoutes` 26, `adminPhase12` 31, and nine more), both
   packages' `typecheck`, both `typecheck:tests` at their recorded baselines
   (864/116 and 176/61), root eslint at 0 errors, `check:doc-citations` clean,
   `check:census-integrity`, `check:census-freshness`,
   `check:census-scope-coverage`, `check:census-row-move-labels`, and all five
   telegraph guards. **A green partial run is not a green run and this section
   does not claim one.**
5. **Fifteen citations in §10, §11 and §13 were REPOINTED, not rewritten.**
   Adding two lines to `travel-buddy-standalone/app/messages/[id].tsx` shifted
   every anchored citation below them by one or four lines and turned
   `check:doc-citations` red on fifteen of them. The line numbers were corrected
   to where the checker reports each whole anchor now sits; no anchor text and
   no prose changed. This is worth stating because it is a standing cost of
   anchored citations into a file any lane may edit, and the next lane to touch
   that file will pay it again.
6. **The client's own behaviour on a redacted tombstone was not changed.** With
   the server fix, `mediaUrl` is null and the media branch no longer matches, so
   a deleted photo falls through to the "This message was deleted." bubble —
   which is correct, and which this section verified by reading the dispatcher
   rather than by mounting the screen. An OLDER server would still send the
   asset to a current client. A client-side `!m.deleted` guard would close that
   too and was not added, because the conversation screen is the file this pass
   already had to repoint fifteen citations around and a second edit there buys
   defence against a server this repository controls.

---

## 15. The remaining BRANCH rows, executed — the five object families §5 names and this tree had never made shareable, a registry entry that pointed at the wrong table, and four rows §13 put in the wrong group

`head_commit: e42148ffa` — the base this section measured and built on. Every
verdict below was read against that tree. The code this section adds sits on
branch `claude/sweet-fermat-fmx7up`, which is not merged, not deployed and not
flag enabled.

§13 split the 176 BUILT-BUT-WRONG rows and named 51 as BRANCH. §14 corrected one
of those to BOTH (T31) and closed four (T79, T388, T430, T438), leaving 46 open.
This section took that list as its work queue, re-derived the classification
against the code before building anything, and closed five more.

**The queue was verified, not taken.** §13.4's table was re-counted from the
document: 24 OWNER + 12 BOTH + 51 BRANCH + 89 NEITHER = 176, which is exactly
the pile §13 set out to split, so the split is complete and the arithmetic in
§13.2 holds. §14.5's single correction (T31) is the only edit to it before this
section. The BRANCH list as this section received it is therefore the fifty ids
in §13.4 minus T31 — and four of those fifty do not survive §13.1's own test.
See §15.5.

### 15.1 The one shape that made five rows closeable at once

Five of the queue's rows — T3, T36, T37, T38 and T39 — are the same sentence
said five ways. §5 names five object families and lists their members:

| family | §5's members | had a loader before this pass |
| --- | --- | --- |
| Social | profile, post, Highlight, public Memory derivative, Memory Note, Stamp | 4 of 6 |
| Travel | Trip, Trip stage, plan, event, route, reservation-safe derivative, layover plan | 4 of 7 |
| Places | place, Hidden Gem, map pin, neighborhood, meetup point | 4 of 5 |
| Services | Buddy profile/service, eligible booking card, Visa Buddy operational card | 1 of 3 |
| Media | photo, video, voice, GIF, file | **0 — the family had no member in the vocabulary at all** |

Every one of the missing members is a row in a table that already exists in
production. This was checked against the 431-table inventory before a line was
written, not assumed: `artifacts/api-server/baseline/20260907_production_tables.txt:161#highlights`,
and the same file lists `user_stamps`, `neighborhood_areas`, `route_plans`,
`trip_reservations`, `layover_sessions`, `media_assets` and `buddy_services`.
So §13.4 was right that these are BRANCH: no migration, no flag, no new table —
a loader each.

**What was built.** Eight loaders and three new vocabulary types, in one file:

| family member | loader | authorization rule, and why it is that one |
| --- | --- | --- |
| Highlight | `artifacts/api-server/src/services/telegraph/shareables.ts:614#const loadHighlight` | Public or owner only. The other three `highlights.visibility` values need a relationship read another surface owns, and approximating it is the backdoor §5.3 forbids — the same reasoning `loadMemory` already states. Plus the rule no other family needs: **it expires.** |
| Stamp | `artifacts/api-server/src/services/telegraph/shareables.ts:683#const loadStamp` | Revoked → gone. Hidden from its owner's own passport → not handed to a third party. Two reads, both bound and checked: an unreadable definition is `unknown`, not an untitled stamp. |
| neighborhood | `artifacts/api-server/src/services/telegraph/shareables.ts:742#const loadNeighborhood` | None, and none invented. `neighborhood_areas` is derived public reference data with no owner and no visibility column. §11 said this family "deliberately has no loader ... rather than pretending"; what it refused to pretend about was an authorization model, and this family genuinely has none to get wrong. |
| route | `artifacts/api-server/src/services/telegraph/shareables.ts:774#const loadRoute` | `route_plan_members`, not the trip. Being on the trip a route was planned for is not being on the route. A draft degrades for everyone but its owner. |
| reservation-safe derivative | `artifacts/api-server/src/services/telegraph/shareables.ts:823#const loadReservation` | Owner or accepted trip member — and the projection carries neither `confirmation_ref`, `raw_text` nor `extraction`. See §15.2. |
| layover plan | `artifacts/api-server/src/services/telegraph/shareables.ts:867#const loadLayoverPlan` | Owner, or an accepted member of the trip the session belongs to. A session with no `trip_id` is private to its traveller, full stop. |
| Media | `artifacts/api-server/src/services/telegraph/shareables.ts:922#const loadMedia` | `visibility: 'inherit'` — the column's DEFAULT — degrades to `private`. See §15.2. |
| Buddy service | `artifacts/api-server/src/services/telegraph/shareables.ts:972#const loadBuddyService` | `approved` AND `is_active`, or ownership. This one is a REPAIR, not an addition. See §15.3. |

The three vocabulary types are `artifacts/api-server/src/services/telegraph/vocabulary.ts:52#"RESERVATION",`,
`artifacts/api-server/src/services/telegraph/vocabulary.ts:53#"LAYOVER_PLAN",` and `artifacts/api-server/src/services/telegraph/vocabulary.ts:77#"MEDIA",`. The registry is
`artifacts/api-server/src/services/telegraph/shareables.ts:1005#const LOADERS` and
now answers twenty-two object types where it answered fifteen
(`:950#SHAREABLE_OBJECT_TYPES`). Forty-eight assertions:
`artifacts/api-server/src/test/telegraphShareFamilies.test.ts:271#it("Services:`
and the rest of that file.

**One thing was made checkable rather than left to the `default:` arm.** Three
of the new families have no client screen that takes their id — there is no
`app/highlight/`, no `app/neighborhood/` and no reservation route in
`travel-buddy-standalone/app/`, which was read rather than assumed. Their deep
link is the app root, and that is now a DECLARED absence
(`artifacts/api-server/src/services/telegraph/shareables.ts:187#export const FAMILIES_WITH_NO_CLIENT_SCREEN: readonly TelegraphObjectType[] = [`)
with a test that the set of families answering `/` is EXACTLY that list
(`artifacts/api-server/src/test/telegraphShareFamilies.test.ts:306#it("the families with no client screen are DECLARED, not discovered", () => {`).
Adding a loader without a screen now fails loudly; so does adding the screen and
forgetting to delete the entry.

### 15.2 The two rules that are specific to the new families, and would have been missed by a shape test

**A Highlight becomes unavailable with nobody acting.** Every other family in §5
degrades because somebody DID something — deleted, unpublished, revoked,
blocked. `highlights.expires_at` is NOT NULL, so a Highlight card goes stale on
its own. §5.3's list — "deleted, private or unauthorized" — does not name time,
and the behaviour still has to be there, because a card that kept rendering an
expired Highlight would be a backdoor into content the author chose to make
temporary. An UNPARSEABLE `expires_at` answers `unknown`, never "not expired":
"we cannot tell when this ends" must not resolve to "it never does"
(`artifacts/api-server/src/test/telegraphShareFamilies.test.ts:332#it("AN EXPIRED HIGHLIGHT DEGRADES, and carries nothing", async () => {`).

**"Reservation-SAFE derivative" is a requirement about what is left out.**
`trip_reservations` carries three things that must not leave the person who
pasted them: `confirmation_ref` — a booking reference IS a credential, it is
what an airline's "manage my booking" page authenticates on — `raw_text`, the
pasted confirmation email entire, and `extraction`, the model's read of it. The
derivative is what remains: what kind of thing, what it is called, when, where.
The assertion scans the WHOLE serialized reference for the fixture's reference
string rather than checking named fields, so a leak through any key fails
(`artifacts/api-server/src/test/telegraphShareFamilies.test.ts:485#it("THE CONFIRMATION REFERENCE IS NOWHERE IN THE RESOLVED SHARE", async () => {`).

**And one that decides most of the Media family.** `media_assets.visibility`
DEFAULTS to `'inherit'` — "whatever the object this asset hangs off says". A
loader over one table cannot resolve that: the parent could be a post, a memory,
a Highlight or a message, each with its own ladder. So `inherit` degrades to
`private` for anybody but the owner, which means most assets in the table are
not shareable to a third party today. That is the conservative direction and it
is deliberate: the permissive reading of "inherit" is a backdoor into whatever
the parent was hiding
(`artifacts/api-server/src/test/telegraphShareFamilies.test.ts:571#it("VISIBILITY 'inherit' DEGRADES rather than resolving permissively", async () => {`).

### 15.3 A registry entry that named a family it could not load

`BUDDY_SERVICE` was in `LOADERS`, mapped to `loadBooking`. `loadBooking` reads
`rent_buddy_bookings`. A `buddy_services.id` is not a `rent_buddy_bookings.id`,
so `isShareable("BUDDY_SERVICE")` answered **true** and every actual
BUDDY_SERVICE reference then resolved `not_found` — a family that read as
registered in every count, including this census's own "fifteen object types",
and could not be shared at all.

The two are different objects, which is why one loader cannot serve both: a
booking is an agreement between two named people, a service is a marketplace
LISTING anyone may be shown. The authorization is correspondingly different —
`approved` (an admin act) AND `is_active` (the buddy's own switch), with the loss
of either being exactly §5.3's case.

Its deep link was wrong in the same way and was not repaired but WITHDRAWN:
`/(rent-a-buddy)/booking/${id}` is a real screen for a different object, and
`app/(rent-a-buddy)/buddy/[id].tsx` takes a BUDDY id, not a service id. A
`buddy_services.id` opens neither, so BUDDY_SERVICE joins the declared-no-screen
list. Pointing a card at a screen that will 404 is worse than pointing it at the
root, because only one of the two is visible to a reader of this file.

### 15.4 The mutations, and what went red

Twenty-four. Each applied, run, reverted, and the file compared byte-for-byte
with `cmp` against a pre-mutation copy — every one restored identical.
`telegraphShareFamilies.test.ts` runs 51; `telegraphProjectionPermissions.test.ts`
runs 12.

| # | mutation | result |
| --- | --- | --- |
| M1 | the seven new `LOADERS` entries deleted — the state before this pass | 3 pass / 38 fail |
| M2 | the Highlight expiry check deleted | 39 / 2 |
| M3 | the unparseable-`expires_at` guard deleted | 40 / 1 |
| M4 | `user_stamps.is_revoked` no longer checked | 39 / 2 |
| M5a | the reservation `select` widened to fetch `confirmation_ref`, projection untouched | **STAYED GREEN**, 41 / 0 |
| M5b | `confirmation_ref` put into the reservation subtitle | 39 / 2 |
| M6 | `media_assets.visibility !== 'public'` weakened to `=== 'private'` — the permissive reading of `inherit` | 39 / 2 |
| M7 | the `route_plan_members` error guard deleted | 40 / 1 |
| M8 | RESERVATION dropped from `FAMILIES_WITH_NO_CLIENT_SCREEN` | 40 / 1 |
| M9 | the LAYOVER_PLAN deep link deleted | 39 / 2 |
| M10 | `highlights.archived_at` no longer checked | first run **STAYED GREEN** 41 / 0; after the fixture below, 46 / 1 |
| M11 | the stamp `visibility` gate dropped, leaving only `display_on_passport` | 46 / 1 |
| M12 | the `dismissed` reservation gate dropped | 46 / 1 |
| M13 | the `cancelled` layover gate dropped | 46 / 1 |
| M14 | the `rejected` media moderation gate dropped | 46 / 1 |
| M15 | the media `processing !== 'ready'` gate dropped | 46 / 1 |
| M16 | the media terminal-processing-state check deleted | first run **STAYED GREEN** 47 / 0; after the fixture below, 47 / 1 |
| M17 | `BUDDY_SERVICE` pointed back at `loadBooking` — the state before this pass | 48 / 3 |
| M18 | the `approved` / `is_active` gates deleted | 50 / 1 |
| M19 | BUDDY_SERVICE dropped from the declared no-screen set | 50 / 1 |
| P1 | the whole `permissions` block removed from the thread read — the state before this pass | 2 / 9 |
| P2 | `degraded` hard-coded to `false` | 9 / 2 |
| P3 | the per-capability `reasons` emptied | 9 / 2 |
| P4 | the projection overrides the resolver with `canSendMessage: true, canCall: true` | first run 9 / 2 |
| P5 | the block resolved for the thread's first SENDER instead of the caller | first run **STAYED GREEN** 11 / 0; after the fixture below, 11 / 1 |

**Three mutations that stayed green, and what each of them cost to fix.** This
is the third section in a row to find a guard with no observable effect, and the
three here are three different kinds.

1. **M5a is the most interesting and the least like §14's B2.** Narrowing the
   `select` list is NOT what carries the reservation-safe rule. Widening it back
   to fetch `confirmation_ref` left every test green, because the rule is
   carried by the PROJECTION and not by the query — and that is also true in
   production, where PostgREST returns whatever the column list asks for and the
   danger is a projection that reads it. M5b is the mutation that shows which
   line actually carries the rule. The narrow `select` stays, as defence in
   depth, but it is now recorded as defence that no test measures rather than as
   the rule.
2. **M10 and M16 were uncovered branches, and both distinctions are real**, so
   both were COVERED rather than deleted. `highlights.archived_at` is a
   different act from `deleted_at` and a fixture now sets it. A `removed` asset
   and an `uploading` one are both "not renderable" and only one of them means
   the asset is gone — a client that says "this was taken down" about an upload
   still in flight is wrong in a way the reader can see
   (`artifacts/api-server/src/test/telegraphShareFamilies.test.ts:599#it("REMOVED is 'deleted' and UPLOADING is 'unknown' — the two are different claims", async () => {`).
3. **P5 was a gap in the FIXTURE, not in the code.** Resolving the permissions
   block for the wrong member was invisible because every asymmetry in the
   original fixture was symmetric between two people — a block is mutual, trip
   membership was identical. A trust restriction is not: it is held by one
   person. One restriction row on BOB made "resolved for the caller"
   distinguishable from "resolved for somebody else in the thread"
   (`artifacts/api-server/src/test/telegraphProjectionPermissions.test.ts:250#it("the block is resolved for the CALLER, not for anybody else in the thread", async () => {`),
   and P5 then failed. The lesson is narrower than "write more tests": a
   per-viewer assertion needs an input that is per-viewer, and a fixture built
   only from symmetric relations cannot make one.

### 15.5 Corrections to §13's split — four rows that cannot be moved from this branch

Stated here rather than edited above, because sections are append-only. None of
these changes a VERDICT. All four stay BUILT-BUT-WRONG; what changes is who can
move them, which is the question §13 exists to answer.

| id | §13.4 said | why that is wrong | group |
| --- | --- | --- | --- |
| T201 | BRANCH — "An add-participant operation is code over `message_thread_members`; nothing storage-shaped is missing." | **There is no thread type on which an add-participant operation would be correct**, and the tree says so twice. `message_threads.thread_type` is exactly `direct` / `trip` / `circle`, enforced by a CHECK constraint (`artifacts/api-server/baseline/20260819_baseline_structure.sql:7526#CONSTRAINT`) and by `thread_type_enum` (`:855#CREATE`). §14.3 says extending a DM FORMS A NEW GROUP — and there is no group thread type to form, so that is a migration. On a trip or circle thread, `syncTripChatMembers` and `syncCircleChatMembers` set `left_at = now` on any member who is not in the source roster (`artifacts/api-server/src/services/groupChatSync.ts:39#export async function syncTripChatMembers(`), so a hand-added participant is removed by the next sync. The capability policy already states both refusals as policy, not as absence (`artifacts/api-server/src/domain/telegraph/policies/conversationCapabilityPolicy.ts:288#deny(d, "canInvite", conversationType === "direct"`). | BRANCH → **NEITHER** |
| T218 | BRANCH — "Promotion under safety mode is client layout." | T218's subject is what SAFETY MODE promotes. T217 — the mode itself — is NEITHER in §13.4's own table: "A conversation-level safety mode does not exist in either tree." A layout that reorders affordances under a mode that has no referent cannot be written; there is nothing to reorder under. §13.1's tie-break is explicit that a row takes the HARDEST gate still standing, NEITHER first. | BRANCH → **NEITHER** |
| T4 | BRANCH — "The rail has no `memories` resolver. OWNER DECISION on private-by-default before it is written." | The cell names the blocker itself. §13.1's NEITHER arm is the one this document already used for T202 ("An owner product decision, not a build") and T255 ("an owner product decision, not a deploy and not code"). A decision about whether private-by-default content may surface in a shared rail is the same kind of thing, and it stands before the resolver rather than after it. | BRANCH → **NEITHER** |
| T396 | BRANCH — "OWNER DECISION: the spec states two different six-level ladders and they disagree at P3/P4/P5." | Same. A branch cannot pick which of two contradictory spec ladders is the real one; writing either is a guess that a later reading can overturn. This is the clearest case of the four, because the cell states that the SPEC is the obstacle. | BRANCH → **NEITHER** |

**The BRANCH count is 46, not 50.** §14.5 moved T31 to BOTH (51 → 50); these
four move to NEITHER (50 → 46). NEITHER becomes 93. The four groups still sum to
176: OWNER 24 + BOTH 13 + BRANCH 46 + NEITHER 93. Of the 46, four were closed by
§14 and five by this section; **thirty-seven remain open.**

### 15.6 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T36 | W | **C** | §5's Social family: profile, post, Highlight, public Memory derivative, Memory Note, Stamp. Was four of six — "Highlight and Stamp have no loader and STAMP is not in the registry". Both now have one, each with the §5.1 five and an authorization rule read off the table rather than guessed: a Highlight that has EXPIRED, been archived or been deleted degrades, and only `public` or ownership is granted; a Stamp that has been REVOKED degrades, and one its owner has hidden from their own passport is not handed to anybody else. Six of six. |
| T37 | W | **C** | §5's Travel family: Trip, Trip stage, plan, event, route, reservation-safe derivative, layover plan. Was four of seven. `ROUTE` had a vocabulary entry and no loader; RESERVATION and LAYOVER_PLAN had no name at all, though `trip_reservations` and `layover_sessions` are both in the production inventory — the gap was in the vocabulary, not the database. The reservation loader is the one that carries a rule beyond "does this viewer see it": SAFE means the projection carries no confirmation reference, no pasted email and no extraction, asserted by scanning the whole serialized reference rather than named fields. Seven of seven. |
| T38 | W | **C** | §5's Places family: place, Hidden Gem, map pin, neighborhood, meetup point. Was four of five; NEIGHBORHOOD "deliberately has no loader ... rather than pretending". What §11 refused to pretend about was an authorization model, and `neighborhood_areas` has none to get wrong: it is derived public reference data with no owner and no visibility column. It now resolves, carrying its `confidence` as status so a low-confidence grid cell and a high-confidence OSM polygon are not the same claim. Five of five. **The citation this row carries, `test/telegraphShare.test.ts:295`, still resolves and its `it(...)` is unchanged — but the assertion inside it was FALSIFIED by this pass and now names `VISA_CARD`, which is the family that is in the vocabulary with no loader today.** |
| T3 | W | **C** | Pillar **Share** — "any eligible Portava object moves through a safe permission-aware share projection". The projection half was already right; the row stayed W because "Media (§5's fifth family) is not a shareable type at all". It is now: `MEDIA` is in the vocabulary and resolves through `media_assets` with the same contract as the other twenty-one types. All five families have loaders and all twenty-two types answer preview, current state, actions, deep link, search behaviour and revocation. **Stated so nobody over-reads this C: `media_assets.media_type` admits `image` and `video` only, so §6.2's voice, GIF and file kinds remain unshareable — they have no row shape in any migration, which is T40 and is NEITHER. "Any eligible object" is satisfied because an object that cannot be stored is not an eligible object; it is not satisfied in the sense that Telegraph can carry a voice note.** |
| T290 | W | **C** | §24 `ConversationProjection` — "renderable ordered thread WITH CURRENT PERMISSIONS". §12's restatement left exactly one gap: "it still carries no permissions block, which is the half §24 names explicitly". `GET /threads/:threadId/messages` now answers one (`artifacts/api-server/src/routes/messaging.ts:2591#permissions:`), carrying §14.1's ten capabilities, their per-capability reasons, which of the eight inputs were read, and `degraded` when one of them could not be. The block is ASKED of `resolveConversationCapabilities` (`artifacts/api-server/src/routes/messaging.ts:2583#const resolvedCapabilities = await resolveConversationCapabilities(sc, {`) rather than re-derived, and the test compares it field-by-field against that resolver run directly on the same fixture (`artifacts/api-server/src/test/telegraphProjectionPermissions.test.ts:213#it("the projection's block EQUALS resolveConversationCapabilities on the same fixture", async () => {`) — a second implementation of §14.1 would pass a "has ten keys" test and fail that one, which is the failure mode being guarded. It gates nothing: `CAPABILITY_ENFORCEMENT_SITES` still names where each refusal happens. `PRJ-02`'s note is corrected in the same pass (`artifacts/api-server/src/domain/telegraph/projections/projectionRegistry.ts:58#id: "PRJ-02",`), which had said the block "does not exist" — stale since T207 went C. **Why this is C and not W on history bounding: T290's requirement is the projection; the §14.3 bound is T211's, is flag-gated, and §12's own restatement recorded it as gained. PRJ-02 stays `partial` for that reason and this row does not.** |

### 15.7 The restated headline

> **RESTATED 2026-09-13 BY THE §15 LANE, from the merged rows and not by
> addition: C 215 → 220, W 172 → 167, N 49, X 3. CONSTRUCTED (220+167)/451 =
> 85.8 %, CORRECT 220/451 = 48.8 %.** Five BUILT-BUT-WRONG rows moved to
> BUILT-AND-CORRECT (T3, T36, T37, T38, T290); no row moved into
> BUILT-BUT-WRONG and no row moved out of NOT-BUILT. The gap between
> CONSTRUCTED and CORRECT — the W column, which is the whole point of the
> distinction — narrows from 38.1 points to 37.0.
>
> **The 176 split restated: OWNER 24, BOTH 13, BRANCH 46, NEITHER 93**, because
> T4, T201, T218 and T396 move from BRANCH to NEITHER on the evidence in §15.5.
> Of the 46 BRANCH rows, nine are now C (four from §14, five from here) and
> thirty-seven are not.
>
> **What this number is not.** It is still a BRANCH census and this section's
> five moves are on an unmerged branch. MERGED IS NOT DEPLOYED; DEPLOYED IS NOT
> FLAG ENABLED. Nothing here required a migration or a flag — every table the
> eight new loaders read is in the 431-table production inventory — so these
> five, like §14's four, are true on every deployment the moment this branch
> merges. Every other statement §13.10 made about what is dark remains true.

### 15.8 What was opened, read against the code, and NOT closed

Named so the next lane does not re-derive them.

1. **T39 — Services, and the Visa Buddy card that has no referent.** Two of the
   family's three members now resolve (Buddy service via §15.3, booking card
   already). The third does not, and the reason is not a missing loader: **there
   is no Visa Buddy product in this tree.** `VISA_CARD` appears exactly once in
   the whole server — its own vocabulary entry — and nothing writes, reads or
   renders it. The nearest artifacts belong to other programmes:
   `entry_requirements` is a public (passport country, destination country)
   reference table with no user and no operational state, and
   `trip_documents.document_type = 'visa'` is a private document inside a trip.
   Building a loader over either would be inventing the object the row is about.
   §13.4 called this "loaders"; it is one loader and one product that does not
   exist. T39 stays W and its remaining half is arguably NEITHER.
2. **T344 and T363 — bigger than §14.6 said, and the correction matters.**
   §14.6 named what remained as "the quoted reply context" and "several
   notification-name and language-default reads". Reading the file, the class is
   larger and one member of it is worse than anything named. `routes/messaging.ts`
   holds **31** reads spelled `const { data: x } = await` (counted with `grep -c`,
   not sampled). §14.9 characterised the remainder as "most of them refusals,
   which the requirement does not forbid". That is true of about half. It is not
   true of these, which this lane read and did not fix:
   - **Four sites turn an unreadable `profiles` into a stored false claim.**
     `senderLanguage` defaults to `'en'` on a dropped error at four call sites,
     and the value flows into `translateMessageForThread`, which writes
     `messages.language_detection_source = 'sender_preference'`
     (`artifacts/api-server/src/services/messageTranslation.ts:300#detectionSource = 'sender_preference';`
     — THE ONE CITATION IN THIS DOCUMENT WHOSE ANCHOR TEXT HAD TO CHANGE, and
     §16 says why: the line this paragraph originally named,
     `detectionSource = senderPreferredLanguage ? 'sender_preference' : 'default';`,
     WAS the defect and no longer exists. The anchor now names the arm that
     replaced it. The sentence above is left exactly as written, because it is
     a true statement about the tree on the day it was written.)
     So a profiles outage does not merely degrade — it writes a durable,
     queryable assertion that the sender's stated preference was English, when
     no preference was read. The distinguishing mechanism ALREADY EXISTS one
     layer down (`'default'` is the other value); the route is feeding it a lie.
     `routes/groupChat.ts:328` is a fifth instance of the same line.
   - **An unreadable `profiles` becomes a confident 404.** "Circle owner not
     found" is produced by a read whose error was discarded
     (`artifacts/api-server/src/routes/messaging.ts:3738#const { data: ownerProfile, error: ownerProfileErr } = await sc`
     — the SECOND citation in this document whose anchor text had to change,
     for the same reason as the one above: the read named here was the defect,
     and the line now binds the error it used to drop. §16.6.)
   - **A mention notification names "@someone"** when the tagger's profile read
     fails — indistinguishable from a tagger who has no handle
     (`artifacts/api-server/src/routes/messaging.ts:3025#const { data: taggerProfile, error: taggerProfileErr } = await sc`
     — the THIRD citation in this document whose anchor text had to change, for
     the same reason as the two above: the read named here WAS the defect, and
     the line now binds the error it used to drop and asks `actorHandleFrom`
     what the read established. §17.2.)
   - **The quoted reply context still degrades silently ON THE WIRE.** Both
     reads now log (§14), but a reply whose quote could not be read and a
     message that quoted nothing are the same JSON.
   These were not built because closing T344/T363 honestly requires auditing the
   whole messaging tree, not the seven sites above, and a partial fix that left
   the rows W would have bought less than naming them precisely does. **The
   sites are named here with line-anchored citations so the next lane starts
   from a list rather than a grep.**
3. **T409 — five sixths present, one sixth structurally absent.** §13.4's
   evidence correction is right that preview, current state, actions, search
   behaviour and revocation now exist per object family, and after §15.1 they
   exist for twenty-two of them. Joining them to the message-type registry
   (`shareAuthorizationPolicy.ts`) is indeed composition, with one exception that
   is not: `compass_card` declares `sourceDomain: "compass"`, and Compass is not
   one of §5's object families and has no loader. `conversationSearch.ts` already
   declares that exception in writing. So "EVERY shareable Portava domain
   registers all six" cannot be made true by composition alone — either Compass
   gets a §5 family or the requirement is read as not covering it, and that is a
   reading, not a build.
4. **T166, T169 and T170 are not "wiring".** §13.4 calls exposing
   `CREATE_DECISION`, `SET_COORDINATION_STATUS` and `SHARE_LOCATION` through the
   §13.1 command endpoint wiring. The command module argues the opposite
   deliberately and at length: `ISSUABLE_COMMANDS` contains only commands with NO
   legacy writer, because issuing one that has a route would route around that
   route's block guard, E2EE gate, rate limit, off-app detector and translation
   pipeline
   (`artifacts/api-server/src/domain/telegraph/commands/telegraphCommands.ts:78#export const ISSUABLE_COMMANDS: readonly IssuableCommand[] = [`).
   All three of these rows' commands have legacy writers and are listed in
   `LEGACY_PATH_COMMANDS`. Closing them means moving five guards onto the bus,
   which is a refactor of the send path, not wiring — and it may be the wrong
   thing to do at all. Left BRANCH, because a branch genuinely could do it; the
   size estimate in §13.4 is what is wrong.
5. **The full suite did not run**, by instruction — the machine is shared. What
   DID run, individually and green: the two files this section added, every
   suite that imports `shareables.ts`, `vocabulary.ts` or `conversationSearch.ts`
   (`telegraphShare` 34, `telegraphSearchCapability` 15, `telegraphSharedContext`
   33, `telegraphKinds` 36, `telegraphCoordination` 59, `telegraphSearch` 34),
   and all twenty-eight suites that drive `GET /threads/:id/messages`
   (`messaging` 22, `groupChat` 39, `telegraphChat` 48,
   `telegraphRlsAuthorizationMatrix` 38, `telegraphLifecycle` 34,
   `accessControl` 33, `adminPhase12` 31, `telegraphAbuseControls` 37,
   `telegraphAdversarialFixtures` 27, `telegraphInboxFailsLoud` 12,
   `telegraphConversationCapabilities` 27, `telegraphObservability` 22 and
   sixteen more). **A green partial run is not a green run and this section does
   not claim one.**
6. **Citations repointed, not rewritten: twenty-two.** Adding loaders to
   `shareables.ts` and one import to `routes/messaging.ts` shifted every anchored
   citation below them. Fourteen in §10, §11 and §14 of this document, one in
   census-discovery and one in census-trust were corrected to where the checker
   reports each whole anchor now sits, plus six unanchored `telegraphShare.test.ts`
   line numbers found by matching the ORIGINAL line text rather than by applying
   an offset. No anchor text and no prose changed. §14.9 predicted this cost and
   it was paid again.
7. **`check:doc-citations` and `check:census-freshness` are red on other lanes'
   work, and this section did not touch either.** Twelve citation failures
   remain, all into `app/layover/[id].tsx`, `CompassTools.ts` and
   `PassportProjectionService.ts`; none is into a file this section edited, which
   was verified after every change. And `services/telegraph/shareables.ts` is in
   `census-discovery.md`'s scope, so this section's edit ages that document — it
   was ALREADY stale on two other files before this lane touched it, and this
   makes three.

## 16. §15.2's first bullet, executed — a durable false claim about why a message had the language it has

§15.2 named seven sites in `routes/messaging.ts` and one in `routes/groupChat.ts`
that the §15 lane read and did not fix, and asked the next lane to start from
that list rather than a grep. This section is that lane. It closes the first of
§15.2's bullets — the five language call sites and the pipeline that consumed
them — and the second, the confident 404. **It moves no verdict**, and §16.4
says why in terms of the rows rather than in terms of effort.

### 16.1 What was wrong, restated from the code rather than from §15.2

Five call sites — messaging.ts lines 1038, 2455, 3084 and 3176, and
groupChat.ts line 328, as they stood on the day §15 was written, which is why
they are spelled in words rather than as citations: those positions describe a
tree that no longer exists — read the sender's profile for a language preference
and threw the error away:

```
const { data: senderProfile } = await sc.from('profiles')
  .select('preferred_language, preferred_message_language').eq('id', …).maybeSingle();
const senderLanguage = (senderProfile as any)?.preferred_language
  ?? (senderProfile as any)?.preferred_message_language ?? 'en';
```

supabase-js RESOLVES on a database error, so THREE DIFFERENT WORLDS arrived at
the pipeline as the identical string `'en'`: the sender chose English, the
sender chose nothing, and the read FAILED. `translateMessageForThread` then
stamped the row.

§15.2 said "the distinguishing mechanism ALREADY EXISTS one layer down
(`'default'` is the other value); the route is feeding it a lie." **Executing it
found that half of that sentence is wrong, and the correction is the reason this
needed more than deleting five `?? 'en'`s.** The mechanism did not exist. It
compiled, and it could not run:

```
sourceLanguage = senderPreferredLanguage ?? 'en';
detectionSource = senderPreferredLanguage ? 'sender_preference' : 'default';
```

Every caller pre-coalesced, so the ternary was never handed a nullish value and
`'default'` was DEAD CODE — reachable only via a stored empty-string preference,
which no writer in this tree produces (`''` survives `?? 'en'` and is falsy, so
that one path did reach it; nothing writes it). A reader auditing the column
would have concluded the two cases were already told apart. They were not:
**every row ever written by the fallback said `sender_preference`.**

### 16.2 The vocabulary, and why it is four words and not three

`messages.language_detection_source` is a durable, queryable assertion about how
a message's language was decided, so each value has to be something the server
actually knows:

| value | what it claims |
| --- | --- |
| `provider` | the provider read the text and named a language |
| `sender_preference` | the profile was read and carried a stated language |
| `default` | the profile was read successfully and stated nothing |
| `sender_preference_unreadable` | the profile could NOT be read |

The fourth is new. Folding a failed read into `default` was the available
cheaper option and it is the one this tree's own rule forbids: AN UNREADABLE X
IS NOT AN EMPTY X — `preferences_unreadable` in `LayoverPrivacyGuard`,
`plan_unreadable` in `LayoverReplanService`, `trip_unreadable` in
`SafeReturnNotificationService`, `state: 'unreadable'` in
`highlightResurfacing`. `default` is a POSITIVE statement — "we looked, and the
sender has stated nothing" — and a `profiles` outage is not entitled to make it.
The name follows the same `<thing>_unreadable` convention its siblings use.

**No migration, and the absence was verified rather than assumed.**
`language_detection_source` is a plain nullable `text` column with no CHECK
constraint in `migrations/0009_translation.sql`, in
`migrations/APPLY_THESE_IN_ORDER.sql`, or in
`artifacts/api-server/baseline/20260819_baseline_structure.sql:7564#language_detection_source text,`. The
trailing comment on 0009 still lists the original three values; it is a comment,
not a constraint, and applied migrations are checksummed against the live ledger
(`check:migration-ledger`), so it was deliberately left alone. The
`LanguageDetectionSource` type is the vocabulary of record
(`artifacts/api-server/src/services/messageTranslation.ts:63#export type LanguageDetectionSource =`).

### 16.3 What changed, and what deliberately did not

The five sites now BIND the error and hand the pipeline two things instead of
one: the language the sender stated (`string | null`) and whether the read
succeeded. One shared interpreter decides what the read established
(`artifacts/api-server/src/services/messageTranslation.ts:107#export function senderLanguageFrom(`),
because five copies of a coalesce is how one defect came to exist in five
places. All three fallback arms are now reachable, and `'default'` is reachable
for the first time.

**The behaviour a user sees is unchanged.** A message is still translated and
still gets an `original_language` in every branch; `'en'` is still the language
used when nothing better is known. What changed is the CLAIM about where that
language came from.

Shown red before green, in
`artifacts/api-server/src/test/messageLanguageProvenance.test.ts`: 4 pass / 13
fail against the unfixed tree, 17 / 0 after, and 19 / 0 once the 404 below was
closed in the same suite. The suite asserts that the three fallback worlds land
on three DIFFERENT stored words — a single assertion that
`sender_preference_unreadable` is spelled correctly would survive someone
aliasing it back onto `default`.

Then MUTATED BACK, one mutation at a time, each run, reverted, and the three
source files compared byte-for-byte with `cmp`. **Nothing survived**, which is
the claim a green suite cannot make on its own:

| mutation | result |
| --- | --- |
| the whole fix reverted to `HEAD` | 5 / 14 |
| `?? 'en'` re-introduced at the send-path call site | 17 / 2 |
| the error binding dropped at the `groupChat` call site | 17 / 2 |
| the `'default'` arm made unreachable again (service-side coalesce) | 11 / 8 |
| `'sender_preference_unreadable'` folded back into `'default'` | 13 / 6 |
| `senderPreferenceUnreadable` dropped from ONE call site | 17 / 2 |
| `?? 'en'` at the one call site no route case here drives | 18 / 1 |
| `senderLanguageFrom` ignoring the error it binds | 14 / 5 |
| the circle-owner refusal deleted | 18 / 1 |

The seventh row is the one that justifies the structural case existing: that
site is reached by NOTHING else in the suite, and without it re-introducing the
defect at one of the five would have been silent.

### 16.4 T344, T363 and T438 do NOT move, and the reason is the denominator

§15.2 measured **31** reads spelled `const { data: x } = await` in
`routes/messaging.ts` and named seven consequences it had read. This section
closed two of them: the five language call sites plus the pipeline that consumed
them, and the confident 404. `GET /circles/:id/chat` now refuses retryably when
the owner's profile CANNOT BE READ and still returns 404 when the owner is
genuinely absent
(`artifacts/api-server/src/routes/messaging.ts:3738#const { data: ownerProfile, error: ownerProfileErr } = await sc`).
Consequences that remain open in the same file:

- a mention notification that names `@someone`
  (`artifacts/api-server/src/routes/messaging.ts:3025#const { data: taggerProfile, error: taggerProfileErr } = await sc`
  — anchor repointed by §17 for the reason §15.8 gives about its own two: the
  read named here was the defect and no longer exists in that form. CLOSED by
  §17.2; the sentence above is left as written because it was true of the tree
  on the day it was written),
- quoted-reply context degrading silently ON THE WIRE,
- and the remainder of the 31 that §15.2 did not individually read.

The mention notification was left ALONE ON PURPOSE rather than by running out of
room, and the reason is a trap worth writing down: that read uses `.single()`,
which errors when NO ROW MATCHES as well as when the table is unreadable. Simply
binding its error would make a tagger with no profile row indistinguishable from
a `profiles` outage — the same conflation this section exists to remove, moved
one step along. Fixing it honestly means moving to `.maybeSingle()` and deciding
what a mention notification should say when the tagger cannot be named at all,
which is a product question this lane has no evidence to answer.

T344 asks that no schema/permission failure become a plausible empty
inbox/context; T363 says the same about plausible empty STATE; T438's emphasized
half says the same about inboxes. A row that is W because a class is unfinished
does not become C when one member of the class is finished, and claiming
otherwise is the exact failure mode `check:census-integrity` exists to make
harder. **They stay W.** What has changed is that the list the next lane starts
from is four items long instead of five.

There is also a consequence of this class INSIDE the fix's own file that is left
open and is named here rather than discovered later: step 3 of
`translateMessageForThread` reads the RECIPIENTS' profiles with the same dropped
error, so an unreadable `profiles` silently gives every recipient
`preferredLanguage: 'en'`
(`artifacts/api-server/src/services/messageTranslation.ts:338#const { data: profiles, error: profilesErr } = await sc`
— the FOURTH repointed anchor, same reason; CLOSED by §17.3, which also shows
the sentence below is too kind to the defect).
That is a degraded translation rather than a false stored claim — it writes
`status: 'skipped'`, which is true of what happened — so it is a smaller defect
than the one fixed here, but it is the same shape and it is not fixed.

### 16.5 Headline, restated from the tool

`pnpm -s check:census-integrity` recomputes the per-census counts from the
tables rather than from any prose, and after this section telegraph reads:

```
census                        rows     C     W     N    X   denom  unreconciled
telegraph                      439   220   167    49    3     451  12 counted where this tool cannot read
```

Unchanged by this section, which is the correct outcome for work that moves no
verdict.

### 16.6 Citations repointed: fifteen, and one of them is different

Adding one import and six error bindings to `routes/messaging.ts` shifted every
anchored citation below them. **Fourteen** were repointed by matching the EXACT
ORIGINAL LINE TEXT from `HEAD` and finding where that identical line now sits —
never by applying an offset, and each resolved to exactly one line. Eleven in
§14 and §15 of this document, two in census-compass, one in census-trust. No
anchor text and no prose changed in any of the fourteen.

**Two could not be repointed that way and are flagged in place.** The second is
§15.2's circle-owner citation, which pointed at line 3296 of `messaging.ts`
anchored on `const { data: ownerProfile } = await sc`. That line now reads
`const { data: ownerProfile, error: ownerProfileErr } = await sc`, because the
missing binding WAS the defect. The first:
§15.2's other citation pointed at line 130 of `messageTranslation.ts`, anchored on
`detectionSource = senderPreferredLanguage ? 'sender_preference' : 'default';`
— the line that WAS the defect. (That pair is written out in words here rather
than in citation form on purpose: spelled as a citation it would be a live
claim about where a deleted line sits, and `check:doc-citations` would be right
to fail it.) It does not exist anywhere in the tree now, so there is no original
line text to find. Its anchor was changed to name the arm that replaced it, with
the original text quoted inline so the record of what was there is not lost, and
§15.2's sentence was left exactly as written: it was true of the tree on the day
it was written, and this section is where it stops being true.

### 16.7 What this section did not run

`npm test` was not run — the machine is shared and another lane holds it. What
ran, individually and green: `messageLanguageProvenance` (19), `messaging` (22),
`groupChat` (39), `telegraphInboxFailsLoud` (12), `telegraphChat` (48),
`telegraphRlsAuthorizationMatrix` (38), `telegraphAdversarialFixtures` (27),
`telegraphLifecycle` (34), `accessControl` (33), `adminPhase12` (31),
`retranslateGate` (6), `commentTranslationInvalidation` (4),
`contentTranslationInvalidation` (16), `messagingThreadDedupe` (12),
`messagingPermissionsHardening` (19) and `messagingOffApp` (11) — every suite
that drives a route this section edited, plus every suite that imports
`messageTranslation.ts`. **A green partial run is not a green run and this
section does not claim one.**

`check:doc-citations`, `check:census-freshness` and `check:test-registration`
are red on another lane's in-flight work — `routes/airport.ts`,
`services/airport/*` and two unregistered `layover*`/`media*` test files. Every
failing citation is into census-layover and census-sensing; none is into a file
this section edited, and the UNANCHORED ratchet is back at exactly its ceiling
of 6443, which was verified after every change.

## 17. §15.2's remaining bullets, executed — an unreadable roster that evicted a whole trip chat, and the one privacy SLO nothing was counting

`head_commit: 6d4fd1a06` — the base this section measured and built on. Every
verdict below was read against that tree; the code this section adds sits on
branch `worktree-agent-a05ec1e308f716798`, which is not merged, not deployed and
not flag enabled.

§16 closed two of §15.2's five named consequences and deliberately moved no
verdict. This section takes the three that were left — the mention notification,
the quoted reply context on the wire, and "the remainder of the 31 that §15.2 did
not individually read" — plus the consequence §16.4 found inside its own file and
named rather than fixed. Reading the remainder found something none of the four
prior lanes had: **the worst instance of this defect in the tree is not a read
that returns an empty answer. It is a read that returns an empty answer and then
WRITES.**

### 17.1 The finding: an unreadable `trip_members` evicted the entire crew, permanently

`lib/chatSync.ts` reconciles a group thread's membership against the domain
roster that owns it. Step 2 read that roster with the error dropped; step 5 sets
`left_at = now()` for every thread member not in the accepted set. supabase-js
RESOLVES on a database error, so an unreadable `trip_members` arrived as
`data: null`, `?? []` made it "this trip has NO accepted members", and step 5
removed **every member of the trip chat, the owner included**.

This is a different shape from everything §14, §15 and §16 fixed. Those were
reads whose failure produced a plausible answer. This is a read whose failure
produced a plausible answer **and then drove a destructive write** against rows
the failed read said nothing about.

**And the trip case does not heal.** Step 4 clears `left_at` only when the
member's trip ROLE CHANGED, deliberately and under a comment that says so:
*"A member whose role is unchanged but who has left_at set chose to leave the
chat themselves — do NOT force-rejoin them on every sync."* So after a transient
blip every subsequent HEALTHY sync reads an evicted crew and leaves it evicted,
and each member is answered 403 "Not a member of this thread" on a conversation
they never left. The circle branch of the same file DOES restore, so it recovers
on the next sync; the trip branch does not. Neither should have been reachable.

**It is a live path, not a legacy twin.** `lib/chatSync.ts` is reached from the
trip-chat and circle-chat handlers
(`artifacts/api-server/src/routes/groupChat.ts:315#const threadId = await syncTripChatMembers(tripId, sc);`),
from trip creation and every trip-membership change
(`artifacts/api-server/src/routes/trips.ts:1378#syncTripChatMembers(tripId, client).catch((e) => req.log?.error({ err: e }, "syncTripChatMembers failed"));`),
and from circle invite-accepted and circle-member-removed
(`artifacts/api-server/src/routes/friends.ts:889#syncCircleChatMembers((inv as any).owner_id, sc).catch((e) => req.log.error({ err: e }, "syncCircleChatMembers failed"));`).

`services/groupChatSync.ts` — the second implementation, reached from
`routes/messaging.ts` — had the same dropped read and escaped the eviction BY
ACCIDENT: `if (acceptedIds.size === 0) return threadId;` sits between the read
and the removal loop. That is not a guard. It cannot tell "this trip has no
accepted members" from "the table is unreadable", and it answers both by handing
the caller a thread id, which asserts a reconciled roster. Its circle branch has
no such accident — the owner is always in the set, so the set is never empty —
and an unreadable `circle_memberships` there evicted every other member.

| piece | where |
| --- | --- |
| The trip roster read, now a refusal | `artifacts/api-server/src/lib/chatSync.ts:131#if (acceptedErr) {` |
| The circle roster read, now a refusal | `artifacts/api-server/src/lib/chatSync.ts:306#if (memberErr) {` |
| The second implementation's roster read, now a throw | `artifacts/api-server/src/services/groupChatSync.ts:152#if (tripMembersErr) {` |
| Its removal read, which failed in the OTHER direction — unreadable meant remove nobody, so a member the trip removed kept thread access | `artifacts/api-server/src/services/groupChatSync.ts:221#if (activeMembersErr) {` |
| The whole thing, both files, both discriminators, with a CONTROL beside every failure case | `artifacts/api-server/src/test/telegraphRosterReadEviction.test.ts:127#it("CONTROL: a healthy sync evicts the member the trip really removed, and nobody else", async () => {` |

The CONTROLs are not decoration: a "fix" that simply stopped removing anybody
would pass every assertion about eviction and silently break the feature the
file exists for.

### 17.2 The mention notification — why §16.4 was right to refuse it, and what made it answerable

§16.4 left this one alone with its reason written down: the read used
`.single()`, which errors when NO ROW MATCHES as well as when the table is
unreadable, so binding the error would have made a tagger with no profile row
indistinguishable from a `profiles` outage — the same conflation moved one step
along. That is exactly right, and it is why the fix is not a bound error.

`.maybeSingle()` separates the two, and one interpreter decides what the read
established
(`artifacts/api-server/src/lib/publicIdentity.ts:83#export function actorHandleFrom(`),
the same shape `senderLanguageFrom` took in §16 and for the same reason. Its
three worlds are asserted one at a time
(`artifacts/api-server/src/test/telegraphContextReadHonesty.test.ts:210#describe("actorHandleFrom — 'we could not read who' is not 'they have no handle'", () => {`).

§16.4 also said the remaining half was "a product question this lane has no
evidence to answer". Executing it found the question smaller than that, and the
evidence in the tree. The template renders
`@${taggerHandle ?? 'someone'} mentioned you`, so passing nothing would have
printed `@someone` anyway — the identical claim, made by the template instead of
the route. `'someone'` is TRUE of a tagger who has no handle and FALSE of a
`profiles` outage, where the tagger may well have one and nobody read it. So the
unreadable arm supplies its own title, which **names nobody** and asserts only
what is in evidence: a mention happened, in a message. That is the answer §14
gave for `tripCity` and §16 gave for language provenance — say the true thing,
and say nothing else.

What is NOT taken, and is left open on purpose: whether the product wants that
case to look different to the user, or to carry a retry.
`metadata: { taggerHandleUnreadable: true }` is persisted either way — `metadata`
is a stored column, `params` only feeds the template and is not stored — so that
decision can later be made from data rather than from memory.

### 17.3 The recipients' language preferences — §16.4's own footnote, and why it was too kind to the defect

§16.4 named this read and characterised it as *"a degraded translation rather
than a false stored claim — it writes `status: 'skipped'`, which is true of what
happened"*. Executing it shows the characterisation is wrong, and the reason is
the column beside the status.

With the error dropped, an unreadable `profiles` gave every recipient the map's
default, `preferredLanguage: 'en'`. When the source language is also `'en'` —
the common case — the same-language arm writes `status: 'skipped'` with
`target_language: 'en'`, and **that row is a durable, queryable assertion that
this recipient reads English and needed no translation.** Not one byte about that
recipient was read. It is the same false claim §16 removed from the sender's end,
written at the recipient's end by the same mechanism.

The honest row is `status: 'failed'` with
`error_message: 'recipient_preferences_unreadable'` and
`target_language: 'und'` — ISO 639-2's "undetermined", which this tree already
writes for exactly this situation
(`artifacts/api-server/src/routes/messaging.ts:2331#target_language: 'und',`).
**What a user sees does not change**: `buildDisplayFields` renders `failed` as
the untouched original with no banner, which is what `skipped` rendered too. What
changes is the claim.

Step 1 of the same function is the same shape with a worse ending, and §16.4 did
not name it: an unreadable `message_thread_members` yielded zero recipients and
the pipeline returned having written nothing and said nothing — byte-identical to
a thread the sender is alone in. There is no honest row to write instead
(without the roster there are no recipient ids to key one by), so what the
failure is owed is a loud, and the pipeline's own "never throws" contract makes
that a log at error level
(`artifacts/api-server/src/services/messageTranslation.ts:266#if (membersErr) {`).

### 17.4 The quoted reply context, and the group chat's translation read

§14 made both reply reads LOG and §14.6 recorded the limit of that in the same
breath: *"a reply whose quote could not be read is still indistinguishable on the
wire from a message that quoted nothing."* The log is for us; the payload is what
the client acts on.

Two degradations, kept apart because they degrade different claims. An unreadable
`reply_to_id` means nothing is known about WHICH messages are replies, so
`replyToId` may not be reported at all. Unreadable quoted bodies mean the linkage
is known and the quote is not. In both cases the affected fields are now OMITTED
and replaced by `replyContext: 'unavailable'`
(`artifacts/api-server/src/routes/messaging.ts:2516#...(replyLinkageUnreadable`).
Omission rather than `null` is §14's own line for `tripCity`, and here it carries
real weight: a `null` quote is a TRUE state — the quoted message is deleted, or
sits outside this member's §14.3 history window — and must stay distinguishable
from a read that failed. The marker is absent in the normal case, the posture §14
took with `previewTranslationStatus`, because a marker that is always present
says nothing.

The block's outer `catch` was written for one legitimate case (migration 0057 not
applied) and swallowed every other in the same silence; it now logs and sets the
same flag.

Separately: §14 fixed the per-viewer translation read in `routes/messaging.ts` so
an unreadable `message_translations` reports §18's own word, `failed`, instead of
inventing a monolingual thread. **The same query in the other reader was not
fixed with it** — `routes/groupChat.ts`, reached by both group-chat endpoints. It
is now (`artifacts/api-server/src/routes/groupChat.ts:194#if (tErr) {`).

### 17.5 T349 — the one privacy SLO that nothing was counting

§13.4 classified T349 as BRANCH with its blocker named exactly: *"The emitter
belongs in `services/safeReturn/SafeReturnPrivacyGuard.ts` — another lane's file,
not an absent capability."* §12 recorded the same as a ceiling it could not pass.
This lane holds that file.

What is counted follows `lib/blockGuard.ts`, which SLO-05 and SLO-14 already
share, because the question is the same: not "did a leak happen" — a counter
cannot prove a negative and is not asked to — but "is the gate running, and is it
running with knowledge".

| outcome | what it records |
| --- | --- |
| `ok` | the expiry gate RAN and concluded: an expired or stopped share refused, or a live share admitted inside a window that bounds it |
| `unknown` | the share row could not be READ, so expiry was never evaluated — the rate at which this privacy gate is failing closed |
| `violation` | the gate ADMITTED a live-location share it cannot bound in time |

**The violation arm is reachable, and that is a second finding.**
`safe_return_live_shares.expires_at` is NULLABLE
(`artifacts/api-server/baseline/20260819_baseline_structure.sql:9747#expires_at timestamp with time zone,`)
and the gate's test is `if (s.expires_at && …)`, so an active share with no
`expires_at` is admitted every time, forever. §30A.20 and T356 require a location
share to carry an expiry; this table does not enforce one, and until this emitter
nothing anywhere said so. The counter does not change that behaviour — silently
revoking live shares production may be relying on is not a measurement lane's
call, and making the column `NOT NULL` is a migration no lane has written. It
makes the state visible, which is what T349 asks for.

A non-recipient refusal is deliberately NOT counted: recipient identity is
authorization, not expiry, and folding it in would inflate a privacy metric with
events that say nothing about location lifetime — the count would then look
healthiest on the traffic that never reached the expiry test at all.

| piece | where |
| --- | --- |
| The emitter's unreadable arm | `artifacts/api-server/src/services/safeReturn/SafeReturnPrivacyGuard.ts:153#recordTelegraphMetric("expired_precise_location_leakage", "unknown");` |
| The unbounded-share violation | `artifacts/api-server/src/services/safeReturn/SafeReturnPrivacyGuard.ts:207#recordTelegraphMetric("expired_precise_location_leakage", "violation");` |
| SLO-04, now `measured`, naming its emitter | `artifacts/api-server/src/domain/telegraph/services/telegraphObservability.ts:114#status: "measured",` |
| The suite, driven through the real middleware | `artifacts/api-server/src/test/telegraphExpiredLocationMeasured.test.ts:124#describe("T349 — the expiry gate is counted, not merely enforced", () => {` |
| The shrink-only ratchet, lowered in the same commit | `artifacts/api-server/src/scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json:8#unmeasuredSlos` |

`check:telegraph-slos` refused the improvement until the baseline moved —
*"unmeasured SLOs: 11, baseline 12. Something IMPROVED — lower the baseline in
the same commit so the gain cannot be given back silently"* — which is the guard
working, and is recorded because a reader should know the number was not chosen.

### 17.6 The mutations, and the four that stayed green

Twenty-six. Each applied, run, reverted, and every touched file compared
byte-for-byte with `cmp` against a pre-mutation copy — every one restored
identical. M1-M18 run the two suites of §17.1-§17.4 together; N1-N7 run the
T349 suite. **The M-series numbers are all against the FINAL 29-case suite**:
M1-M14 were first run against the 25 cases that existed when they were written
and were re-run unchanged after M15-M18 forced four more cases to be added, so
the column is one consistent denominator rather than a mixture. Nothing was
re-run to improve a number; the re-run was to make them comparable.

| # | mutation | result |
| --- | --- | --- |
| M1 | the trip roster refusal in `lib/chatSync.ts` deleted | 28 / 1 — three `left_at` writes, the whole crew |
| M2 | the circle roster refusal in `lib/chatSync.ts` deleted | 28 / 1 |
| M3 | `groupChatSync`'s trip roster refusal deleted (back to the accidental `size === 0` shield) | 28 / 1 |
| M4 | `groupChatSync`'s active-member refusal deleted | 28 / 1 |
| M5 | `groupChatSync`'s circle roster refusal deleted | 28 / 1 |
| M6 | the recipient-preference `failed` row folded back into the normal path | 28 / 1 |
| M7 | `und` replaced by the server default `'en'` | 28 / 1 |
| M8 | the pipeline's thread-roster refusal deleted | 28 / 1 |
| M9 | the reply-context payload reverted to the always-null shape | 26 / 3 |
| M10 | only the QUOTE arm collapsed | 28 / 1 |
| M11 | only the LINKAGE arm collapsed | 27 / 2 |
| M12 | the mention fix reverted to `.single()` + `resolveHandle` | 28 / 1 |
| M13 | `actorHandleFrom` stops distinguishing a failed read | 27 / 2 |
| M14 | the group-chat translation degradation disabled | 28 / 1 |
| M15 | `lib/chatSync.ts`'s trip THREAD-roster refusal deleted | **STAYED GREEN** on the 25-case suite, 25 / 0 — then 28 / 1 |
| M16 | the reply-context outer `catch` reverted to bare `catch {}` | **STAYED GREEN** on the 25-case suite, 25 / 0 — then 28 / 1 |
| M17 | `lib/chatSync.ts`'s circle THREAD-roster refusal deleted | **STAYED GREEN** on the 27-case suite, 27 / 0 — then 28 / 1 |
| M18 | `groupChatSync`'s circle active-member refusal deleted | **STAYED GREEN** on the 27-case suite, 27 / 0 — then 28 / 1 |
| M19 | the original `body: null` put BACK into the group-chat delete handler, to prove the narrowed NOT NULL guard still catches it | 9 / 2 |
| N1 | the whole T349 emitter removed | 3 / 5 |
| N2 | the violation arm folded into `ok` | 7 / 1 |
| N3 | the unreadable arm folded into `ok` | 7 / 1 |
| N4 | the expired-refusal count deleted | 7 / 1 |
| N5 | SLO-04 reverted to `unmeasurable` while the emitter stays | 7 / 1 |
| N6 | the stopped-share count deleted | 7 / 1 |
| N7 | the metric key typo'd (`…leakages`) | 7 / 1 |

**Four stayed green, and that is the part worth reading.** M15, M16, M17 and M18
mutate guards this section WROTE, all four of them real — an unreadable thread
roster makes the upsert loop re-insert every accepted member; a THROWN
reply-context read reports a thread with no replies at all — and all four were
defended by nothing, because no fixture reached them. This is §14's B2 again and
it is now three sections in a row: *nothing counts as defence until a mutation of
it has been watched to fail.* Four cases were added — a client that THROWS rather
than resolving, for the `catch`, and the thread-roster read failed on its own in
both files and both discriminators — and all four mutations were re-run and went
red, which is the second number in each row. Both numbers are kept rather than
the green being quietly overwritten, because a mutation table that shows only
successes is the thing this table exists to distrust.

M9 and M11 are worth one line each, because their numbers rose when the suite
grew and that is a property of the fix rather than of the count. Reverting the
reply payload to the always-null shape (M9) fails THREE cases — the unreadable
quote, the unreadable linkage and the THROWN read — because all three converge on
the same wire contract; collapsing only the linkage arm (M11) fails two, and only
the quote arm (M10) fails one. Three mutations of one construct, three different
red sets: that is what tells a reader which line carries which rule.

**M19, added after the full suite found what the two suites above could not.**
`test/notNullWrites.test.ts` asserts that `routes/groupChat.ts` never nulls
`messages.body` — a real fix, a real NOT NULL column, and a check whose pattern
was `/body:\s*null/`. §17.4's synthesised translation row carries a
`translated_body: null` key, which that pattern matched, and the guard failed on
a column it is not about in a payload that never reaches a database. The cheap
way out would have been to rename a reference to dodge the regex. Instead the
pattern is narrowed to the PROPERTY (`/(?<![\w$])body:\s*null/`) and pinned by
two controls in the same test — it must still match
`.update({ deleted_at: now, body: null })` and must not match
`translated_body: null` — and then M19 put the original defect BACK into the
delete handler and watched two assertions go red (9 / 2), before restoring
`routes/groupChat.ts` byte-identical. A narrowed guard that has not been shown
to still catch its defect is a deleted guard with extra steps.

N7 deserves a note for the opposite reason. A typo'd metric key is IGNORED at
runtime by design — the recorder drops unknown keys rather than accumulating them
under a catch-all — so the only things that can catch it are a static check and a
test that reads the counter back. Both do.

### 17.7 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T349 | W | **C** | §28 "expired precise-location leakage = 0". The row's own evidence names one gap and one only: *"The guarantee is genuinely enforced (T216, T315) — but nothing measures it, so a regression would be silent."* Both halves now hold. Enforcement is unchanged and still proved by RLS-05 — two independent artifacts, an expiry gate before the handler and a coordinate strip on the way out — and the gate is now instrumented at four points, with what is counted chosen so the number means something: a refusal is `ok` because the target is zero leakage and a refusal IS zero; an unreadable share table is `unknown` because the denial was made without evaluating expiry; and a share admitted with NO expiry is a `violation`, because that is an unbounded live location — a state this schema permits and nothing had ever reported. Shown red before green (N1: 3 pass / 5 fail) and every arm mutated separately. **Stated so nobody over-reads this C: the counter is in-process and resets on restart, and there is no durable sink and no alerting — `check:telegraph-slos` says so in its own output. T349 asks that the guarantee be measured, not that a dashboard exist; T432 and T354 are the rows that ask for the sink and they remain N.** |

**T344 and T363 do NOT move**, and §17.8 is the list rather than the excuse.

### 17.8 What was read against the code and NOT closed

1. **T344 and T363 stay W, and the reason has changed shape.** §16.4 said a row
   that is W because a class is unfinished does not become C when one member is
   finished. That still holds, and the class is now enumerated rather than
   sampled. Every read spelled `const { data: x } = await` in
   `routes/messaging.ts` was opened and read — 24 code sites, plus the one that
   lives inside §14.3's own prose. The 24 fall into three groups and the counts
   are exact. **Eleven are refusals** — nine 403s on a membership read, plus the
   E2EE precondition and the translate-retry precondition — and the census's own
   rule is that a refusal is not a plausible empty state. **Three are neither**:
   the prior-preference read that decides whether a language change triggers a
   retranslate sweep, the status re-read inside an already-failing accept, and
   the preview-message insert whose failure merely skips a translation. **Ten are
   a different defect**: an unreadable table
   becomes a confident `not_found`, which is a POSITIVE false claim that the
   object does not exist. That is the class §16 closed exactly one instance of —
   the circle owner — and §15.2 named as a bullet. The remaining ten, and two
   more in the group-chat reader, are named here so the next lane starts from a
   list rather than a grep:

   > **ALL TWELVE ARE NOW CLOSED — see §18.** The citations in the table below
   > were re-anchored when they were fixed: each now names the site's SELECT
   > line, because the line the table originally named was the dropped-error
   > destructure itself and that line no longer exists. The "what an outage
   > becomes" column is therefore the PAST behaviour of each route, kept as
   > written because it is the evidence for what was wrong, not a claim about
   > the tree. §17.8 item 2's three remaining sites are still open and are not
   > in this table.

   | read | what an outage becomes |
   | --- | --- |
   | `artifacts/api-server/src/routes/messaging.ts:635#const { data: profile, error: profileErr } = await client.from('profiles').select('id').eq('id', recipientId).maybeSingle();` | "User not found" |
   | `artifacts/api-server/src/routes/messaging.ts:903#.select('id, sender_id, recipient_id, status, preview_text')` | "Message request not found" (accept) |
   | `artifacts/api-server/src/routes/messaging.ts:1155#.select('id, sender_id, recipient_id, status')` | the same, on decline |
   | `artifacts/api-server/src/routes/messaging.ts:1255#.select('id, sender_id, status')` | the same, on cancel |
   | `artifacts/api-server/src/routes/messaging.ts:3796#if (memberErr) { refuseUnreadableAccess(req, res, 'message_thread_members', { err: memberErr, threadId, userId: user.id }); return; }` | "Thread not found" |
   | `artifacts/api-server/src/routes/messaging.ts:1824#.select('id, thread_type, is_e2ee')` | the same, one read later |
   | `artifacts/api-server/src/routes/messaging.ts:3414#.select('id, thread_id, sender_id, body, deleted_at, original_language')` | "Message not found" (translate retry) |
   | `artifacts/api-server/src/routes/messaging.ts:3546#.select('id, thread_id, sender_id, body, deleted_at')` | the same, on edit |
   | `artifacts/api-server/src/routes/messaging.ts:3656#.select('id, title, destination_city')` | "Trip not found" |
   | `artifacts/api-server/src/routes/messaging.ts:136#.select('id')` | "Message not found in this thread" (save) |
   | `artifacts/api-server/src/routes/groupChat.ts:485#.select('id, thread_id, sender_id, body, deleted_at')` | "Message not found" (edit) |
   | `artifacts/api-server/src/routes/groupChat.ts:571#.select('id, thread_id, sender_id, deleted_at')` | the same, on delete |

   **They were not fixed here and the reason is scope, not difficulty**: each is
   four lines, and doing twelve credibly means twelve behavioural cases against
   twelve routes, which is a section of its own.

2. **The class is larger than `routes/messaging.ts`, which no prior section
   said.** Counted after this section's fixes: `routes/groupChat.ts` 7,
   `services/tagging/TaggingService.ts` 11, `services/telegraphChatSuggestions.ts`
   2, `lib/chatSync.ts` 2, `services/groupChatSync.ts` 2. Most are fail-closed and
   correct — `telegraphChatSuggestions` denies every context it cannot verify, and
   `TaggingService` tags nobody when it cannot read the block set. Two groups are
   not, and are named so they are not lost: the group-chat readers report an
   unreadable `message_threads` as `title: 'Trip Chat'`, `status: 'active'`
   (`artifacts/api-server/src/routes/groupChat.ts:337#const { data: threadRow, error: threadRowErr } = await sc`),
   so a closed or archived thread reads as active; and both sync
   implementations write a DURABLE generic title onto a newly created thread when
   `trips` is unreadable
   (`artifacts/api-server/src/lib/chatSync.ts:71#const { data: trip, error: tripErr } = await sc`,
   `artifacts/api-server/src/services/groupChatSync.ts:59#const { data: trip, error: tripErr } = await sc`).

   > **ALL THREE ARE NOW CLOSED — see §19**, along with three more of the same
   > defect the same two functions held and this list did not reach (the CIRCLE
   > reader, and the circle branch of BOTH sync implementations). **These three
   > anchors had to be REWRITTEN rather than repointed**, and the reason is the
   > one §16.6 and §15.8 give for the four before them: the line each named WAS
   > the defect. All three read `const { data: x } = await sc` with the error
   > dropped, which is what made the paragraph above true; each now binds the
   > error it used to drop, so there is no original line text left in the tree to
   > find. The original text is quoted here so the record of what was there is
   > not lost: `const { data: threadRow } = await sc` stood at line 213 of
   > routes/groupChat.ts, and `const { data: trip } = await sc` at line 58 of
   > lib/chatSync.ts and line 45 of services/groupChatSync.ts. Those three are
   > deliberately NOT spelled as citations, for the reason §16.6 gives about the
   > pair before them: spelled as a citation each would be a live claim about
   > where a deleted line sits, and `check:doc-citations` would be right to fail
   > it. The prose above is left exactly as written,
   > because it was true of the tree on the day it was written. That is the
   > fifth, sixth and seventh time this document has had to do this, for the
   > same reason every time.

3. **`safe_return_live_shares.expires_at` should be `NOT NULL` and this lane did
   not make it so.** §17.5 measures the hole; closing it is a migration, and a
   migration in the repo is not a migration applied. It also needs a decision
   about rows that already carry a null expiry, which is an owner's call.

4. **§13's 51 BRANCH rows, re-derived rather than inherited.** Of the 51: nine are
   now C (four from §14 — T79, T388, T430, T438; five from §15 — T3, T36, T37,
   T38, T290), one moved to BOTH (T31, §14.5), four moved to NEITHER (T4, T201,
   T218, T396, §15.5), and T349 is the tenth to reach C, here. **Twelve of the
   remaining thirty-six were re-read against the code this pass and every one is
   still open**: T31 (nothing in Telegraph calls `applyProtection`; the only other
   importer of that module takes `haversineMeters` and nothing else), T35 (all
   four legacy producers still write bespoke JSON — `circle_status_card` at
   `artifacts/api-server/src/routes/circle.ts:365#msg_type:  "circle_status_card",`,
   plus `discovery_card`, `post_card` and `compass_card` on the client), T123
   (eleven client modules still import the static tokens), T157 (`envelopeVersion`
   exists for §6.2's kinds and for coordination and for nothing else), T220, T295,
   T320 (`BookingMilestoneMessage.tsx` still contains no `fetch` and no
   `useEffect`), T344, T363, T379 (`TelegraphRelationship` appears nowhere in the
   tree), T397, T423 (`I18nManager` and `isRTL` appear nowhere in the client).
   T295's six client-side joins are not re-derived by hand here because a guard
   already measures them and its number is the one this pass read:
   `check:telegraph-slos` reports "6 client bypass site(s) across 3 file/table
   pair(s)" on this tree, which is T295's claim exactly, shrink-only, and still
   six.
   **One understatement corrected: §13.4 calls T220 "eight modules outside the
   shared helpers". Counted today, THIRTY non-test files query `blocks`
   directly, twenty-seven of them outside the three shared helpers
   (`lib/blockGuard.ts`, `lib/blocks.ts`, `lib/exclusionSet.ts`)** — more than
   three times the figure a reader sizing the work from §13.4 would take. That
   is a correction to the size, not to the classification: the row stays W and
   stays BRANCH.

### 17.9 The restated headline

`pnpm -s check:census-integrity` recomputes the per-census counts from the tables
rather than from any prose, and after this section telegraph reads:

```
census                        rows     C     W     N    X   denom  unreconciled
telegraph                      439   221   166    49    3     451  12 counted where this tool cannot read
```

> **RESTATED 2026-09-13 BY THE §17 LANE, from the merged row and not by
> addition: C 220 → 221, W 167 → 166, N 49, X 3. CONSTRUCTED (221+166)/451 =
> 85.8 %, CORRECT 221/451 = 49.0 %.** One BUILT-BUT-WRONG row moved to
> BUILT-AND-CORRECT (T349); no row moved into BUILT-BUT-WRONG and no row moved
> out of NOT-BUILT. The gap between CONSTRUCTED and CORRECT narrows from 37.0
> points to 36.8.
>
> **The 176 split restated: OWNER 24, BOTH 13, BRANCH 46, NEITHER 93** —
> unchanged from §15.7, because this section moved no row between groups. Of the
> 46 BRANCH rows, ten are now C and thirty-six are not.
>
> **What this number is not.** It is still a BRANCH census and this section's one
> move is on an unmerged branch. MERGED IS NOT DEPLOYED; DEPLOYED IS NOT FLAG
> ENABLED. Nothing here required a migration or a flag, so it is true on every
> deployment the moment this branch merges. **The four defects this section fixed
> moved no verdict at all, and that is the correct outcome twice over: three
> belong to a class that is still unfinished, and the fourth — the roster
> eviction — is a defect no row in this census had ever named.** A census that
> could only record work by moving a number would have no way to say that.

**The full suite: 20,165 tests, 20,163 passed, 2 failed, 0 skipped.** The run
before it had three. The third was this section's — the NOT NULL guard M19
narrows — and it is gone: fixed, green in isolation, red again under M19, and
green in the full run at the position it had failed at. The remaining TWO are
`test/tripOpportunityProjection.test.ts` cases 1 and 3, and they are NOT this
lane's: swapping all eight source files
this branch changed back to their `6d4fd1a06` content and re-running the file
reproduces both failures exactly (16 / 2), after which the eight were restored
and compared byte-identical. The file's own comment says why it is fragile —
*"the route runs on the real clock"* — and the failure is
`fw.executable[0]` being undefined, i.e. a free window that the wall clock has
moved out from under. Recorded rather than left as an unexplained red, and
recorded as somebody else's rather than claimed as a pass.

**CORRECTED AT INTEGRATION: on the merged branch those two are GREEN, and the
diagnosis above is why.** This lane measured against `6d4fd1a06`. The
integrating branch had already closed the same defect two commits earlier, in
`53615fd72`, by freezing the clock for that describe block
(`artifacts/api-server/src/test/tripOpportunityProjection.test.ts:192#before(() => { mock.timers.enable({ apis: ["Date"], now: NOW.getTime() }); });`).
Executed on the merged tree at 15:52 UTC — an hour at which the unfrozen file
had previously failed 16 / 2 — the file is **18 / 18**. So this lane's suite
result of 20,163 passed / 2 failed is correct for the commit it was taken at
and is NOT the number for the merged tree; the merged number is measured
separately below the integration's own gate, not inferred from this one. The
lane's reasoning was right and its arithmetic was right; only its base was
older than the fix.

Bookkeeping, stated because it is easy to do silently: `lib/publicIdentity.ts`
and the three new test files were added to `CENSUS_SCOPE` for this census, and
the telegraph acknowledgement entry was EXTENDED — not replaced, and not joined
by a second entry, which `check:census-freshness` reads past. Eight displaced
citations were repointed by exact original line text across census-compass,
census-trips and this document, and two anchors were rewritten because the line
they named WAS the defect and no longer exists — the third and fourth times this
document has had to do that, for the third and fourth time for the same reason.

## 18. §17.8's list, closed — twelve routes that answered "it does not exist" from a read that never happened

§17.8 enumerated twelve sites and left them with the reason stated plainly:
*"scope, not difficulty — each is four lines, and doing twelve credibly means twelve behavioural
cases against twelve routes, which is a section of its own."* This is that section. All twelve are
closed, and **no row moves**; §18.4 says why, and the reason is §16.4's own rule rather than
modesty.

### 18.1 What was wrong, and why this shape is worse than a silent empty

supabase-js RESOLVES on a database failure, so `const { data } = await …maybeSingle()` gives
`null` for two different worlds — the row is absent, and the table could not be read. Twelve
handlers turned the second into `sendError(res, 'not_found', …)`, which is a POSITIVE claim that
the object does not exist.

**A 404 is the one refusal a caller acts on by giving up.** A client told "Message request not
found" removes the request from its list and stops asking. A client told "please try again
shortly" retries. Fail-open authorization is the famous form of this defect; this form is the one
that corrupts the user's own model of their data, and it does so silently — nothing logs, nothing
alerts, and the traveller simply believes a thing of theirs is gone.

Executed against each route with the table failing, BEFORE the fix — these are the answers the
twelve gave, not a description of them:

| answer given from a read that never happened | count |
| --- | --- |
| `not_found` · *"Message not found"* | 4 |
| `not_found` · *"Message request not found"* | 3 |
| `not_found` · *"Thread not found"* | 2 |
| `not_found` · *"User not found"* | 1 |
| `not_found` · *"Trip not found"* | 1 |
| `not_found` · *"Message not found in this thread"* | 1 |

### 18.2 The fix is §16's, copied rather than reinvented

§16 closed exactly one instance of this class — the circle-owner read — and every one of the
twelve now takes that same posture: bind the error, log it at `error`, and answer
`degraded_unavailable`, this codebase's own code for *"the check was NOT PERFORMED"* and the only
code marked retryable in `lib/http.ts` RETRYABLE_CODES. A genuinely absent object still gets the
404 it deserves, on the line below the guard. Two postures for one defect class would have been
worse than one wrong posture.

The twelve are pinned by
`artifacts/api-server/src/test/telegraphNotFoundHonesty.test.ts:1#/**`, twenty-four cases: each
site gets the outage case AND a CONTROL that a genuinely missing object is still `not_found`, so a
route that had been deleted, or one that answers 503 for everything, fails the pair.

### 18.3 The measurement error this section made, and what it would have hidden

Several of these handlers read the SAME table more than once before reaching the site under test —
the auth gate reads `profiles`, the membership gate reads `message_thread_members`. Failing a
table outright would stop the request at the EARLIER read, and the case would go green while
proving nothing about the site named. So each case measures first: it runs clean, finds the target
read by its exact select string, and re-runs with the error injected from that operation onward.

**The first draft got that offset wrong by one, and it is recorded because of what it did rather
than what it cost.** `afterOps: N` in this harness means *"inject once N operations have ALREADY
happened"* — fail from N+1 onward — so the value that fails the read under test is the count of
reads BEFORE it, not that count plus one. With the wrong value every `profiles` case silently
tested the NEXT read on the table: the request came back `forbidden` from the permission gate
instead of `not_found` from the site, which happened to look like a failure and so was caught.
**Had the next read been a harmless one, twelve cases would have gone green against an unfixed
defect** — the §F.10 failure mode, in a file written to close it. The red-first measurement was
therefore RE-TAKEN with the corrected offset before any fix was credited: twelve outage cases red,
twelve CONTROLs green, on the tree with the guards reverted.

**Mutations, both directions.** Guards absent: 12 of 24 fail, and they are exactly the twelve
outage cases. Guards made unconditional (`if (true || err)`): 13 of 24 fail, including all twelve
CONTROLs — which is what proves the controls are load-bearing and not decoration. Both reverts
`cmp`-verified byte-identical.

`check:unchecked-supabase-reads` still exits 0: none of the twelve carried an allowlist key, so
this closed no ledgered defect and staled no entry. 203 related suites re-run — 3,354 tests,
3,354 passed.

### 18.4 NO ROW MOVES, and this is §16.4's rule rather than caution

§16.4: *"a row that is W because a class is unfinished does not become C when one member is
finished."* Twelve members are now finished and the class is still unfinished, in two ways that
are named rather than waved at.

**T344's own remaining evidence is a DIFFERENT subset.** Its current statement names four reads —
the per-viewer translation read and the trip, booking and circle context reads in the inbox
projection — each of which *"renders an untranslated message or a thread with no trip context when
the table is unreadable."* That is a different consequence from a false `not_found`, and not one
of the four is among the twelve closed here. They were not re-derived in this section, and saying
so is the point: a row whose named evidence has not been re-read cannot move on work that did not
touch it.

**§17.8 item 2's three sites are also still open**: the group-chat reader that reports an
unreadable `message_threads` as `title: 'Trip Chat'`, `status: 'active'` — so a closed thread
reads as active — and both sync implementations, which write a DURABLE generic title onto a newly
created thread when `trips` is unreadable. A durable wrong title is the worst of the three
consequences in this class, because unlike a 404 it does not go away when the outage does.

So **T344 and T363 stay W**, smaller than they were and smaller than §17.8 left them, with the
remainder enumerated rather than estimated.

### 18.5 What would turn this red (P24)

A thirteenth route added with the same shape and no guard — nothing in this repository would catch
it, because `check:unchecked-supabase-reads` scopes itself to reads where the empty answer is an
ACCESS or STATE decision, and a false `not_found` is neither. That scope is deliberate and its own
header says so; whether it should widen to cover *"a read whose empty answer becomes a confident
assertion to a user"* is a decision worth taking explicitly, with a measured count, rather than by
quietly editing a regex. The twelve here are pinned by tests; the thirteenth would not be.

## 19. §17.8 item 2, closed — and the class §18 measured is larger than §18 could see

`head_commit: 6d4327d66` — the base this section measured and built on. Every count, every
line number and every red-first measurement below was taken against that tree or against this
branch, never against a description of it.

§18.4 left T344 and T363 W for two stated reasons and named both precisely. This section closes
the second, re-derives the first, and finds that **neither was the whole reason** — the defect
class extends into three route files inside this census's own `CENSUS_SCOPE` that no section has
ever enumerated. **No row moves**, and §19.5 says why in terms of §16.4's rule rather than
caution.

### 19.1 The three sites §18.4 named, and the four more beside them

§18.4's words, quoted because they are the specification this section executed against:

> *"§17.8 item 2's three sites are also still open: the group-chat reader that reports an
> unreadable `message_threads` as `title: 'Trip Chat'`, `status: 'active'` — so a closed thread
> reads as active — and both sync implementations, which write a DURABLE generic title onto a
> newly created thread when `trips` is unreadable. A durable wrong title is the worst of the
> three consequences in this class, because unlike a 404 it does not go away when the outage
> does."*

All three are closed. Opening them found FOUR more sites of the same defect — three in the very
same two functions, one in the reader that serves both endpoints — and they are named here rather
than left for a later grep. Seven sites in total:

1. **There are TWO group-chat readers, not one.** `GET /circles/:circleId/chat` has the identical
   shape — `?? 'Trusted Circle'`, `?? 'active'`, `?? null` on `createdAt` and `lastMessageAt`.
   §17.8's citation named the trip reader; on this base the circle reader is the same block of
   lines, 62 lines below it.
2. **Both sync implementations have a CIRCLE branch with the same durable defect**, sourced from
   an unread `profiles` rather than an unread `trips`: `lib/chatSync.ts` writes
   `'Trusted Circle'` and `services/groupChatSync.ts` writes `circleThreadTitle('Circle')`.
   **Four durable sites, not two.** Closing the two §17.8 named and leaving these would have shut
   the class by exactly the shape it was opened for.
3. **`fetchMessagesForThread` dropped the error on the `messages` read itself.** `(data ?? [])`
   turned an unreadable `messages` into A CONVERSATION WITH NO MESSAGES — the same payload a
   brand-new thread produces, served to a member looking at a thread full of history. That is
   T344's *"plausible empty **context**"* and T363's *"plausible empty **state**"* in the
   plainest form this tree contains, and **no section of this census had named it.** An array
   cannot say "I could not read", so the function's return type now says it instead.

| site | what an outage used to become | now |
| --- | --- | --- |
| `artifacts/api-server/src/routes/groupChat.ts:344#req.log.error({ err: threadRowErr, threadId, tripId },` | a CLOSED trip thread reported `status: 'active'`, `title: 'Trip Chat'` | `degraded_unavailable` |
| `artifacts/api-server/src/routes/groupChat.ts:437#req.log.error({ err: threadRowErr, threadId, circleOwnerId },` | the same, `title: 'Trusted Circle'` | `degraded_unavailable` |
| `artifacts/api-server/src/routes/groupChat.ts:173#if (msgsErr) return { ok: false, error: msgsErr };` | a thread full of history rendered as an empty chat, in BOTH readers | `degraded_unavailable` |
| `artifacts/api-server/src/lib/chatSync.ts:77#if (tripErr) {` | a new trip thread named `'Trip Chat'` forever | `null` — the value this function already uses for "could not sync" |
| `artifacts/api-server/src/lib/chatSync.ts:265#if (ownerProfileErr) {` | a new circle thread named `'Trusted Circle'` forever | the same `null` |
| `artifacts/api-server/src/services/groupChatSync.ts:94#if (tripErr) {` | a new trip thread named `'Trip Chat'` forever | a thrown Error, as every other write failure in that function |
| `artifacts/api-server/src/services/groupChatSync.ts:292#if (ownerProfileErr) {` | a new circle thread named after the fallback `'Circle'` forever | the same throw |

### 19.2 The posture is §18.2's, and the refusal is placed at the DURABILITY

Routes bind the error, log it at `error`, and answer `degraded_unavailable` — this codebase's own
code for *"the check was NOT PERFORMED"* and the only code marked retryable in `lib/http.ts`
RETRYABLE_CODES. Two postures for one defect class would have been worse than one wrong posture,
so nothing here is invented.

The two sync functions are **not routes** and each already had an answer for "could not sync" —
`null` in `lib/chatSync.ts`, a thrown Error in `services/groupChatSync.ts`, both of which every
caller already handles. They use the one they have rather than gaining a third.

One placement decision is deliberate and is stated because it looks like an omission. In
`services/groupChatSync.ts` the title read runs on EVERY call but is load-bearing on exactly one
— the call that creates the thread and stamps the title. The refusal is therefore in the create
branch, not at the read. Refusing at the read would turn a cosmetic outage into a failed sync for
every healthy trip and circle chat in the system, which is a worse answer than the defect. Two
cases in the suite assert that placement directly, so the narrower guard cannot be widened by
accident and called an improvement.

### 19.3 Red first, and the mutations

The suite is `artifacts/api-server/src/test/telegraphDurableContextHonesty.test.ts:1#/**`,
eighteen cases: eight outage cases, eight CONTROLs that the healthy tree still reports the REAL
title, the REAL status and the messages that exist, and two that the refusal is placed at the
durability rather than at the read.

**Red first, measured rather than described.** With all three source files reverted to their
`6d4327d66` content and the suite unchanged: **10 passed, 8 failed** — and the eight failures are
EXACTLY the eight outage cases. The ten green are the eight CONTROLs and the two placement cases,
which is correct: they describe behaviour that already existed. With the fixes restored:
**18 passed, 0 failed.** The three files were then compared byte-identical to the fixed versions
with `cmp`.

**Nine mutations, none survived.**

| mutation | result |
| --- | --- |
| All three files reverted to `6d4327d66` (all seven guards absent at once) | 8 of 18 red — exactly the eight outage cases |
| All seven guards made unconditional (`if (true \|\| err)`) | 8 of 18 red — exactly the eight CONTROLs, which is what proves the controls are load-bearing and not decoration |
| Each of the seven guards neutralised ALONE (`if (false && err)`) | every one red, and each redirected exactly the case(s) it owns: the two thread-row guards one case each, the `messages` guard two (it serves both readers), the four durable-title guards one each |

**The two placement cases stayed GREEN under the unconditional mutation, and that is correct
rather than a gap.** That mutation makes the CREATE-branch refusal fire unconditionally; the two
placement cases exercise the path where the thread ALREADY EXISTS, which never enters that
branch. They are red under a mutation that moves the refusal out of the create branch — which is
the mutation they exist for — and the seven single-guard mutations cover the branch itself.

253 tests across the twelve suites that import `routes/groupChat.ts`, `lib/chatSync.ts` or
`services/groupChatSync.ts` (`accessControl`, `circleMemberRemovalHonesty`, `groupChat`,
`messageLanguageProvenance`, `notNullWrites`, `p2LaneCResolverFailClosed`,
`telegraphAdversarialFixtures`, `telegraphContextReadHonesty`, `telegraphEventUnion`,
`telegraphNotFoundHonesty`, `telegraphRlsAuthorizationMatrix`, `telegraphRosterReadEviction`):
**253 passed, 0 failed.** A green partial run is not a green run and this section does not claim
one.

### 19.4 The class is LARGER than §17.8 counted, and the missing part is not a rounding error

§17.8 item 2 wrote down the class beyond `routes/messaging.ts` as a count:
*"`routes/groupChat.ts` 7, `services/tagging/TaggingService.ts` 11,
`services/telegraphChatSuggestions.ts` 2, `lib/chatSync.ts` 2, `services/groupChatSync.ts` 2."*
Recounted on this base with the shape both §17.8 and §18 use — `const { data: x } = await` and
its unrenamed twin `const { data } = await` — **the enumeration is missing three whole files, and
every one of them is inside this census's own `CENSUS_SCOPE`** (`checkCensusFreshness.ts`,
`census-telegraph.md` entry): `routes/telegraph.ts` **5**, `routes/telegraphChat.ts` **8**,
`routes/telegraphStream.ts` **1**. Fourteen sites, none of them ever counted by any section of
this document. (`routes/groupChat.ts` also holds EIGHT on this base rather than seven; this
section does not attempt to reconstruct which read §17.8's number omitted, only to state the one
it measured.)

Read against the code, one by one, they are NOT all benign:

| file / site | classification |
| --- | --- |
| `routes/telegraph.ts` — 5 sites (a `feature_flags` gate, hashtag-follow enrichment, hashtag resolution, mention-profile resolution, the follow sets) | **Fail-closed or enrichment.** An unreadable table degrades the prompt or links nobody; `friends_only` users are EXCLUDED rather than admitted. The `blocks` read in the same block already binds and logs. Nothing here makes a claim to a traveller about their own data. |
| `routes/telegraphStream.ts:454#const { data: membership, error: membershipErr } = await client` | **Fail-closed when §19 measured; CLOSED by §22.3, and the anchor text itself changed** — the read named here WAS the defect and the line now binds the error it used to drop, exactly as §16.6 and §20.4 record for their own sites. §19's classification was right on its own terms: an unreadable membership resolved to `forbidden`, and a refusal is not a plausible empty state. It was still a false statement about the caller's own membership, and §20.7 named it. |
| `artifacts/api-server/src/routes/telegraphChat.ts:80#async function verifyThreadMember` and `artifacts/api-server/src/routes/telegraphChat.ts:301#const { data: tripMembership, error: tripMembershipErr } = await client` | **Fail-closed when §19 measured; CLOSED by §22.3, and BOTH anchor texts changed** — the first is now cited by the function rather than by a line that no longer exists in that form, because `verifyThreadMember` returns three outcomes instead of a boolean. The same shape as the `telegraphStream.ts` row above and closed the same way. |
| `routes/telegraphChat.ts:200#res.status(200).json({ suggestions: suggestions ?? [] });` | **OPEN when §19 measured; CLOSED by §20.2.** The line still exists and is cited here at its current number; a refusal now stands above it, so the sentence that follows describes the tree at `6d4327d66`, not this one. It was T363's exact shape. An unreadable `telegraph_chat_suggestions` answers `{ suggestions: [] }` — "you have none" from a read that never happened. |
| `routes/telegraphChat.ts:340#sendError(res, "not_found", "Suggestion not found");`, `artifacts/api-server/src/routes/telegraphChat.ts:446#sendError(res, "not_found", "Suggestion not found");`, `artifacts/api-server/src/routes/telegraphChat.ts:543#sendError(res, "not_found", "Suggestion not found");` | **OPEN when §19 measured; CLOSED by §20.2** — each now sits below a bound-error refusal, and each is cited at its current number. They were §18's class — three MORE sites of the defect §18 declared closed at twelve.** Same table, same `.maybeSingle()`, same confident 404 from a dropped error. |
| `routes/telegraphChat.ts:225#const { data: suggestion, error: suggestionErr } = await client` | **OPEN when §19 measured; CLOSED by §20.2, and the anchor text itself changed** — the error is bound now, so the line §19 quoted no longer exists in that form. Small. The dismiss handler reads the suggestion only to write a preference event; an unreadable read silently writes no event and says nothing. |
| `routes/telegraphChat.ts:516#if ((threadMeta as any)?.is_e2ee === true) {` | **OPEN when §19 measured; CLOSED by §20.1–§20.3, which re-derived it from the file before accepting the lane's report. It was the worst site in this document's class — a FAIL-OPEN on the E2EE invariant.** The read above it drops its error, so an unreadable `message_threads` arrives as `null`, `undefined === true` is false, and a poll body — JSON **plaintext** — is written into a thread that may be end-to-end encrypted. The route's own comment names the invariant it is failing (*"Never write server-readable plaintext into an end-to-end encrypted thread … audit MSG-3"*). `routes/messaging.ts` fixed its own equivalents: the media handler's is `artifacts/api-server/src/routes/messaging.ts:3296#const { data: threadMetaForMedia, error: threadMetaForMediaErr } = await client`. This is a divergence between two files that make the same decision, not an open design question. |

**Thirteen of the fourteen are invisible to `check:unchecked-supabase-reads`** — verified by
running it with `--all` on this tree, which prints every out-of-scope and ledgered site it knows
of. Exactly two of the fourteen appear, both already ledgered FAIL-CLOSED
(the `verifyThreadMember` read, `artifacts/api-server/src/routes/telegraphChat.ts:80#async function verifyThreadMember`, and the
`feature_flags` gate in `routes/telegraph.ts`); the `{ suggestions: [] }`, the three confident
404s, the silent preference-event skip and the E2EE fail-open are all outside its scope and none
is on any ledger. That is §18.5's prediction landing, one section later and from a direction
§18.5 did not look: the scope gap it warned about is not only "a thirteenth route somebody adds",
it is **twelve unledgered sites that were already there.**

**This section did NOT fix them, and the reason is ownership, not difficulty.** `routes/telegraph.ts`,
`routes/telegraphChat.ts` and `routes/telegraphStream.ts` are not this lane's files. They are
named here with line-anchored citations so the next lane starts from a list rather than a grep,
and the E2EE fail-open is flagged to the owner as the one item on the list that is not a
reporting defect.

### 19.5 NO ROW MOVES — and §18.4's stated reason was necessary, not sufficient

§16.4's rule: *"a row that is W because a class is unfinished does not become C when one member
of the class is finished."* §18.4 applied it and named two remaining blockers for T344 and T363.
This section tested that reading rather than inheriting it, and the result is that **the reading
was right about the rule and incomplete about the class.**

**T344's own four named reads ARE closed, and this section re-derived them rather than assuming
it.** §18.4 declined to, and said so: *"They were not re-derived in this section, and saying so
is the point."* Re-read against the code on this base, all four now bind their error and none
reports an absence it did not establish:

| T344's named read | state on this base |
| --- | --- |
| the per-viewer translation read in the inbox projection | binds `tErr`, sets `previewTranslationsDegraded`, and the preview carries `previewTranslationStatus: 'failed'` — §18's own word for "we did not translate this" |
| the trip context read | binds `tripErr`; `tripCity` is OMITTED (undefined) rather than reported `null` |
| the booking context read | binds `bookingErr`; `bookingId` is OMITTED rather than reported `null` |
| the circle context read in `GET /me/unread-counts` | binds `circleErr` and logs; `newHighlights` under-reports as 0 by a deliberate, test-pinned decision — see §19.6 |

**§17.8 item 2's three sites are closed by §19.1, and three more with them.**

So both of §18.4's stated blockers are gone, and **T344 and T363 still do not move**, because
§19.4 found the class open in three files the enumeration never reached — including a
`{ suggestions: [] }` from a read that never happened, which is T363's own sentence, and three
more confident `not_found`s, which is the class §18 exists for. A row cannot become C on an
enumeration that has just been shown to be short by three files.

| id | was | now | evidence |
| --- | --- | --- | --- |
| T344 | W | W | **Still W, and for a different reason than §18.4 gave.** Both of §18.4's blockers are closed: this section shut §17.8 item 2's three durable sites plus three more of the same defect in the same two functions (§19.1), and the four reads this row's own statement names were re-derived and are all bound (§19.5's table). What keeps it W is new: `routes/telegraph.ts`, `routes/telegraphChat.ts` and `routes/telegraphStream.ts` are in this census's `CENSUS_SCOPE` and hold FOURTEEN sites of this class that no section had counted, of which `routes/telegraphChat.ts:200#res.status(200).json({ suggestions: suggestions ?? [] });` is a plausible empty context and three more are confident 404s (§19.4). **Ceiling: those three files are not this lane's, and a row is closed by whoever can close all of it.** |
| T363 | W | W | **Still W, same evidence, same ceiling.** T363's wording — "plausible empty **state**" — is if anything a closer fit for `{ suggestions: [] }` than T344's is. The messaging-tree half this row has always cited is now down to the eleven refusals and three neither-sites §17.8 classified (§19.6 re-reads all three and confirms the classification); the open remainder is outside `routes/messaging.ts` entirely. |

Restated plainly, because it is the finding a reader should take from this section rather than
the row moves: **the two sections before this one each believed they were finishing a class, and
each was measuring a subset it had no way to know was a subset.** §17.8 enumerated
`routes/messaging.ts` exhaustively and sampled everything else. §18 closed the twelve §17.8
handed it. This section closed the three §18 handed it, found three more beside them, and then
found fourteen more in files nobody had opened. The census's own scope list was the thing that
could have caught it at any point, and nothing was reading it.

### 19.6 Read against the code and deliberately NOT changed, with the reason for each

> **CLOSED 2026-09-15 BY THE SWALLOWED-READS LANE — items 1, 2, 3 and the first half of
> item 4.** §19's stated reason for leaving all four was a COST, not a judgement about the
> code: *"Changing it would shift every line below it in a 3,900-line file, and this
> section is not spending that on a log."* That cost is real — this file carries ~45
> anchored citations from this census and four more from census-compass and census-trust —
> and it turned out to be avoidable rather than payable: all four were repaired IN PLACE,
> replacing lines one-for-one, so `routes/messaging.ts` is the same length at the same
> lines and not one citation in any census moved. The three anchors below are repointed to
> the text that is now at those lines. **Item 2 was not the small one §19 took it for** —
> see §27. Each item keeps §19's original reasoning verbatim; the closure note follows it.


1. **`artifacts/api-server/src/routes/messaging.ts:413#const { data: before, error: beforeErr } = await client` — the prior-preference read.** §17.8 classified it "neither" and
   the classification holds for a reason worth writing down, because it is not obvious: the gate
   it feeds already distinguishes three worlds (`lib/retranslateGate.ts:35#if (i.oldLanguage === undefined) return true;`
   — *"oldLanguage undefined means the caller cannot tell; treat as a change"*), and the call
   site collapses the read to `?? null`. But `null !== newLanguage` is true for every non-empty
   `newLanguage`, so `null` and `undefined` produce the IDENTICAL decision at this call site. The
   only thing lost is a log line. Changing it would shift every line below it in a 3,900-line
   file, and this section is not spending that on a log.
   **CLOSED 2026-09-15, and the reasoning above is correct about the gate and wrong about
   what it costs.** `null` and `undefined` really do produce the identical decision here —
   which is exactly the problem, because that identical decision is *sweep*. The call site
   now refuses on `beforeErr` (`artifacts/api-server/src/routes/messaging.ts:438#if (newLang && !beforeErr && shouldRetranslateOnLanguageChange({`),
   so an unreadable prior language fires nothing. What was lost was never only a log line:
   `retranslateForUser` sweeps up to `RETRANSLATE_BATCH_LIMIT` messages through the PAID
   translation provider, so EVERY FAILING SAVE billed a ~200-message sweep for a change
   nobody had made. The warn is there too
   (`artifacts/api-server/src/routes/messaging.ts:417#if (beforeErr) req.log.warn`).
2. **`artifacts/api-server/src/routes/messaging.ts:945#const { data: current, error: currentErr } = await sc` — the status re-read inside a lost CAS race.** The claim's
   substance is true: the update matched no row, so the request really is no longer pending. What
   is guessed is WHICH state (`?? 'accepted'`), so an outage can name the wrong one. Real, small,
   and the same line-shift cost. Named rather than fixed.
   **CLOSED 2026-09-15, and "small" was the one word to argue with.** A request leaves
   `pending` in exactly two ways, and one of them is `declined`; so the guess was wrong
   about a REFUSAL roughly as often as it was right, and what it told the recipient was
   that the other party had ACCEPTED them. That is not a degraded answer, it is a false
   one, and it is a false claim about another person's decision. The error is bound; a
   readable status is still named and still answers the same 400; an unreadable one
   answers `degraded_unavailable` — the only code `lib/http.ts` marks retryable — because
   the true sentence is *"this was already answered and we cannot tell you how"*, and the
   retry re-runs the guard at the top of the handler, which names the real status once the
   table is back. Pinned by
   `artifacts/api-server/src/test/messagingSwallowedReadHonesty.test.ts:336#!/accepted/i.test(body),`.
3. **`artifacts/api-server/src/routes/messaging.ts:1114#const { data: previewMsg, error: previewErr } = await sc` — the preview-message insert.** A write chain, not a read;
   `check:silent-supabase-writes` territory and out of this class by that checker's own scope.
   **CLOSED 2026-09-15 anyway, because being outside a checker's scope is not the same as
   being handled.** The 200 has already been sent when this insert runs, so the log is the
   ONLY record the write can leave; with the error discarded, a preview that never landed
   left the thread created, the accept reported, the first message missing and nothing
   anywhere saying why. It stays best-effort — the accept is not undone — and it is now
   logged (`artifacts/api-server/src/routes/messaging.ts:1118#if (previewErr) req.log.error`).
4. **`GET /me/unread-counts` reports `newHighlights` and `meetups` as `0` when their inputs are
   unreadable.** The same file states the opposite rule for the inbox projection — *"undefined
   (omitted from JSON) means 'not known', which is a different statement from 0 and must stay
   different on the wire"* — and applies it to `needsActionCount`, `tripCity` and `bookingId`.
   The inconsistency is real. It is NOT changed here because the under-reporting is a deliberate
   decision that is already PINNED BY A TEST this lane does not own:
   `artifacts/api-server/src/test/exclusionFailClosedRoutes.test.ts:510#assert.equal(r.body?.newHighlights, 0,`
   asserts the zero explicitly, with the reason (*"an unreadable block list must under-report,
   never count a blocked user's highlight"*). Omitting the field would turn that green test red
   in a file this lane may not edit. **This is an owner decision between two rules the tree
   currently holds at once**, and it is surfaced rather than taken. Measured, so the decision is
   cheap: the only client consumer already reads `res.data.newHighlights ?? 0`
   (`travel-buddy-standalone/src/hooks/useMessaging.ts:638#setNewHighlights(res.data.newHighlights ?? 0);`),
   so omission would change the wire and not the badge.
   **HALF-CLOSED 2026-09-15, on the half that was never the owner decision.** The `0` on
   the wire is untouched and the test that pins it is untouched: this lane did not take the
   decision §19 surfaced. What it closed is a different defect inside the same block — the
   highlights COUNT query was the last read in there whose error was not bound at all,
   while its two neighbours (the block set and the circle read) each already log. So the
   badge under-reported from an unreadable `highlights` with nothing anywhere saying it
   had (`artifacts/api-server/src/routes/messaging.ts:1566#if (hCountErr) req.log.warn`).
   Zero-by-failure and zero-by-fact are still the same number on the wire, and are no
   longer the same in the log. **The owner decision in the rest of this item is still open.**
5. **`services/telegraphChatSuggestions.ts` — both sites are fail-closed and stay as they are.**
   An unreadable `message_threads` denies every context flag; an unreadable `circle_memberships`
   denies circle context. One label is imprecise — the verdict's `reason` is `"thread_not_found"`
   for a thread that could not be READ, while the sibling field on the same object already says
   it properly (*"the thread could not be read"*). It denies either way, so no traveller is
   misled; changing a `reason` value that callers may switch on is a contract change this section
   has no evidence to justify.
6. **`services/tagging/TaggingService.ts` — 11 sites, not re-derived here.** §17.8 read them and
   recorded them as fail-closed (*"tags nobody when it cannot read the block set"*). This section
   did not re-open them and does not restate the finding as its own.

### 19.7 The restated headline

`npm run -s check:census-integrity` recomputes the per-census counts from the tables rather than
from any prose, and after this section telegraph reads:

```
census                        rows     C     W     N    X   denom  unreconciled
telegraph                      439   221   166    49    3     451  12 counted where this tool cannot read
```

> **RESTATED 2026-09-13 BY THE §19 LANE, from the tool and not by addition: C 221, W 166, N 49,
> X 3 — UNCHANGED. CONSTRUCTED (221+166)/451 = 85.8 %, CORRECT 221/451 = 49.0 %.** No row moved
> in either direction, and for work that closes seven sites that is the correct outcome twice
> over: three are the ones §18.4 named, and they belong to a class §19.4 has just shown is still
> open in three files this lane cannot reach; the other four — the circle reader, the two
> circle-branch durable titles, and the empty conversation — are sites no section of this census
> had ever named, so there was no row waiting on them to move. A census that could only record
> work by moving a number would have no way to say either thing.
>
> **The 176 split is unchanged from §17.9: OWNER 24, BOTH 13, BRANCH 46, NEITHER 93.** Of the 46
> BRANCH rows, ten are C and thirty-six are not. This section moved no row between groups. Two
> of the thirty-six were re-read against the code here and both stay open with their §13.4
> classification questioned rather than changed: **T39** — §15.8's finding is confirmed
> independently, `VISA_CARD` has no referent anywhere (no `visa*` table exists in
> `src/test/generated/liveColumns.json`'s 426 tables, and the identifier appears in exactly two
> places in the server tree — its own vocabulary entry and one test assertion that
> `shareableFor` returns null for it — plus one client union member), so §13.4's
> "loaders" is wrong for that half and the row is arguably NEITHER — and **T268**, whose
> remaining half §13.4 also calls "loaders" and which is not: a safe-share derivative needs a
> GRANT, and `shareAuthorizationPolicy.ts` records in its own registry that *"no derivative grant
> exists anywhere in this tree"*. Both are left where §13 put them, because a reclassification is
> a judgement and two independent confirmations of somebody else's finding are not a mandate to
> act on it.
>
> **MERGED IS NOT DEPLOYED; DEPLOYED IS NOT FLAG ENABLED.** Nothing in this section needs a
> migration or a flag, so it is true on every deployment the moment this branch merges.

### 19.8 What would turn this red, and what this section did not run

**P25.** A fourth group-chat reader, or a third sync implementation, added with the same
`?? 'Trip Chat'` shape. Nothing in this repository would catch it: `check:unchecked-supabase-reads`
scopes itself to reads whose empty answer is an ACCESS or STATE decision, and a durable generic
title is neither. §18.5 asked whether that scope should widen to *"a read whose empty answer
becomes a confident assertion to a user"*; §19.4 is the second measured count in two sections
that says it should, and it now has a number attached — fourteen unseen sites in three files, one
of them a fail-open on an E2EE invariant.

**Not run:** the full suite, by instruction — the machine is shared and three lanes hold it. What
ran: `npx tsc --noEmit` (clean), `bash scripts/run-all-checks.sh`, `npm run -s check:doc-citations`,
`npm run -s check:citation-targets`, `npm run -s check:census-integrity`, and the thirteen suites
named in §19.3. **`check:test-registration` is RED on this branch by instruction**: the new suite
is deliberately not registered in `artifacts/api-server/package.json`, which this lane may not
edit, and is listed for the integration owner to register.

---

## 20. The three files §19 could not reach — and the E2EE gate that an outage opened

*Integration owner, 2026-09-13, on the merge of `lane-telegraph-arch` into `claude/sweet-fermat-fmx7up`.
§19.4 closed with an explicit ceiling: "those three files are not this lane's, and a row is closed
by whoever can close all of it." They are this lane's. This section is the rest of it.*

### 20.1 The finding I re-derived before accepting it

§19.4 reported a fail-open on the end-to-end-encryption invariant. That is the kind of claim a
lane does not get taken on trust, so it was re-read from the file rather than from the report.
It is exactly as reported.

`routes/telegraphChat.ts` refuses to post a poll into an E2EE thread, because a poll body is JSON
plaintext and the route has no encryption path. Its own comment names the invariant it serves
(*"Never write server-readable plaintext into an end-to-end encrypted thread"*). It then read the
flag with the error discarded — `const { data: threadMeta } = await client…` — and **supabase-js
resolves on a database error rather than throwing**. An unreadable `message_threads` therefore
yields `{ data: null, error }`, the discarded error is invisible, `null?.is_e2ee === true`
evaluates `false`, and the plaintext poll body is written into a thread that may be
end-to-end encrypted. The one gate that exists to prevent that outcome opens.

This was never an open design question, and that is what makes it a defect rather than a choice.
`routes/messaging.ts` makes the **identical decision** on the media path, binds the error, and
answers `degraded_unavailable`; its comment states the same reasoning in almost the same words —
an unreadable flag *"read as `is_e2ee: false` and let a plaintext media message through the one
gate that exists to stop it."* Two files, one decision, two answers. This section settles it the
way the already-correct one does.

### 20.2 Six sites closed in `routes/telegraphChat.ts`

| Site | An outage used to mean | Now |
|---|---|---|
| the E2EE flag on start-poll | `is_e2ee: false` — **plaintext admitted to an encrypted thread** | `degraded_unavailable`, nothing written |
| `GET …/telegraph/suggestions` | `{ suggestions: [] }` — "you have none" | `degraded_unavailable` |
| the suggestion read on add-to-plan | `not_found` — "no such suggestion" | `degraded_unavailable` |
| the suggestion read on create-meetup | `not_found` | `degraded_unavailable` |
| the suggestion read on start-poll | `not_found` | `degraded_unavailable` |
| the preference read on dismiss | the event was silently skipped | logged at `error`; the dismiss still succeeds |

The dismiss is deliberately **not** refused. That preference event is best-effort by construction —
the insert below it warns rather than failing — so turning a cosmetic outage into a failed dismiss
would be a worse answer than the defect. It has no test case, and the reason is recorded rather
than left as an apparent omission: the harness cannot fail one operation on a table without
failing the `UPDATE` beside it, and a case that cannot isolate its subject asserts nothing.

### 20.3 Red first, then two mutations

`src/test/telegraphChatOutageHonesty.test.ts`, 12 cases, 5 outage and 7 CONTROL.

- **RED**, with `routes/telegraphChat.ts` restored byte-for-byte to `6d4327d66`: **7 passed,
  5 failed**, and the five failures are exactly the five outage cases. The seven controls pass,
  correctly — they describe behaviour the healthy tree already had.
- **GREEN**, with the fixes: **12 / 0**. The file was then `cmp`-verified byte-identical to the
  fixed copy, so the green run is against the shipped file and not a third state.
- **Mutation — the E2EE guard made unconditional** (`if (true || threadMetaErr)`): 3 failed, and
  they are the two E2EE controls plus start-poll's `not_found` control. That is the right three:
  it proves the controls are load-bearing, not decorative.
- **Mutation — the suggestions-list guard neutralised** (`if (false && suggestionsErr)`): exactly
  1 failed, its own case. The guards are individually scoped rather than jointly covered.

The E2EE outage case asserts on the **store**, not only on the status: no `messages` row may be
inserted. A 503 returned after the plaintext had already been written would satisfy a status
assertion and violate the invariant, so the assertion is placed where the invariant is.

### 20.4 An error of mine, recorded because it is this document's own recurring class

The first application of these guards put the start-poll guard **inside the create-meetup
handler**. The cause: there are two `.select("id, title")` occurrences in the file, the insertion
searched for the first one and then for the next `if (!suggestion)` after it, and landed in the
wrong route. It typechecked, because `suggestionErr` is in scope in both handlers; it made
create-meetup check its error twice and start-poll check it not at all.

That is the same class as repointing a citation by offset instead of by exact original text —
the defect §16.6 and §19 have each had to correct. It was caught only because the test was
written first and start-poll's outage case stayed red at `not_found`. Had the test been written
after the fix, or had the two handlers happened to behave alike, a guard absent from the handler
it was written for would have shipped under a green run.

### 20.5 The remaining sites, enumerated and classified independently

§19.4 counted fourteen sites of this class across the three files. All fourteen were re-enumerated
here directly from the tree, not from §19's list, and the count agrees: `routes/telegraph.ts` 5,
`routes/telegraphChat.ts` 8, `routes/telegraphStream.ts` 1. Six of `telegraphChat.ts`'s eight are
closed in §20.2. The remaining **eight** were each opened and classified:

| Site | Class | What an outage produces |
|---|---|---|
| `telegraph.ts` feature-flag read | fail-closed | flag falsy → no location context; inside an explicit `catch { /* non-fatal */ }` |
| `telegraph.ts` followed-hashtags read | enrichment | fewer personalisation inputs; no claim is made to the user |
| `telegraph.ts` hashtag-metadata read | **fail-closed, traced** | a slug absent from the map produces **no span at all** (`if (meta)`), so it renders as plain text — it is *not* rendered as an unblocked hashtag |
| `telegraph.ts` profile/`tag_permission` read | fail-closed | no handle resolves, so no mention is emitted |
| `telegraph.ts` follow-edge read | fail-closed | the follow sets are empty, so permission checks deny |
| `telegraphStream.ts` membership read | fail-closed | `forbidden` |
| `telegraphChat.ts` `verifyThreadMember` | fail-closed | `forbidden` |
| `telegraphChat.ts` trip-membership read | fail-closed | `forbidden` |

The hashtag-metadata read was traced rather than classified by inspection, because `is_blocked`
travels through it and an empty map could plausibly have meant "nothing is blocked". It does not.

### 20.6 Two rows move, and the exact thing that would falsify the move

| id | Was | Now | Evidence |
|---|---|---|---|
| T344 | W | **C** | §19's statement named its own blocker precisely: fourteen uncounted sites in three files, "of which `routes/telegraphChat.ts:200#res.status(200).json({ suggestions: suggestions ?? [] });` is a plausible empty context and three more are confident 404s". That plausible empty context and those three 404s are closed in §20.2, with the red measurement in §20.3. The messaging-tree half was re-derived and bound in §19.5. The eight sites that remain are enumerated and classified in §20.5 and not one of them produces a plausible empty context. |
| T363 | W | **C** | Same evidence. T363's wording — "plausible empty **state**" — was §19's closer fit for `{ suggestions: [] }`, and `{ suggestions: [] }` is the thing that no longer happens on an unread. |
| | | | |

**What would turn these red.** One of the eight sites in §20.5 turning out to be a plausible empty
state rather than a refusal or an absent enrichment. Three of them answer `forbidden` from a read
that never happened, and by this row's own established rule — stated at its §18-era statement,
*"a refusal is not a plausible empty state"* — a 403 does not count against it. If that rule is
rejected, these two moves are rejected with it, and §20.7 is the row that should then be opened
rather than these two reverted.

### 20.7 A different defect, named rather than folded in

Three sites answer `forbidden` — *"Not a thread member"*, *"You are not an accepted member of that
trip"* — from a membership read that never happened. That is safe: it denies rather than admits.
It is also false: the server does not know whether the caller is a member, and says it does. It is
**not** the T344/T363 defect (nothing plausible and empty is presented as truth) and it is not
folded into those rows to make them look larger or smaller. It needs a decision this section does
not take, because it is a contract change on three live routes: an outage on an authorization read
should arguably answer `degraded_unavailable` rather than `forbidden`, and the client's retry
behaviour differs between the two — `degraded_unavailable` is the only code in `lib/http.ts`
RETRYABLE_CODES, so the change makes these calls retry where today they do not.

### 20.8 Checks

Both new suites are registered in `artifacts/api-server/package.json` — the lane could not, it is
the integration owner's file. `check:test-registration` is consequently **green** (1,149
registered), where §19 left it deliberately red.

`npx tsc --noEmit` clean. 191/191 across the new suite plus every file that imports the edited
route (`telegraphChat.test.ts`, `telegraphChatSuggestionsPrivacy.test.ts`, `accessControl.test.ts`,
`failOpenServiceReads.test.ts`, `tripKernel.test.ts`, and §19's own new suite).

**Not claimed:** a full-suite pass. The first run exited 0 but its log ended mid-test with no
summary block and only 256 top-level assertions against 1,138 registered files — an exit code
without a summary is inconclusive, and inconclusive is not a pass. It is being re-run; this
section does not rest on it, and no row above rests on it either.

---

## 21. TELEGRAPH lane, 2026-09-14 — six rows, and four objects that needed no table

This section was written in worktree `/home/user/wt-483` (detached at `7d1f2d498`) by the
TELEGRAPH lane, working only inside `services/telegraph/**`, `services/telegraph*.ts`,
`routes/telegraph*.ts`, `lib/*telegraph*` and this file. **Nothing here is merged, nothing is
deployed, and no flag was enabled.** Every row below rests on code in that worktree and on tests
run there.

### 21.1 What was re-derived before anything was written

Four W rows were re-executed against the tree rather than taken from the census. Two of them were
still true, one was true with a stale reason, and one had been true and is no longer:

| Row | The census's reason | What the tree said on 2026-09-14 |
|---|---|---|
| T11 | "there is still no LAYER: unresolved actions are interleaved with conversation" | **True.** `grep` for `semanticLayer`, `layerOf` and the literal `"TALK"` over `artifacts/api-server/src` and `travel-buddy-standalone/src` returned nothing. Every §6.2 and §8 message was read back through the same page as ordinary conversation. |
| T84 | "a projection over one thread's messages is not a queryable store" | **True.** No route took a user id and returned commitments; `projectCommitment` had exactly one caller, the per-thread view. |
| T85 | "a session object would need a table and would then be capped at W by the migration anyway" | **True that no entity existed. The REASON is wrong** — see §21.3. |
| T179 | "no consumer can answer 'was *this* message seen'" | **Half stale.** `GET /threads/:id/receipts` (`routes/telegraphLifecycle.ts:111#/threads/:threadId/receipts`) is exactly such a consumer and has been since T73 was restated — it derives per-message seen from the one receipt row per member. What was genuinely absent was the §13.2 EVENT. |

### 21.2 §2.3's layers exist on the server, and the conversation screen still ignores them

`services/telegraph/layers.ts` computes §2.3's TALK / PLAN / NOW for one viewer, and
`GET /api/threads/:id/layers` serves it (`routes/telegraphCoordination.ts:968#"/threads/:threadId/layers"`).

The property that makes it a layer rather than a tag is a **partition**: an id in `plan` or `now`
is not in `talk`, and a PLAN item that has resolved is back in `talk`
(`services/telegraph/layers.ts:234#export function projectSemanticLayers`). The route asserts the
partition on every response rather than only in the suite
(`services/telegraph/layers.ts:431#export function partitionViolations`).

An unresolved ACTION needed a way to stop being unresolved, or the layer would have filled with
items that could never leave it — the renderer's Confirm control says "Confirmation is not
available on this screen" in so many words. So `ACTION_RESPONSE` was added
(`services/telegraph/coordination.ts:573#export const ActionResponsePayload`), validated against an
action proposal in the same thread the way an ACKNOWLEDGEMENT already was.

### 21.2b Two more objects that needed no table, and one registry

**The executable-action registry (§30A.10).** `confirm-action` had three of the four hooks as three
inline stretches of one handler, keyed off nothing: a fifth `ProposedAction.kind` could be added to
`buildResponse` with no hook at all and nothing would notice.
`services/telegraph/actionRegistry.ts:213#export const TELEGRAPH_ACTION_REGISTRY` registers all
four for every kind, and the exhaustiveness is a TEST that reads the route's own source rather than
a promise. `execute` deliberately does not write the canonical object — §30A.10's second sentence
is a prohibition — so every registration names the `canonicalOwner` that does, and the test refuses
a registration that names Telegraph.

**The safety mode (§15.2).** §13.4 classified T217 NEITHER on the grounds that "a conversation-level
safety mode does not exist in either tree". Both carriers were already in the thread: §6.2's SAFETY
kind enumerates `check_in | heads_up | need_help | all_clear`, and §9.1 has `NEED_HELP`. The mode is
a fold over them. The rules worth stating are the asymmetries: ATTENTION decays after six hours, an
EVENT never decays and is cleared only by an explicit ALL CLEAR, a routine CHECK-IN clears nothing,
and the mode is the HIGHEST unresolved signal rather than the latest — so a calmer message posted
after a help request does not step the conversation down.

### 21.3 A CoordinationSession does not need a table, and this section disagrees with T85 in writing

T85's closing sentence — "a session object would need a table" — is the one claim here that is
contradicted rather than extended. A ConversationDecision has an id, an asker, a deadline and a
result, and it is carried as a MESSAGE: the message id IS the decision id. So is a commitment, so
is an acknowledgement. Appendix A's rule points at messages for a session exactly as it did for
those three.

`COORDINATION_SESSION` opens one and `COORDINATION_TRANSITION` records a move through §9's machine,
DISRUPTED included (`services/telegraph/coordination.ts:674#export const CoordinationTransitionPayload`).
The projection folds them (`services/telegraph/coordination.ts:767#export function projectCoordinationSession`)
and the route REFUSES an arrow §9 does not have, naming the legal set
(`routes/telegraphCoordination.ts:506#§9 allows`). §9.1's separation survives: `declaredState` and
`derivedState` are two fields that are never merged, and `state` prefers the declaration because a
person saying "we are stuck in traffic" outranks a clock that thinks the table is booked.

### 21.4 Six rows move

| id | Was | Now | Evidence |
|---|---|---|---|
| T84 | W | **C** | **`ConversationCommitment` — who agreed to what, by when, completed.** The four questions were already answered per thread; what the row asked for was "something a surface can list". `GET /api/me/commitments` (`routes/telegraphCoordination.ts:1163#"/me/commitments"`) answers ACROSS every conversation the caller is still an active member of, from the caller's own memberships, each thread's rows bounded by that thread's own §14.3 window, built from the SAME `projectCommitment` the thread view uses (`services/telegraph/coordination.ts:374#projectCommitment`). Not a new store: a query is a route, not a table, and every bound the answer was computed under is reported so a truncated list cannot read as "that is everything you owe". |
| T85 | W | **C** | **`CoordinationSession`.** The four things the row said were missing now exist: an id (the opening message's own), who started it (`startedBy`), when it ended (`endedAt`, set only on COMPLETE or CANCELLED), and a recordable DISRUPTED (`services/telegraph/coordination.ts:767#export function projectCoordinationSession`). Reachable at `POST /api/threads/:id/coordination` and returned as `coordination.session`. The row's "would need a table" is answered in §21.3. |
| T179 | W | **C** | **§13.2 `message.seen`.** In the union and deliberately alongside `read.updated` rather than replacing it (`lib/telegraphEvents.ts:84#message.seen`), published with the MESSAGE IDS that crossed the reader's marker by `POST /api/threads/:id/seen` (`routes/telegraphLifecycle.ts:443#"/threads/:threadId/seen"`). A consumer can now answer "was this one seen" from the event itself. |
| T217 | W | **C** | **§15.2 safety mode NORMAL → SAFETY_ATTENTION → SAFETY_EVENT.** The row's gap was "neither [ladder] is a conversation-level mode", and §13.4 classified it NEITHER — "A conversation-level safety mode does not exist in either tree". It does now, and it needed no table: both carriers were already in the thread and already written by shipped routes — §6.2's SAFETY kind (`check_in \| heads_up \| need_help \| all_clear`) and §9.1's `NEED_HELP` quick state. `projectSafetyMode` (`services/telegraph/safetyMode.ts:239#export function projectSafetyMode`) folds them; `GET /api/threads/:id/safety-mode` (`routes/telegraphCoordination.ts:1464#"/threads/:threadId/safety-mode"`) serves it, membership-gated and §14.3-bounded, and answers 500 rather than NORMAL on an unreadable thread. Three rules are asserted because a careless projection gets each of them wrong: a SAFETY_EVENT is cleared only by an explicit ALL CLEAR and never by time; a routine CHECK-IN does not clear a help request; and the mode is the HIGHEST unresolved signal, not the latest. |
| T410 | W | **C** | **§30A.10 every executable action registers authorize / preview / execute / optional compensate; Telegraph orchestrates, source domains retain truth.** The row's gap was "No registry, no compensate". `TELEGRAPH_ACTION_REGISTRY` (`services/telegraph/actionRegistry.ts:213#export const TELEGRAPH_ACTION_REGISTRY`) registers all four hooks for every `ProposedAction.kind` the route can produce, and the registry is EXHAUSTIVE by test rather than by intention — `src/test/telegraphCommandRoute.test.ts:531#the registry is EXHAUSTIVE` reads the route's own source, extracts every `kind: "…"` literal, and fails on one that is not registered. `confirm-action` REFUSES an unregistered kind (`routes/telegraphCommands.ts:419#const registration = registrationFor(action.kind);`) rather than confirming it with three hooks silently skipped. Compensate is reachable, not decorative: §30A.11's capability recheck runs AFTER the write (`routes/telegraphCommands.ts:468#const recheck = await registration.authorize(ctx);`) and a membership lost in that window UNDOES the orchestration record (`services/telegraph/actionRegistry.ts:180#const undoConfirmation`), answering 409. "Source domains retain truth" is enforced by the same test: every registration names a `canonicalOwner` and it may not be `telegraph`. |
| T268 | W | **C** | **§20 Memories — safe share derivatives · Memory Notes · explicit Save to Memory · post-experience recap.** MIS-GRADED, and the correction at §13.1 ("Safe-share derivatives are the remaining half and they are loaders") is itself stale: the loader exists and is registered. `loadMemory` (`services/telegraph/shareables.ts:483#const loadMemory`) is a derivative — title and city only, no items, no media, no graph — that re-checks `state`, `visibility`, `allowed_user_ids`, `hidden_user_ids` and blocks, and degrades rather than approximating. Memory Notes are T117/T118 C, Save to Memory is T119 C (`services/telegraph/memoryNotes.ts:144#export function memoryDraftRow`), recap is T121 C (`services/telegraph/memoryNotes.ts:242#export function buildRecap`). Four of four. |

**What would turn these red.** T217: a `check_in` clearing an EVENT, an uncleared help request ageing out of the mode, a later lesser signal de-escalating the thread, or the §9.1 carrier being dropped — all four were run as mutations, §21.6, and the third of them found a test that could not fail. T410: an action kind produced by the route with no registration (the test reads the route, so this is checked, not trusted); the post-write recheck removed, which leaves the 409 path dead; or a `compensate` that reports `undone: true` without deleting the row — all three were run as mutations, §21.6. T84: a commitment in a thread the caller has left appearing in the
list, or the cross-thread query collapsing to one thread. T85: a session whose `endedAt` stays null
through CANCELLED, or an illegal transition accepted by the route. T179: a `message.seen` that
names no message ids, or a marker that can be advanced past a message the caller cannot see. T268:
a `friends_only` Memory resolving for a non-friend — measured, see §21.6.

### 21.5 Five rows stay W, and exactly which half closed

| id | Verdict | What closed, and what did not |
|---|---|---|
| T11 | **W** | The LAYER is built and served (§21.2) and unresolved actions are separated from conversation by a partition the route enforces. It stays W because the separation is not yet DRAWN: `travel-buddy-standalone/app/messages/[id].tsx` still renders one stream, and this lane holds no client file. The remaining work is a client that consumes `GET /threads/:id/layers`; the server half it needs now exists. |
| T218 | **W** | §15.2's promotion list now EXISTS as server-side data in the spec's own order — trusted contact, current status, official help, route/return, call, block/report, location scope, with entertainment de-prioritized (`services/telegraph/safetyMode.ts:143#export const SAFETY_PROMOTED`) — and it is served with the mode, so the ordering is one answer both clients would get rather than two layouts. It stays W for exactly the half the row names: **nothing reorders**. `components/ThreadSafetySheet.tsx` and the conversation screen are client files this lane does not hold. §13.4's note that "a layout that reorders affordances under a mode that has no referent cannot be written" is answered — the referent is T217 — but the layout is not. |
| T12 | **W** | **Semantic layer NOW.** The row's reason — "it is a PANEL, not a LAYER: the message stream underneath is unchanged" — is answered on the server by the same partition T11 gets: a §9.1 quick state, a rendezvous, a SAFETY message, a LOCATION message and a NOW-class action proposal are all lifted OUT of `talk` and into `now` (`services/telegraph/layers.ts:160#export function layerOfMessage`). "Minimal conversation" is now EXPRESSIBLE — the stream the client is handed is genuinely shorter while the thread is coordinating. It stays W for the same reason T11 does: nothing draws it yet, and this lane holds no client file. |
| T262 | **W** | **§20 Trips.** Was two of five, corrected to three by §13.1 (TRIP is shareable). **Today/next context is now four of five**: `GET /api/threads/:id/trip-context` (`routes/telegraphSharedContext.ts:641#"/threads/:threadId/trip-context"`) reads `trip_plan_items` — Trips' own canonical table, written by nothing here — and answers today's items and the next one after them, membership-gated TWICE. The second gate is the point: it re-verifies ACCEPTED trip membership rather than trusting the thread roster, because T319 records that the two writes are not one transaction and a removed member is on the roster until a sync runs. It returns no coordinates at all — they are not selected, which is stronger than stripped (`routes/telegraphSharedContext.ts:574#const TRIP_CONTEXT_COLUMNS`) — and it states its own day frame as UTC rather than implying a destination-local one it cannot compute (census T423). Fifth item, the Trip Kernel commands, is wiring into `server/trips/commandRoute.ts`, which this lane does not own. |
| T40 | **W** | **Evidence correction, verdict unchanged.** "Photo and video only … No voice, GIF or file" is stale on the GIF clause: §6.2's GIF kind is sendable, validated and indexed — `GifPayload` (`services/telegraph/messageKinds.ts:61#export const GifPayload`), in `SENDABLE_ENVELOPE_KINDS` (`services/telegraph/messageKinds.ts:197#export const SENDABLE_ENVELOPE_KINDS`), with its own drawer tab and its own renderer (T64). So §5's Media family is three of five carriable, not two. It stays W and this lane did not touch it: voice and file both need the MIME and storage widening §13.4 names, and §13.4's other note stands — there is no GIF PROVIDER, so a kind that can be carried still cannot be obtained. A correction to the count is not a change to the verdict. |
| T70 | **W** | §7.2's threshold is now checkable on one path: `POST /threads/:id/seen` takes a MESSAGE, not a clock reading, refuses one that is absent, deleted, in another thread or outside the caller's §14.3 window, and stamps the MESSAGE's own `created_at` so "seen" cannot run ahead of what was sent (`routes/telegraphLifecycle.ts:485#const threshold = String(t.created_at)`). The marker never moves backwards. It stays W because the legacy path in `routes/messaging.ts` still stamps `now()` on any authenticated call and this lane does not own that file — while both paths exist, seen is still whatever the client asserts on the one that is wired into the app. |

### 21.5b Rows opened, re-derived, and deliberately not touched

Each of these was read against the tree before being set down, and each has a blocker this lane
could not cross without breaking a rule it was given. None of their verdicts moved.

| id | Why not, concretely |
|---|---|
| T4 | The rail's missing `memories` resolver. §13.1 records the blocker as an **owner decision** on whether private-by-default content may surface in a shared rail, and §13.5 reclassified it BRANCH → NEITHER on that basis. A resolver could be written narrowly enough to dodge the decision — admitting only memories where the counterpart has an APPROVED `memory_tags` row and the viewer already passes `loadMemory`'s own gate — but "narrowly enough to dodge it" is this lane deciding the thing the owner was asked to decide. Left alone. |
| T31 | `lib/protectedLocations.ts` has no Telegraph consumer, and one is easy: a §6.2 LOCATION message carrying coordinates could pass `zoneCovers` before it is stored. **It was not written because it would be a live regression.** `protected_zones` is not one of production's 431 tables (`baseline/20260907_production_tables.txt`), so a fail-closed gate would refuse every exact-location message on every deployment today, and a fail-OPEN gate is not a gate. Distinguishing "table absent" from "read failed" is possible and is exactly the kind of subtlety that gets a privacy gate wrong. The row's other two clauses — it belongs to the Map programme, and its policy table ships empty by design — are unmovable by this lane in any case. |
| T39 | Buddy profile and Visa Buddy loaders. The Buddy-profile half is writable (`rent_buddy_profiles` exists). The Visa Buddy half **has no referent anywhere in Portava**: "Visa Buddy" appears in the Layover and Passport specs and in no table, route or component, and census-layover L274 scores the path itself N. A loader for it would be an invention, so the row cannot reach C and a one-of-two move was not worth the risk of a third `rent_buddy_*` reader. |
| T157 | A versioned payload envelope is pure code and §6.2's kinds already do it. The four producers that do not — `discovery_card`, `post_card`, `compass_card`, `circle_status_card` — are in client files and `routes/circle.ts`, none of which this lane owns. **Cross-lane.** |
| T166 · T169 · T170 | §13.1 commands. The behaviour exists (DECISION/VOTE, the seven quick states, SHARE_LOCATION as an action proposal); what is missing is exposure on the command bus, which is `server/telegraph/commandRoute.ts` and `domain/telegraph/commands/telegraphCommands.ts`. **Cross-lane.** |
| T201 | An add-participant operation. §13.5 already answered this: "There is no thread type on which an add-participant operation would be correct" — `message_threads.chk_thread_context` ties every non-direct thread to a trip or a circle whose membership is the source of truth, and §14.3 says a third person on a DM forms a new group. Building one would violate the schema's own CHECK. |
| T379 | A canonical `TelegraphRelationship`. Writable as a module; worthless as one. The row's complaint is that FOUR resolvers independently infer relationship state, and adding a fifth without retiring the four makes the anti-pattern worse. The four live in `lib/messagingPermissions.ts`, `services/interactionPermissions.ts` and `compass/CompassTools.ts`. **Cross-lane.** |
| T104 | In-thread availability-conflict detection. Buildable, and inert: T28 records that `open_to_plans_windows_enabled` is seeded OFF and on no database, so the availability read returns `enabled:false` and nothing else on every deployment. A conflict detector over a read that always returns nothing is a feature that cannot be exercised. |

### 21.6 Every test was shown red first, and two mutations exposed tests that could not fail

`src/test/telegraphCoordination.test.ts` 81/81 and `src/test/telegraphLifecycle.test.ts` 43/43.
Each new block was written and run BEFORE the implementation (9, 6, 7 and 8 failures respectively,
all 404 or missing-field). The mutations:

| mutation | result |
| --- | --- |
| `projectSemanticLayers` pushes PLAN items into `talk` as well | pass 65 / fail 3 — the two separation tests and the disjointness test |
| a resolved PLAN item never leaves the layer | pass 66 / fail 2 |
| `/me/commitments` queries only the first thread | pass 73 / fail 1 — "answers across every thread" |
| the completed-commitment filter deleted | pass 73 / fail 1 |
| `endedAt` never set | pass 80 / fail 1 |
| `derivedState` merged with `declaredState` | pass 80 / fail 1 — §9.1's separation |
| the route accepts any transition | pass 79 / fail 2 |
| the seen marker excludes nothing the reader sent | pass 40 / fail 2 |
| the seen marker may move backwards | pass 41 / fail 1 |
| the §30A.11 post-write recheck deleted | pass 27 / fail 1 |
| `compensate` reports `undone: true` without deleting the row | pass 27 / fail 1 — the test asserts the row is GONE, not that the response says so |
| one kind dropped from the action registry | pass 27 / fail 1 — the exhaustiveness test, read from the route's own source |
| the registry's `authorize` stops reading `trip_members` | pass 26 / fail 1 (`telegraphAdversarialFixtures` F-10) |
| a safety `check_in` clears like an `all_clear` | pass 90 / fail 1 |
| a SAFETY_EVENT decays on the attention timer | pass 90 / fail 1 |
| the §9.1 `NEED_HELP` quick state is not read as a safety signal | pass 90 / fail 1 |
| the trip-context second gate (accepted trip membership) removed | pass 38 / fail 1 |
| trip-context selects and returns `lat` / `lng` | pass 38 / fail 1 |
| removed plan items kept in today's list | pass 38 / fail 1 |
| **the safety mode takes the LATEST signal instead of the highest** | **pass 91 / fail 0 — GREEN**, then 91/1 after a case was added |
| **the seen threshold stamped `now()` instead of the message's `created_at`** | **pass 42 / fail 0 — GREEN** |

That last one is the one worth reading. The mutation turns the new endpoint back into the legacy
behaviour T70 names, and the suite did not notice: every message in the fixture predates `now()`,
so the crossed set was identical and the only test that read the marker's exact value returned
early. A test that cannot fail is worse than no test, so a case was added — a message sent AFTER
the threshold, which must NOT be marked seen — and the same mutation then failed 42/1. Both numbers
are recorded because the difference between them is the whole value of running the mutation.


The safety-mode mutation is the second test in this section that could not fail on first
measurement, and it failed the same way the seen-threshold one did: the fixture happened to make
the wrong rule and the right rule agree. "A need-help raises SAFETY_EVENT" put the heads-up BEFORE
the need-help, so latest and highest were the same signal. A case with the heads-up AFTER was added
— a conversation quietly stepping down from an emergency because somebody typed something calmer —
and the mutation then failed 91/1. Two of eleven mutations exposed a hollow assertion; that ratio
is the argument for running them.

The T268 move was earned the same way rather than asserted from reading: `loadMemory`'s visibility
gate was deleted and `src/test/telegraphShare.test.ts` went 35/1 ("a friends_only Memory degrades
rather than being approximated"), restored to 36/36.

### 21.7 Checks

`npx tsc -p tsconfig.json --noEmit` clean. `check-test-typecheck` **864 diagnostics across 116
files against a baseline of 864 across 116** — this lane added none. Readings of 865, 870, 871 and
872 were taken during the session and every one of them was another lane's in-flight file in the
shared worktree (`verificationWebhookSignature`, `memoryGraphRoute`, `airport`,
`layoverPresenceDegraded`, `discoveryCandidate`, `discoveryCacheBEligibility`); all had cleared by
the end and none was in a file this lane owns.

`check:telegraph-certification`, `check:telegraph-package-boundaries`,
`check:telegraph-share-producers`, `check:telegraph-slos` and `check:census-integrity` pass.
**1089 tests across the 46 Telegraph-named suites plus `intelligence.test.ts`, 0 failures.**
`tripTelegraphProjection.test.ts` failed once at the file level with 18/18 subtests green and
exit code 1; it has not reproduced in the two runs since, and it is recorded as a flake rather
than as a pass, because an unreproduced failure is not the same as no failure.

**`check:doc-citations` — a debt this lane created and repaired.** Inserting into
`services/telegraph/coordination.ts`, `routes/telegraphCoordination.ts`,
`routes/telegraphLifecycle.ts` and `routes/telegraphSharedContext.ts` shifted 24 anchored citations
in this document. Every one was verified against `git show HEAD:` to have been correct before the
edit and was re-anchored to its new line — mechanically, by a script that refuses to move an anchor
whose needle occurs more than once, so a citation can never be quietly pointed at a different
occurrence. One broken anchor in this file is NOT this lane's and was left alone: the
`routes/memories.ts` line-1951 anchor carried by rows T119 and §10.29 — that file is being edited
by another lane in the same worktree and the needle now resolves ambiguously to two lines.

**`check:census-freshness` will report this document STALE** once this lane's work is committed.
`CENSUS_STALENESS_ACKNOWLEDGED.json` is the integration owner's file and this lane did not touch
it. §21.4 and §21.5 are a re-measurement of the ten rows they name and of nothing else; the other
149 W rows in this document have NOT been re-read by this lane and the acknowledgement should not
be written as though they had.

### 21.8 The headline is NOT restated, and it was already stale before this lane

`check:census-integrity` counted this document at **C=223 W=164 N=49 X=3 across 439 verdict rows**
when this lane opened it, against §1's stated 209 / 176 / 51 / 3. That 14-row gap is not this
lane's and is not repaired here: §1's closing paragraph says it is "the document's last statement
and the one to quote", and rewriting another author's closing tally is not a thing a lane does to
its own advantage. After §21.4 the counter reads **C=229 W=158 N=49 X=3** — the six rows this
section moves, and nothing else. Whoever restates §1 should restate it from the counter, not from
here.

### 21.9 Not claimed

  - Nothing here is merged, deployed or flag-enabled, and no row above depends on a migration.
  - `ACTION_RESPONSE`, `COORDINATION_SESSION` and `COORDINATION_TRANSITION` are new values of a
    COMPUTED `msg_type`. `check:telegraph-share-producers` passes — the computed site is declared —
    but the declaration's `produces` list in
    `domain/telegraph/policies/shareAuthorizationPolicy.ts` still names seven values and is now
    three short. The checker does not verify that list is exhaustive, so this is a registry gap CI
    will not catch. **Cross-lane request to the integration owner: add `action_response`,
    `coordination_session` and `coordination_transition` to that declaration's `produces`.**
  - Five of the six endpoints this lane added have no client: `GET /threads/:id/layers`,
    `GET /me/commitments`, `POST /threads/:id/seen`, `GET /threads/:id/safety-mode` and
    `GET /threads/:id/trip-context`. They are REACHABLE — mounted through
    `routes/index.ts:188#telegraphSharedContextRouter`, `:192#telegraphCoordinationRouter` and
    `:192` — and unmounted in the app's UI. That is precisely the state T11, T12, T218 and T262
    stay W for, and it is why those four rows did not move.
  - The sixth, `confirm-action`, was already on the live path and its behaviour changed: an
    unregistered action kind is now refused, and a confirmation whose authorization is lost
    mid-flight answers 409 with the record removed instead of 200. Both are new refusals on an
    endpoint a client already calls.
  - The census's own headline is not restated (§21.8), and the 149 W rows this section does not
    name were not re-read.

---

## 22. TELEGRAPH lane, resumed — §21's six rows re-proved from scratch, two tests that could not fail, and §20.7's three false refusals

The container running the lane that wrote §21 restarted and took the agent with it. The work
survived at `88b9e8e1a`; **the evidence did not.** No mutation had been re-run and no failing-first
proof existed for anything in §21 outside that agent's own transcript. This section is the debt
paid, and then the list continued.

Same worktree (`/home/user/wt-483`), same ownership — `services/telegraph/**`,
`services/telegraph*.ts`, `routes/telegraph*.ts`, `lib/*telegraph*` and this file. **Nothing is
merged, nothing is deployed, and no flag was enabled.**

### 22.1 §21's six moves, re-proved — and the ratio holds

Every row §21.4 moved was re-executed against the tree: its suite run, the implementation mutated,
the suite re-run, the mutation reverted by file copy, and the suite re-run green. Twenty-three
mutations, every one of them RED. **No row is moved back**, and none needed to be.

| row | mutation | result |
| --- | --- | --- |
| T84 | `/me/commitments` queries only the first thread | 94 → 93/1 |
| T84 | the completed-commitment filter deleted | 94 → 93/1 |
| T84 | **the `scope=mine` filter deleted** | **94 → 94/0 — GREEN**, then 93/1 once two cases were added (§22.2) |
| T85 | `endedAt` never set | 94 → 93/1 |
| T85 | `derivedState` merged into `declaredState` (§9.1's separation) | 94 → 92/2 |
| T85 | the route accepts any §9 transition | 94 → 92/2 |
| T179 | `message.seen` names no message ids | 43 → 42/1 |
| T179 | the seen threshold stamps `now()` instead of the message's `created_at` | 43 → 42/1 |
| T179 | the crossed set includes the reader's own messages | 43 → 41/2 |
| T217 | a `check_in` clears like an `all_clear` | 94 → 93/1 |
| T217 | a SAFETY_EVENT decays on the attention timer | 94 → 93/1 |
| T217 | the mode takes the LATEST signal instead of the HIGHEST | 94 → 93/1 |
| T217 | the §9.1 `NEED_HELP` quick state is not read as a safety signal | 94 → 93/1 |
| T410 | one kind dropped from the action registry | 28 → 27/1 |
| T410 | `compensate` reports `undone: true` without deleting the row | 28 → 27/1 |
| T410 | the §30A.11 post-write recheck deleted | 28 → 27/1 |
| T410 | the registry's `authorize` stops reading `trip_members` | 27 → 26/1 (`telegraphAdversarialFixtures` F-10) |
| T268 | `loadMemory`'s visibility gate deleted | 36 → 35/1 |
| T11/T12 | `projectSemanticLayers` pushes PLAN items into `talk` as well | 94 → 91/3 |
| T11/T12 | a resolved PLAN item never leaves the layer | 94 → 92/2 |
| T262 | the trip-context second gate (accepted trip membership) removed | 39 → 38/1 |
| T262 | trip-context selects **and returns** `lat`/`lng` | 39 → 38/1 |
| T262 | removed plan items kept in today's list | 39 → 38/1 |

**Two of §21.6's recorded mutations did not reproduce as written, and the difference is not
cosmetic.** §21.6 recorded "trip-context selects and returns `lat` / `lng`" and "removed plan
items kept in today's list" as 38/1. Re-run with the NARROWEST possible mutation — adding
`lat, lng` to `TRIP_CONTEXT_COLUMNS` and nothing else; deleting the post-query `removed_at` filter
and nothing else — both were **GREEN**. The fixture client honours `.is("removed_at", null)` in the
query, so the second filter is unreachable defence; and the response test pins the PROJECTION, so a
select list that pulls coordinates into process memory is invisible to it. Both went red only when
the mutation was made faithful to the sentence (also mutating `toContextItem`, removing both
filters). §21.6's numbers were therefore right about the ROUTE and wrong about what the suite
actually constrains. §22.2 closes the gap the narrow mutation exposed.

### 22.2 Three tests that could not fail, and the cases added

The programme's stated ratio — roughly one hollow assertion per five mutations — held again.

1. **`/me/commitments` scope.** The route's own comment says `scope=all` "is opt-in rather than the
   default so this route cannot become a way to watch what other people have promised." Deleting
   the `scope === "mine"` filter passed 94/94. Every commitment in the fixtures happened to be one
   Alice had agreed to, so "mine" and "all" returned the same list and the branch that separates
   them was never exercised. Two cases were added — a promise **Bob** made and agreed to himself,
   which must not appear in Alice's default list and must appear under `scope=all`; and an
   unanswered ask addressed **to** Alice, which must appear, so the filter cannot be narrowed to
   `viewerResponse === "AGREED"` instead. The same mutation then failed 93/1.

2. **The trip-context select list.** `GET /threads/:id/trip-context` states
   `coordinatesReturned: false` and its header argues that "not selecting them is stronger than
   stripping them, because there is then no branch that could stop stripping". Nothing pinned the
   SELECT. A test now reads the route's own source, parses `TRIP_CONTEXT_COLUMNS` and fails on
   `lat`, `lng`, `latitude`, `longitude` or `location_is_private`
   (`routes/telegraphSharedContext.ts:574#const TRIP_CONTEXT_COLUMNS`). The narrow mutation then
   failed 39/1. The difference this buys is concrete: a later `...r` spread in `toContextItem`
   would leak coordinates with no change to the select, and the select is where the promise is made.

3. Both of §21.6's own hollow assertions — the `now()` seen threshold and the latest-vs-highest
   safety fold — were re-checked and **reproduce red**, so the cases §21 added survived the commit.

### 22.3 §20.7 executed — three routes that told a traveller they were not a member, from a read that never happened

§20.7 named this defect precisely and declined to fix it: three sites answer `forbidden` — *"You
are not an active member of this thread"*, *"You are not an accepted member of that trip"*, *"Not a
member of this thread"* — from a membership read whose error was discarded. supabase-js resolves
`{ data: null, error }` rather than throwing, so an unreadable `message_thread_members` is
byte-identical to a genuine non-member.

**Why §20.7's hesitation was answered rather than overruled.** Its stated reason was that
`degraded_unavailable` is the only code `lib/http.ts` marks retryable, so the change alters the
retry behaviour of three live routes. That is true. It is also the contract change §20.2 had
already made for the SIX other discarded reads in the same file, for the same reason, three
sections earlier — and the alternative contract is a claim the server is not entitled to make. A
403 tells the client the answer is settled; a member locked out by a database blip is told, by
name, that they are not in their own conversation, and the app will not recover when the table does.

- `verifyThreadMember` returns three outcomes rather than a boolean
  (`routes/telegraphChat.ts:78#type ThreadMembership`), and one shared refusal sends them
  (`routes/telegraphChat.ts:104#function refuseUnlessMember`) so the five call sites cannot drift
  apart. A fix applied at one call site and not the helper is checked, not trusted: a case drives
  all four reachable handlers.
- The trip gate beside it binds its own error
  (`routes/telegraphChat.ts:301#const { data: tripMembership, error: tripMembershipErr } = await client`).
- The typing relay does the same (`routes/telegraphStream.ts:454#const { data: membership, error: membershipErr } = await client`).

**Every case is PAIRED.** A suite asserting only "an outage is not a 200" would pass against a
route that refuses everybody, so each outage case sits beside a control proving a genuine
non-member — and a member who LEFT — is still refused 403 with the same words. The refusal was
narrowed, not removed.

### 22.4 §20's catch-up — the third member of T267, built as a projection rather than a summary

§20's Compass row names three integrations: *"Authorized thread context, meeting/recommendation
tools, catch-up."* T267's stated reason — "Meeting tools (T248) and catch-up do not exist" — is
**half stale**: T248 is C, and so are T245, T246, T247, T249, T250 and T251. Catch-up was the only
member still missing.

`services/telegraph/catchUp.ts:224#export function projectCatchUp` is its server half, served at
`routes/telegraphCoordination.ts:1067#"/threads/:threadId/catch-up"`, membership-gated and
§14.3-bounded like every other read in that file.

Four properties are what separate it from a message count, and each is a rule a careless
implementation gets wrong:

- **A person did not miss what they SENT.** The viewer's own messages are excluded from
  `missedCount`, and from nothing else.
- **§14.3's window is a BOUND, not a preference.** `since` is `max(lastReadAt, visibleFrom)` and
  `sinceBasis` says which won — `read_marker`, `history_window`, or `conversation_start`
  (`services/telegraph/catchUp.ts:86#export const CATCH_UP_BASES`). A member added to a crew thread
  yesterday cannot catch up on last month because an older marker says so. A single nullable
  `since` would have collapsed all three into "null means everything", which is this document's
  standing complaint: an absence presented as a fact.
- **What still AWAITS the viewer is not filtered by the marker.** A question nobody answered does
  not stop awaiting them because they were online when it was asked. `needsYou` is §2.3's PLAN
  layer, and `safetyMode` is §15.2's fold — **not re-derived here**. A catch-up that disagreed with
  the conversation it summarises would be worse than none, which is the same rule
  `GET /me/commitments` follows for T84.
- **Nothing is read out of prose.** §18.3 forbids Compass "silently creat[ing] canonical plans from
  uncertain prose", and the cheap implementation of "what did I miss" is exactly that. Every item is
  a count or a typed object some route already validated. `inferredFromProse` is a field on the
  response, not a promise in a comment.

What counts as a shared object is not a hand-written list either: it is derived from
`TELEGRAPH_SHARE_PRODUCERS`, the registry `check:telegraph-share-producers` keeps exhaustive
against the tree, filtered to producers that name a `sourceDomain` — so chrome (text, system
notices, call receipts) is excluded because it points at no source object, and a new card family
enters the catch-up the day it is registered.

### 22.5 NO ROW MOVES, and the reason is T267's own sentence

§16.4's rule — a row that is W because a class is unfinished does not become C when one member of
the class is closed — applies, and so does the narrower objection:

| id | Verdict | What closed, and what did not |
|---|---|---|
| T267 | **W** | **Evidence correction plus a half.** "Meeting tools (T248) and catch-up do not exist" is wrong on the first clause: T245–T251 are all C. The catch-up's SERVER half now exists and is reachable (`routes/index.ts:192#telegraphCoordinationRouter`). It stays W because the row is the **Compass** integration row and nothing in Compass reaches it: §18.3's tool set is closed at eight named accessors, `TELEGRAPH_TOOL_SPEC_NAMES` asserts that closure, and a ninth tool would break the one claim that file makes about itself. The right wiring is to carry the catch-up inside `getConversationContext()` — one import, no new tool name — and `compass/TelegraphConversationTools.ts` is not this lane's file. **Cross-lane request, §22.8.** |
| T308 | **W** | **Evidence correction.** "One of four: translation … No transcript, no thread tools (T245–T251), no catch-up" is now one of four understated by two: thread tools exist and the catch-up's server half exists. It stays W and is NEITHER-capped on the voice transcript, which needs the audio MIME and storage widening no migration provides (§13.4, T40). |
| T344 · T363 | **C, unchanged, and strengthened** | §22.3 does not move them and could not: both are C already, and §20.6's rule is that a refusal is not a plausible empty state, so the three sites never counted against them. What §22.3 removes is the defect §20.7 named separately. |

### 22.6 The mutations for §22.3 and §22.4, every one shown red

| mutation | result |
| --- | --- |
| `verifyThreadMember` returns `not_member` on a read error again | 18 → 16/2 |
| the unreadable outcome sends `forbidden` instead of `degraded_unavailable` | 18 → 16/2 |
| `refuseUnlessMember` admits everybody | 18 → 14/4 — the CONTROLS, which is what makes the pairing worth having |
| the `trip_members` error branch deleted | 18 → 17/1 |
| the typing relay's `membershipErr` branch deleted | 9 → 8/1 |
| the catch-up counts the reader's own messages as missed | 105 → 104/1 |
| `since` ignores the §14.3 window floor | 105 → 104/1 |
| `sinceBasis` never reports `history_window` | 105 → 104/1 |
| `needsYou` filtered by the read marker | 105 → 104/1 |
| a transition's `from` derived only from the missed slice | 105 → 104/1 |
| `safetyChangedWhileAway` is true whenever the mode is not NORMAL | 105 → 104/1 |
| the shared-object set includes producers with no `sourceDomain` (chrome) | 105 → 103/2 |

The eleven catch-up cases were written and run BEFORE the route existed: **11 failures, all 404.**

### 22.7 Checks

`npx tsc -p tsconfig.json --noEmit` was clean across the whole package at the start of this
section and reports five diagnostics at the end — every one of them in another lane's in-flight
file in this shared worktree (`compass/CompassMediaContext.ts`, `services/media/MediaActionResolver.ts`,
`services/safeReturn/__tests__/safeReturnLiveShareExpiryHonesty.test.ts`,
`services/airport/__tests__/layoverExpirySweepVisible.test.ts`). **None is in a file this lane
owns**, which was verified by name rather than by the count. `typecheck:tests` reports **881
diagnostics across 118 files against a baseline of 864 across 116**; all seventeen new ones are in
`src/test/mediaIndependentSources.test.ts` and `src/test/mediaWorldProjection.test.ts`, the Media
lane's files. **This lane added none**, and did not touch the baseline.

`check:telegraph-certification`, `check:telegraph-package-boundaries`,
`check:telegraph-share-producers`, `check:telegraph-slos`, `check:census-integrity` and
`check:citation-symbols` all PASS. **All 44 Telegraph-named suites green — 1,030 assertions, 0
failures** — plus `messaging` 22, `groupChat` 39, `accessControl` 33, `failOpenServiceReads` 34,
`tripKernel` 36, `adminPhase12` 31 and `intelligence` 80, each run individually. A green partial
run is not a green run and none is claimed.

`check:telegraph-share-producers` failed once during this section and the reason is worth
recording: `catchUp.ts` rebuilt its input rows field by field, and `msg_type: r.msg_type ?? null`
is indistinguishable to a literal scan from a WRITE. The checker was right to refuse — a registry
that silently misses producers reads as complete — and the fix was to pass the rows through rather
than to declare a producer that produces nothing.

**`check:unchecked-supabase-reads` is RED, and it is this lane's, with a one-line remedy this lane
may not apply.** Fixing `verifyThreadMember` made its allowlist entry stale, and the checker's own
instruction is to delete the line:

```
routes/telegraphChat.ts::verifyThreadMember::message_thread_members.maybeSingle
```

in `artifacts/api-server/src/scripts/UNCHECKED_READS_ALLOWLIST.json`. That file is not on this
lane's ownership list. **Cross-lane request, §22.8.** It is named here rather than quietly edited,
and rather than left for CI to surprise somebody with.

**`check:doc-citations` — repointed, and one anchor set whose TEXT changed.** Inserting into
`routes/telegraphChat.ts`, `routes/telegraphCoordination.ts` and `routes/telegraphStream.ts`
shifted sixteen anchored citations in this document. Each was re-anchored mechanically, by
occurrence index against `git show 88b9e8e1a:` where the needle was not unique, so a citation can
never be quietly pointed at a different occurrence. Three more could not be repointed because the
line they named no longer exists in that form — they are the three reads §22.3 fixed, and §16.6's
convention was followed: the anchor now names the arm that replaced it and the row says so. The
remaining broken anchors in this file are into `services/media/MediaProjectionService.ts` and
`routes/memories.ts`, both being edited by other lanes in this worktree, and were left alone
exactly as §21.7 left them.

`check:census-freshness` will report this document STALE. `CENSUS_STALENESS_ACKNOWLEDGED.json` is
the integration owner's file and this lane did not touch it.

### 22.8 Cross-lane requests

1. **`artifacts/api-server/src/scripts/UNCHECKED_READS_ALLOWLIST.json`** — delete the entry
   `routes/telegraphChat.ts::verifyThreadMember::message_thread_members.maybeSingle`. The site is
   fixed (§22.3); the stale entry is the only thing keeping `check:unchecked-supabase-reads` red.
2. **`compass/TelegraphConversationTools.ts`** — carry the catch-up inside
   `telegraph_get_conversation_context` by calling `projectCatchUp`. That is what T267 needs to
   close, and it adds no ninth accessor to §18.3's closed set of eight.
3. **`domain/telegraph/policies/shareAuthorizationPolicy.ts`** — §21.9's request still stands: add
   `action_response`, `coordination_session` and `coordination_transition` to the computed site's
   `produces` list. `check:telegraph-share-producers` does not verify that list is exhaustive, so
   CI will not catch it.

### 22.9 Rows re-derived against this tree and NOT touched, with the reason

The three gaps carried into this session as "largest concrete" were each re-executed against the
code before anything was built. **All three were stale.**

| id | What the tree said on re-derivation |
|---|---|
| T2 | "`message_reactions` does not exist and unsend does not exist on this branch" is wrong twice. `message_reactions` is created by `migrations/2811_telegraph_message_side_tables.sql:115#CREATE TABLE IF NOT EXISTS public.message_reactions` with RLS and an idempotent primary key, and it has a live consumer (`server/telegraph/commandRoute.ts:299`). Unsend is `services/telegraph/unsend.ts` and `routes/telegraphLifecycle.ts:194#messages/:messageId/unsend`. The row is still W and this lane cannot move it: §13.3 caps both halves on migrations 2810/2811, which are on no database and behind a flag seeded FALSE, and the VOICE clause inside the same row is NEITHER — no audio MIME exists anywhere and no migration widens `messages.media_type`. |
| T4 | Unchanged from §21.5b, and re-checked: §13.5 reclassified it BRANCH → NEITHER on an **owner decision** about whether private-by-default content may surface in a shared rail, and no ruling has landed (`docs/architecture/` holds two decision documents, on the brand palette and on Sensing's auth posture; neither touches this). The rail admits candidates only from `CANONICAL_MUTUALITY_SOURCES`, a closed list of five tables that `admitCandidate` refuses to widen at runtime and TypeScript refuses to widen at compile time; adding `memory_tags` as a sixth IS the decision the owner was asked to take. Left alone a second time. |
| T11 | "ACTION and ANNOUNCEMENT are interleaved rather than layered" is stale on the server: §21.2 built the partition and `routes/telegraphCoordination.ts:968#"/threads/:threadId/layers"` serves it, with `partitionViolations` asserted on every response. It stays W for the half §21.5 named — nothing DRAWS it, and the conversation screen is a client file this lane does not hold. |

Also re-read and deliberately not touched: T31 (a fail-closed protected-zone gate would refuse
every exact-location message on every deployment, because `protected_zones` is not one of
production's 431 tables), T104 (a conflict detector over an availability read that returns
`enabled:false` on every deployment cannot be exercised), T39 (the Visa Buddy half has no referent
anywhere in Portava), T157 · T166 · T169 · T170 · T220 · T379 · T397 · T409 (cross-lane files),
and T201 (`message_threads.chk_thread_context` makes an add-participant operation a schema
violation, not a missing feature).

### 22.10 Not claimed

  - Nothing here is merged, deployed or flag-enabled, and nothing above depends on a migration.
  - `GET /threads/:id/catch-up` has **no client**. It is REACHABLE — mounted at
    `routes/index.ts:192#telegraphCoordinationRouter` — and unmounted in the app's UI, which is
    precisely why T267 does not move.
  - `POST /threads/:id/typing` and the four `telegraph/suggestions` handlers changed behaviour on
    a path clients already call: an outage on the membership read now answers 503
    `degraded_unavailable` where it answered 403. That is a new retry, not a new refusal — a
    genuine non-member still gets the same 403 with the same words, and a control asserts it.
  - The headline is NOT restated. `check:census-integrity` reads **C=229 W=158 N=49 X=3** across
    451 rows, unchanged by this section, against §1's stated 209 / 176 / 51 / 3. That gap is §21.8's
    and is still not this lane's to close.
  - The 155 W rows this section does not name were not re-read.

---

## §23 — T70 closes, and §21.5's reason for keeping it open was stale in both halves

Written by the integration owner after cherry-picking `2c6f2eb0a` and `6bd65fb07`.
The OLD verdict was read from `CENSUS_INTEGRITY_DUMP=ALL` (`telegraph|T70|W`),
not from the lane's report.

### 23.1 The move

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **T70** | **W** | **C** | `§7.2`'s *"Seen = crossed the approved visibility threshold"*. The legacy `POST /api/threads/:threadId/read` now stamps the **newest non-deleted message's own `created_at`** inside the caller's §14.3 window — `routes/messaging.ts:1744#.update({ last_read_at: threshold })`, threshold derived at `:1712`–`:1739`, membership gate at `:1687`–`:1697`, and the realtime receipt carries the same threshold at `:1759`. Reached from the shipping product: `travel-buddy-standalone/src/services/messaging.ts:429` is `markThreadRead`, the call the conversation screen makes. |

### 23.2 The sentence that was keeping it open, and why it was wrong twice

§21.5 read: *"It stays W because the legacy path in `routes/messaging.ts` still
stamps `now()` on any authenticated call **and this lane does not own that
file**."* Both halves are now false — the file was in scope, and the path stamps
a message threshold.

It was also **understating the defect**. It named `now()` and did not name the
larger thing beside it: the handler performed **no membership check at all**, so
it answered `{ ok: true }` to a stranger and broadcast `read.updated` into a
thread they are not in. That is fixed in the same commit and is what
`telegraphLegacyReadMarkerThreshold.test.ts` mutation T-M3 kills.

### 23.3 WHAT WOULD TURN THIS RED

Four things, and all four are mutations that went red:

1. the marker exceeding the newest message (T-M1, `now()` restored → 5 of 10 fail);
2. a marker rewound by a later call (T-M2 / T-M2b, the monotonicity guard);
3. a non-member receiving `ok: true` (T-M3, the membership gate);
4. an unreadable `messages` collapsing to "nothing to mark" (T-M4, `newestErr`).

Two more kill a deleted message used as the threshold (T-M5) and a broadcast
carrying the wall clock instead of the threshold (T-M6).

### 23.4 What T70 does NOT claim

`§7.2`'s **"active foreground conversation"** clause is **T71**, scored `X` by
this census, and the server still cannot observe foreground. Nothing in the suite
asserts it, and T71 does not move.

The **§14.3 window clause is untested in the live direction.**
`telegraph_history_bound_enabled` is seeded FALSE and is on no database, so
`visibleFrom` is `null` on every deployment and that branch cannot be exercised.
It is written to match `routes/telegraphLifecycle.ts` exactly, and no flag-on
case was fabricated and then called evidence. **T70's move does not rest on
it** — the threshold and monotonicity rules hold with the flag off, which is
every deployment there is.

### 23.5 Fourteen gates that moved no verdict, recorded because §17.9 set the precedent

The same commit converts fourteen membership and precondition gates in
`routes/messaging.ts` and `routes/groupChat.ts` from a settled `403` to a
retryable `503 degraded_unavailable` when the read behind them never happened.
By §20.6's rule (*"a refusal is not a plausible empty state"*) these move
nothing — T344 and T363 never counted them and are already `C`. The allowlist
shrank **158 → 156**.

They are recorded because the wire changed on live routes: these calls will now
**retry** where today they give up, and a genuine non-member still receives the
same `403` with the same words, asserted by control in all sixteen call sites.
The cruellest of the fourteen was `isActiveThreadMember`'s *"You no longer have
access to this thread"* — an access **removal** asserted from a read that never
ran.

### 23.6 Tally

`check:census-integrity` now reads **C=230 W=157 N=49 X=3** across 451 rows. One
row moved. §1's stated 209 / 176 / 51 / 3 is still §21.8's gap and still not
closed here.

---

## §24 — The twelve rows the tallier drops are not prose; the twelve `not_found` defects are already fixed; and the one fail-open nobody had named

Written by the TELEGRAPH lane in worktree `/home/user/wt-w5-telegraph`, detached at
`2844870a0`. **Nothing here is merged, nothing is deployed, no flag was enabled.**
No `head_commit` is re-declared: this section re-derived 36 rows and re-read a further
handful, not all 451, and §1's reading rule applies unchanged.

Every OLD verdict below was taken from
`CENSUS_INTEGRITY_DUMP=ALL node --import tsx/esm src/scripts/checkCensusIntegrity.ts`,
never from this document's prose. That distinction earned its keep twice in this
section — §24.1 and §24.4 both disprove a sentence this census states about itself.

### 24.1 The twelve unreadable requirements are ORDINARY VERDICT ROWS, and this document says twice that they are not

`check:census-integrity` reports, for this census alone in the corpus:

> `telegraph  439  230  157  49  3  451  12 counted where this tool cannot read`

This document explains that gap twice, and **both statements are false.** §1's
restatement says:

> *"the remaining 12 of 451 being requirements this census states in prose rather
> than in a verdict table"*

and §13.10 repeats it:

> *"The 12 requirements this census counts in prose rather than in a verdict table
> are unchanged and are still not machine-checkable, so 439 of the 451 are."*

**The twelve are T1, T26, T212, T366, T367, T393, T404, T405, T406, T408, T416 and
T446.** Every one of them is an ordinary row in an ordinary verdict table in §5 or
§6. They were found by subtracting the dump's 439 ids from T1–T451; no prose was
consulted, and none needed to be. The first of them, in full:

> `| T1 | North star: … | N <backtick>∅<backtick> | Unguarded absence. … |` (the verdict cell is the empty-set glyph wrapped in code backticks)

**What actually defeats the parser is the CELL SHAPE, and it is the same defect
`checkCensusIntegrity.ts` has already had to fix four times.** `verdictOf()` strips
`⌀`, `†` and `‡` from a verdict cell, and strips a trailing parenthesised note, but
this census marks an unguarded absence with a BACKTICKED `∅` (U+2205 EMPTY SET, not
the U+2300 `⌀` the strip list carries). `` N `∅` `` therefore matches no verdict
token and the row is dropped whole. That file's own header says what this looks
like when it happens:

> *"Those four are not prose: M47, M169, M176 and M177 are ordinary table rows, and
> the census's own headline counts them. … the difference was invisible as a
> discrepancy because it surfaced as an unreconciled-prose number instead."*

**MEASURED, not argued.** Rewriting the 33 affected cells from `` N `∅` `` to
`` N (`∅`) `` — the trailing-parenthesised-note shape `verdictOf()` already
supports, adding two characters and removing nothing — was applied, dumped, and
diffed against the dump taken before it. The diff is **exactly twelve added lines**:
`T1|N`, `T26|N`, `T212|N`, `T366|N`, `T367|N`, `T393|N`, `T404|N`, `T405|N`,
`T406|N`, `T408|N`, `T416|N`, `T446|N`. **Not one existing verdict changed**, and
parsed rows became 451 against a stated denominator of 451.

So the twelve are not prose, they are not unverdicted, and they are not
unmachine-checkable. They are **twelve NOT-BUILT requirements that every tally this
census has ever published has silently omitted.** The body's true count is
**C 230 / W 157 / N 61 / X 3 = 451**; the published 49 NOT-BUILT understates the
not-built pile by twelve rows, a quarter of its own size. CONSTRUCTED% and CORRECT%
are unaffected — all twelve are N, so `(230+157)/451` and `230/451` hold either way,
which is precisely why nothing ever noticed.

**THE EDIT WAS MEASURED AND THEN REVERTED.** `docs/architecture/census-telegraph.md`
was restored byte-identical to its pre-section state (`cmp`-verified) before this
section was appended, on an explicit scope instruction from the integration owner
that closing the gap is a corpus-level decision and not this lane's to take. **This
section recommends closing it.** The change is two characters per cell in one file,
it moves no verdict, and it is reproducible in one command:

```
python3 -c "import re,io;p='docs/architecture/census-telegraph.md';s=open(p).read();print(re.subn(r'\|( *[CWNX] )\`∅\`( *\|)', r'|\1(\`∅\`)\2', s)[1])"
```

**Whoever closes it must restate the headline in the same commit.** Making the
twelve readable takes parsed rows to 451 = the stated denominator, which removes the
prose-gap exemption in `checkCensusIntegrity.ts` and turns the headline-equality
check on for this census for the first time. It then fails immediately, and not on
the twelve rows — on the header. Captured verbatim from the reverted-then-reapplied
state:

> `::error::census-telegraph.md: its stated headline is C 98 / W 172 / N 178 / X 3 but its own rows count C 230 / W 157 / N 61 / X 3. Both sum to 451, so this is not an arithmetic slip — it is a headline that stopped describing the table underneath it. EVERY requirement in the denominator was parsed, so there is no prose gap for the difference to live in.`

### 24.2 The headline that has never been checked, and never can be

`check:census-integrity` parses exactly one headline table in this document: the
**v1 / v1.1 split at line 68**, which states **98 / 172 / 178 / 3**. The parser takes
the LAST number on each line, so the three-column shape `| BUILT-AND-CORRECT | 86 |
12 | 98 |` reads as 98. §1's own four-row table above it is not the last such block
and never wins.

That headline is **~130 rows away from the document's own body** and has been for the
whole branch. §1's restated paragraph (209/176/51/3), §13.10's blockquote
(211/176/49/3) and §23.6's tally (230/157/49/3) are all prose and none of them is
parsed. The equality check that would have caught the drift **fires only when parsed
rows equal the stated denominator**, and telegraph's twelve-row gap means 439 ≠ 451
permanently. So the census with the largest BUILT-BUT-WRONG population in the corpus
holds the one machine-checked headline in the corpus that is **unreachable by
construction**, and every gate has been green over it the entire time.

This section appends a two-column block restated from a fresh dump. It becomes the
last such block and therefore the parsed headline. **It is still not ENFORCED**, and
saying so is the point: closing §24.1's gap is what would make it enforced.

| Measure | Value |
| --- | --- |
| BUILT-AND-CORRECT | **230** |
| BUILT-BUT-WRONG | **157** |
| NOT-BUILT | **49** |
| CANNOT-VERIFY | **3** |

Those four are the parsed rows — 439 of 451 — as of this section. **They are not the
body count.** Counting the twelve rows §24.1 identifies, the body states
C 230, W 157, N 61, X 3, summing to 451. CONSTRUCTED **85.8 %**, CORRECT **51.0 %**
under either reading, because all twelve are NOT-BUILT.

The line-68 headline is **superseded**: it understates C by 132, overstates W by 15
and overstates N by 129. It is left in place because this document is append-only and
last-statement-wins; nothing above this line was edited.

### 24.3 The 209 non-correct rows, partitioned

157 W + 49 N + 3 X. §13.4's four groups were joined to the current dump rather than
inherited; the join is what produces the first four rows.

| partition | count | how it was derived |
| --- | --- | --- |
| (a) closable from code this lane owns | 10 | §13.4 BRANCH rows still non-C whose named artifact is in this lane's file set: T31, T39, T157, T166, T169, T170, T201, T379, T381, T409 |
| (b) unapplied migration or a flag seeded FALSE | 24 | §13.4's OWNER group, all 24 still W. 2810–2813 are in no database; every flag they add is seeded FALSE |
| (b)+(a) BOTH — needs the deploy AND a change in an owned file | 12 | §13.4's BOTH group, all 12 still W: T80, T142, T144, T147, T154, T158, T196, T221, T228, T231, T369, T385 |
| (c) owner decision, named | 6 | T4 (share `memories` from a private-by-default domain), T396 (the spec states two six-level attention ladders that disagree at P3/P4/P5), T202 (§20 forbids payment requests — permanently false BY DESIGN), T255 (what "immediate/high priority" means in delivery), T286 and T287 (a client directory layout and a server package split, deliberately unenforced) |
| (d) another lane's file | 25 | client tree `travel-buddy-standalone/` (T6, T11, T12, T104, T106, T108, T123, T124, T218, T262, T264, T265, T271, T295, T320, T411, T413, T423, T448); `routes/circle.ts` + client producers (T35, T359, T445); Trips-owned routes (T319); `services/notifications/NotificationDeduplicationService.ts` (T397); 30 files across many lanes (T220) |
| (e) absent capability — no storage, no subsystem, no referent | 129 | §13.4's NEITHER group less the four owner decisions above (80), plus all 49 NOT-BUILT rows |
| (f) the census sentence is already FALSE at HEAD | 3 | §24.4 — quoted, with the disproving line |
| X — cannot verify | 3 | the three rows §7 names, T71 among them |

(a)+(b)+(b·a)+(c)+(d)+(e) = 10+24+12+6+25+129 = **206**, plus 3 X = **209**. (f)
overlaps the others and is not added.

### 24.4 Sentences this census states that are FALSE at HEAD

1. **§1, restated 2026-09-12 by the integrator** — *"the remaining 12 of 451 being
   requirements this census states in prose rather than in a verdict table."*
   **Disproved by** `census-telegraph.md:439`, an ordinary verdict-table row:
   `| T1 | North star: … | N <backtick>∅<backtick> | Unguarded absence. … |` (the verdict cell is the empty-set glyph wrapped in code backticks)
   — and by the eleven others at :479, :718, :953, :954, :1003, :1014, :1015, :1016,
   :1018, :1026 and :1056. §24.1 has the measurement.

2. **§13.10** — *"The 12 requirements this census counts in prose rather than in a
   verdict table are unchanged and are still not machine-checkable, so 439 of the 451
   are."* Same disproof. They are machine-checkable; two characters per cell is the
   whole of it.

3. **§23.6** — *"`check:census-integrity` now reads **C=230 W=157 N=49 X=3** across
   451 rows."* **Disproved by the tool's own line**, which is what §23.6 is quoting:
   `telegraph  439  230  157  49  3  451  12 counted where this tool cannot read`.
   The four counts are right; **the "across 451 rows" is not** — the tool reads them
   across 439. The distinction is the whole of §24.1.

Two further statements are UNDERSTATED rather than false, and are corrected in
§24.5's table: T220's file count and T123's module count have each grown since the
pass that measured them.

### 24.5 §13's 36 remaining BRANCH rows, re-derived

§13.4 assigned 51 rows to BRANCH. §17.8 item 4 recorded ten reaching C (T79, T388,
T430, T438, T3, T36, T37, T38, T290, T349), five reclassified (T31→BOTH;
T4, T201, T218, T396→NEITHER) and thirty-six remaining, twelve of them re-read.

**Re-derived from the dump, not inherited: the 51 now stand at 14 C and 37 non-C.**
Four of §17.8's thirty-six have reached C since it was written — **T344 and T363**
(§20.6), **T268** (§21) and **T410** (§22). **Thirty-two of the thirty-six are still
open.** Each was checked against the tree, and the previous pass was right about
every one of them; the value here is that it is now a claim made after looking.

| **ID** | **was** | **now** | why |
| --- | --- | --- | --- |
| T11 | W | W | Still open. The ACTION Confirm control still refuses rather than executing: `travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx` renders "Confirmation is not available on this screen". §13.12 item 5 called this smaller than a fix and larger than nothing; it is unchanged. |
| T35 | W | W | Still open, and the named producer is still the named producer: `artifacts/api-server/src/routes/circle.ts:365#msg_type:  "circle_status_card",` still hand-rolls the payload. `discovery_card`, `post_card` and `compass_card` are still written client-side. Another lane's file. |
| T123 | W | W | Still open, and LARGER than §17.8 recorded. §13.4 said "three surfaces"; §17.8 corrected it to eleven client modules. Counted today: **12** client modules under `travel-buddy-standalone/src` still reference the static `TG` tokens. |
| T157 | W | W | Still open. `envelopeVersion` appears in exactly four non-test files — `services/telegraph/coordination.ts`, `services/telegraph/messageKinds.ts` and two client kind modules — i.e. §6.2's kinds and coordination and nothing else, which is the row's own statement. |
| T166 | W | W | Still open. `routes/telegraphCommands.ts` exposes four action kinds — `add_to_plan`, `ask_followup`, `create_meetup`, `open_poll`. `CREATE_DECISION` is not among them. |
| T169 | W | W | Still open, same four kinds; §9.1's seven quick states are not commands. |
| T170 | W | W | Still open. `SHARE_LOCATION` exists in `services/telegraph/vocabulary.ts`, `layers.ts`, `shareables.ts`, `sharedContext.ts` and `coordination.ts` as a coordination ACTION, and in no command kind. |
| T220 | W | W | Still open, and LARGER again. §13.4 said eight modules; §17.8 corrected it to thirty non-test files, twenty-seven outside the shared helpers. Counted today: **33** non-test files query `blocks` directly, **30** of them outside `lib/blockGuard.ts`, `lib/blocks.ts` and `lib/exclusionSet.ts`. §24.6 adds a guard to one of the thirty and consolidates none of them. |
| T295 | W | W | Still open and unchanged in size. `check:telegraph-slos` on this tree reports "6 client bypass site(s) across 3 file/table pair(s)" — the row's claim exactly, shrink-only, and still six. |
| T319 | W | W | Still open. Neither `services/groupChatSync.ts` nor `lib/chatSync.ts` calls an `rpc(` — the trip-membership write and the thread-membership write are still two statements, not one transaction. Trips-owned routes. |
| T320 | W | W | Still open. `travel-buddy-standalone/src/components/rentabuddy/BookingMilestoneMessage.tsx` contains **zero** occurrences of `fetch` or `useEffect`; it still renders the sender's snapshot. |
| T344 | C | C | **Re-derived, not moved.** All twelve §17.8 sites are closed at HEAD (§24.6 reads each one). The new fail-open §24.6 fixes is not one of this row's named reads, is in a different file, and is a PERMISSIVE answer rather than a plausible-empty one, so by §20.6's rule it never counted here. This row does not reopen. |
| T359 | W | W | Still open, and it is T35's remainder: the four legacy producers. Same evidence as T35. |
| T363 | C | C | Re-derived with T344, same evidence, same reasoning. Does not reopen. |
| T379 | W | W | Still open. `TelegraphRelationship` appears in **no** `.ts` or `.tsx` file in the tree. The canonical resolver the row asks for has not been written. |
| T397 | W | W | Still open. No `causal`, `causeId` or `causalId` identity exists anywhere under `artifacts/api-server/src/services`. The dedupe service is `services/notifications/NotificationDeduplicationService.ts` — another lane's file, which §13.4 did not say. |
| T409 | W | W | Still open at one sixth, and the sixth is now readable. `domain/telegraph/policies/shareAuthorizationPolicy.ts` entries carry `literal / column / family / sourceDomain / authorizedBy / note`. Of §30A.10's six dimensions that is AUTHORIZATION only; preview, current state, actions, search behaviour and revocation have no field on any entry. |
| T413 | W | W | Still open, and now precisely bounded — a refinement §13.4 could not make. Of the three object-card surfaces, `travel-buddy-standalone/src/features/telegraph/sharing/PortavaObjectMessage.tsx` DOES render `revocation.resolved.projection`. `PostCardMessage.tsx` and `DiscoveryCardMessage.tsx` branch on `revocation.state === 'unavailable'` and then render `payload.*` throughout — the sender's snapshot. One of three, not zero of three. |
| T423 | W | W | Still open. `I18nManager` and `isRTL` appear in **no** file in the tree. |
| T445 | W | W | Still open, same remainder as T35 and T359. |
| T448 | W | W | Still open, same two legacy cards as T413. |

**Not individually re-derived, and named so the omission is not mistaken for a
finding:** T4, T6, T12, T39, T104, T106, T108, T124, T201, T218, T262, T264, T265,
T271, T381, T396, T411. All seventeen are surfaces in the client tree or owner
decisions; each was read at its §13.4 statement and none has an artifact in this
tree that would falsify it, but that is a weaker claim than the rows above and is
labelled as one.

### 24.6 Step 5's premise is false at HEAD — the twelve `not_found` defects are already closed

This lane was asked to fix *"twelve enumerated-but-unfixed unchecked-read defects:
ten in `routes/messaging.ts`, two in `routes/groupChat.ts`."* **All twelve are fixed
at HEAD.** §17.8's own table carries a block-quote saying so — *"ALL TWELVE ARE NOW
CLOSED — see §18"* — and the code was read rather than the prose:

- Each of the twelve citations in §17.8's table was opened. Every one is now
  `const { data: x, error: xErr } = await …` followed by
  `if (xErr) { req.log.error(…); sendError(res, 'degraded_unavailable', …); return; }`
  and the 404 one line below.
- `routes/groupChat.ts` contains **zero** occurrences of the dropped-error shape
  `const { data: x } = await`.
- `routes/messaging.ts` contains **three**, and all three are §19.6's deliberately
  unchanged "neither" sites (the prior-preference read, the lost-CAS-race status
  re-read, the preview-message insert), each with a stated reason.

Re-fixing them would have been twelve unproven no-ops. The time went to §24.7
instead.

### 24.7 The fail-open no row in this census had named, and no guard could see

`routes/telegraph.ts` resolves `@handle` mentions inside AI recommendation text and
emits a `tagSpans` entry — a user id, a handle and a character range the client
renders as a live mention. Before emitting, it reads `blocks` in both directions.

That read BOUND its error and LOGGED it, and then carried on with an empty
`blockedSet`. Its own comment stated the consequence rather than preventing it:

> *"Both leave blockedSet empty and both let blocked users through."*

`blocks` is an EXCLUSION TABLE: a row means DENY, so an empty read means ALLOW and a
dropped OR INERT error is fail-open by construction. **On an unreadable `blocks`,
this route emitted a resolved, positioned mention for somebody the caller may have
blocked, or who may have blocked the caller.**

`check:unchecked-supabase-reads` reports 0 FAIL-OPEN and that number is true of what
it measures. Its own header names this as the class it cannot see:

> *"A read can bind its error, read it, and still produce the permissive result. …
> Call this shape ERROR-INERT: the error branch yields the same value the empty read
> would. SO THE LEDGER'S '0 FAIL-OPEN' DOES NOT COVER IT."*

This is the first instance of that shape found in a Telegraph-owned file, and it
means the corpus's most productive defect class has a second costume that no section
of this census had looked for. It is **worse than the twelve §18 closed**: those
turned an outage into a false absence, which is a lie about data. This turned an
outage into an ADMISSION, which is a lie about permission.

**Red first.** `artifacts/api-server/src/test/telegraphMentionBlockFailClosed.test.ts:1#/**`,
4 cases, 1 outage and 3 CONTROL. Against the unfixed route: **3 passed, 1 failed**,
and the failure is the outage case, verbatim —

> `not ok 1 - OUTAGE: an unreadable blocks table emits NO mention span` … `actual: [ { type: 'user', id: '71000000-…-000000000002', matchToken: 'mallory', startChar: 32, endChar: 40 } ]  expected: undefined`

With the fix: **4 / 4.**

**Three mutations, each killing exactly one case and no other.**

| mutation | failed | what it proves |
| --- | --- | --- |
| guard neutralised — `if (false && blockErr) break;` | 1 — the outage case | the guard is what closes it, not something else in the route |
| guard unconditional — `if (true) break;` | 1 — the healthy-tree control | the control is load-bearing: the route really can emit a span |
| blanket — hashtag spans suppressed too | 1 — the scoped-refusal control | the refusal is scoped to mentions and is held there |

The fix is `artifacts/api-server/src/routes/telegraph.ts:295#if (blockErr)` — on a
block-read error, no mention span is emitted at all. Hashtag spans are untouched;
they do not consult the block set, and dropping them too would be a blanket answer
rather than a scoped one, which is what the third mutation exists to prevent.

**NO ROW MOVES.** §16.4's rule: a row that is W because a class is unfinished does
not become C when one member is finished. T344 and T363 are already C and, by
§20.6's rule that a refusal is not a plausible empty state, this site never counted
against them in either direction — it is not a plausible empty state, it is a
permissive one. **T220 does not move either**: this adds a guard to one of the thirty
files that query `blocks` directly and consolidates none of them.

**A harness limit, stated so no case is trusted for the wrong reason.**
`telegraphCertificationHarness`'s `.or()` parser understands `eq`, `neq` and `is`,
not `in`, so a filter built as `blocked_id.in.(…)` matches nothing in the fake even
when a matching row is seeded. A "healthy tree, genuinely blocked user, no span"
case would therefore pass whether or not the block guard works — the
green-for-an-unrelated-reason failure this repository has already paid for once. It
is deliberately NOT written; the fourth case proves the suppression path with
`tag_permission: 'nobody'`, which the fake evaluates in full.

**One enabling change, recorded because it is not a fix.** The route imported
`openai` directly while `lib/openai.ts` exports a `getOpenAI()` / `_setTestOpenAI()`
seam that two other suites already use. The route now calls `getOpenAI()`. Without
it the route is not drivable end to end and the red above could not have been taken.

### 24.8 What would turn this red (P24)

- **§24.1's measurement.** A cell among the 33 whose verdict letter is not what this
  section assumes. Falsifiable in one command: reapply the reshape, dump, and diff
  against the pre-change dump. Anything other than exactly twelve added `|N` lines
  falsifies it. It was run; it was twelve.
- **§24.2's headline.** Any later section restating the buckets in a two-column
  block, which would supersede this one. And the standing weakness: **this headline
  is written, not checked**, and stays that way until §24.1's gap is closed.
- **§24.5's re-derivation.** Any of the twenty-one greps returning a different count
  on a different tree — T220's 33/30, T123's 12, T295's 6, T157's four files and
  T409's six-field registry entries are the load-bearing ones. Three of the five have
  already grown once under measurement, which is the direction to expect.
- **§24.7's fix.** Three things. (1) If `blockErr` can be truthy while `blockRows`
  is nonetheless complete — it cannot with supabase-js, but a client swap would break
  that. (2) If suppressing mentions is judged the wrong direction: it is a DEGRADED
  answer, not a refusal, and a reader who thinks an unreadable block list should
  return `degraded_unavailable` for the whole request rather than an undecorated one
  should say so — §20.7 is the row where that argument belongs. (3) The route is
  reached only when `AI_INTEGRATIONS_OPENAI_API_KEY` is configured and the model
  returns an `@handle`; **a C over a path nothing reaches is vacuous**, and this is a
  fix on a live route whose frequency nobody here measured.
- **The standing one.** This is a BRANCH census. Migrations 2810–2813 are on no
  database, every flag they add is seeded FALSE, and nothing in this section is
  merged, deployed or flag-enabled.

---

## §25 — The twelve rows are counted, and the fix was in the tallier, not the table

§24.1 measured a twelve-row gap between what `check:census-integrity` can parse
(439) and what this census's denominator claims (451). §24.2 then restated the
headline from the parsed 439 and said, correctly, that the restatement was **not
enforced** — because the equality check fires only when parsed rows equal the
denominator, and 439 ≠ 451 kept it off.

This section closes the gap. **Not one verdict moved.**

### 25.1 The gap was a parser omission, not a document defect

All twelve rows are ordinary verdict rows in §5/§6 and every one of them already
stated `N`. What the tallier could not read was the **flag beside the verdict**:

| the cell as written | what `verdictOf()` did with it |
| --- | --- |
| `` N `∅` `` | returned `null` — the row was not counted at all |
| `N ⌀` | stripped `⌀`, counted `N` |

`` `∅` `` is defined by this census's own key at line 429 — *"`∅` unguarded absence
(a prohibition currently unviolated …)"*. It is a **flag that qualifies a verdict**,
which is precisely the category `verdictOf()` already handles, whose own comment
reads *"vacuity / footnote flags qualify a verdict, they are not one"*. `⌀` (U+2300)
was in the strip class; `∅` (U+2205) was not, and the backticks around it were not
stripped either. Two characters that look alike, one of them handled.

So the repair is one added strip in `src/scripts/checkCensusIntegrity.ts:212#verdictOf`:

```
     .replace(/[⌀†‡]/g, "") // vacuity / footnote flags qualify a verdict, they are not one
+    .replace(/`?∅`?/g, "") // `∅` (U+2205) is the same class — census-telegraph's "unguarded
+    // absence" flag, backticked. Kept on its own line so the line above stays
+    // byte-identical: census-input-intelligence quotes it VERBATIM.
```

**It is a separate line on purpose.** Widening the existing class to
`` /`?[⌀∅†‡]`?/ `` produces a byte-identical dump — that was written first and
diffed — but it rewrites line 216, and `census-input-intelligence.md:1304` quotes
that line's text VERBATIM to explain why its own `C ᵖ` rows were once unreadable.
`check:doc-citations` refused it immediately:

> `docs/architecture/census-input-intelligence.md:1304  src/scripts/checkCensusIntegrity.ts:216#replace(/[⌀†‡]/g,  -- the WHOLE anchor appears NOWHERE in artifacts/api-server/src/scripts/checkCensusIntegrity.ts — the anchor text itself is wrong`

A line number can be repointed; a quotation cannot. The other census's sentence is
still true — `ᵖ` is still not stripped — so the honest fix is the one that leaves
its evidence standing.

**`ᵖ` was measured too, and deliberately not added.** census-input-intelligence
§7 describes the identical defect for its 23 `C ᵖ` rows, so the obvious move was to
strip `ᵖ` in the same pass. Adding it changes **nothing**: the dump is byte-identical
with and without, because those 23 rows were since restated as plain `**C**` in that
census's §8.3 row-move table and last-statement-wins already counts them —
input-intelligence parses 373 of 373. A strip character that strips nothing is a
speculative widening of the risk in §25.5 for no measured gain, so it is not here.
That passage at line 1292–1305 is a historical capture, not a live gap.

**The alternative was rejected.** The gap can also be closed by reshaping the twelve
cells to `` N (`∅`) ``, which the existing trailing-parenthetical rule already
strips. That was measured and it works — but it edits twelve historical rows of an
**append-only** document to accommodate a tool, and it leaves the next `∅` row
written anywhere in the corpus invisible in exactly the same way. Fixing the reader
fixes the class.

### 25.2 What the change moves, measured corpus-wide

Full `CENSUS_INTEGRITY_DUMP=ALL` before and after, all 13 censuses, sorted and
diffed:

```
before=3499  after=3511
ADDED:    telegraph|T1|N    telegraph|T26|N   telegraph|T212|N  telegraph|T366|N
          telegraph|T367|N  telegraph|T393|N  telegraph|T404|N  telegraph|T405|N
          telegraph|T406|N  telegraph|T408|N  telegraph|T416|N  telegraph|T446|N
REMOVED:  (none)
```

Twelve added lines, all `N`, all in telegraph. **No existing verdict changed, in any
census.** Twelve rows that were always graded `N` in the body became visible to the
machine; nothing was regraded. That is why there is no row-move table in this
section — *absent from the dump* is not a verdict, so nothing moved from one.

### 25.3 The headline, now enforced for the first time

Parsed rows are now 451 = the denominator, so the equality check switched on and
immediately failed §24.2's block. Captured verbatim:

> `::error::census-telegraph.md: its stated headline sums to 439 (C 230 + W 157 + N 49 + X 3) against a denominator of 451, and EVERY requirement in that denominator was parsed — there is no prose gap for the difference to live in. A headline arrived at by adding this pass's moves to the previous headline carries the previous headline's error forward while looking freshly measured. Count the rows: C 230 / W 157 / N 61 / X 3.`

The corrected headline, restated from the dump and **not** by adding to any previous
headline:

| Measure | Value |
| --- | --- |
| BUILT-AND-CORRECT | **230** |
| BUILT-BUT-WRONG | **157** |
| NOT-BUILT | **61** |
| CANNOT-VERIFY | **3** |

451 rows. CONSTRUCTED **85.81 %**, CORRECT **51.00 %**.

This block supersedes §24.2's, which counted 439 and said so. It is the first
headline in this census's history that a gate can fail on, and the gate is now the
reason it is right rather than a claim that it is.

### 25.4 The line-68 headline is still the one that was wrong

Superseding §24.2 is bookkeeping. The finding §24.2 made is the real one and it
survives unchanged: the headline at **line 68** — `98 / 172 / 178 / 3` — was the
parsed headline for the whole branch and is **~130 rows away from the body**
(understates C by 132, overstates N by 117 against the count above). It went green
every time, because the only check that could have caught it was disabled by the
same twelve-row gap this section just closed. A document can be append-only, fully
gated, and still carry a false headline for its entire life if the gate that reads it
is switched off by an unrelated parsing accident.

### 25.5 WHAT WOULD TURN THIS RED

- **The parser change over-reaching.** `` /`?∅`?/ `` also strips a backtick that
  merely sits next to the flag. If any census ever writes a verdict cell where a
  backtick adjacent to `∅` is load-bearing, this silently reshapes it. The
  corpus-wide diff in §25.2 is the evidence that it does not today — twelve added,
  zero changed, zero removed — and that diff is worth re-running, not trusting.
- **The count itself.** 230/157/61/3 is the tool's count at this commit, not mine;
  `node --import tsx src/scripts/checkCensusIntegrity.ts` re-derives it. If a later
  section moves a row and restates the headline by *addition* rather than by re-running
  the dump, that is the exact defect the error message above names.
- **`∅` written outside a verdict cell.** The flag is stripped wherever it appears in
  a verdict cell. A census that used `∅` to mean something else in such a cell would
  now be misread, where before it was merely unread.
- **The standing one.** This is a BRANCH census. Migrations 2810–2813 are on no
  database, every flag they add is seeded FALSE, and nothing here is merged, deployed
  or flag-enabled. A corrected headline is a corrected description of a branch.

---

## §26 — 2325 is now in this tree, and three passages that say otherwise are superseded

Written by the integrating lane, 2026-09-15. **No verdict moves and no figure in
§1 changes.** This section exists because three passages of this census are now
false in their literal wording, and last-statement-wins is the only mechanism
this corpus has for saying so.

### 26.1 What happened

`public.schema_migration_ledger` in the shared CI project carried a row with
`applied_by='manual'` for `2325_telegraph_unsend_before_seen.sql` whose migration
FILE was on no merged branch — `check:migration-ledger` finding #2, *"ledger rows
with no file on disk"*. The row records a real apply to `portava-ci` on
2026-09-07. Deleting it would have made the ledger assert that a migration which
DID run never ran, so the file was restored instead, taken from
`claude/telegraph-agreed-subset-20260906` (commit `4cf1d9c76`) and verified:
sha256 `cdb839929c2b877d91740470cb6f677701632611142bc7b643756724c0493490`, which
is the checksum the ledger row itself records.

### 26.2 The three passages, and exactly how far they are wrong

| Where | What it says | Status |
| --- | --- | --- |
| `docs/architecture/census-telegraph.md:138#not on this branch` | *"in open PR #472 — **not on this branch**"* | The FILE is on this branch as of 2026-09-15. The PR is still open and still unmerged. |
| `docs/architecture/census-telegraph.md:424#The exception that is not in HEAD` | *"`migrations/2325_…`, the route that calls it, and `test/telegraphUnsendBeforeSeen.test.ts`"* | The migration is here; **the route and the test are not**. The heading remains true of what it grades. |
| `docs/architecture/census-telegraph.md:1151#Five files:` | lists 2325 among five | Accurate as a description of PR #472, which still carries all five. One of the five is now also in this tree. |

Only the migration file came across, and that is not an accident of effort: a
ledger row names a FILE, and the file is the whole of what was owed. Bringing the
route and the test would have been importing an unmerged PR's application code
under cover of a ledger repair.

### 26.3 Why the eleven rows do not move

§9 scores PR #472 in no bucket, and the eleven rows it would move — T75, T76,
T77, T161, T326, T327, T338, T387 from NOT-BUILT, and T79, T220, T314 from
BUILT-BUT-WRONG — are gated on the route and the test, neither of which is here.
Nothing in this tree calls `telegraph_unsend_message_before_seen`, so none of the
behaviour those rows grade is reachable.

And the fact those rows actually turn on is untouched: **`messages.unsent_at`
does not exist in production.** §0's Database row corroborates that from
`artifacts/api-server/baseline/20260907_production_tables.txt`, the current
capability snapshot agrees, and an apply to `portava-ci` has never been evidence
about production. A migration file sitting in a tree applies itself to nothing.

### 26.4 What the restore did change, mechanically

- `artifacts/api-server/src/migrations/2325_telegraph_unsend_before_seen.sql` is
  now counted in `CENSUS_SCOPE["census-telegraph.md"]`, so any FURTHER change to
  it ages this census. The restore itself is named in the telegraph entry of
  `CENSUS_STALENESS_ACKNOWLEDGED.json`, with this reasoning.
- The file ALTERs `public.messages` (`ADD COLUMN IF NOT EXISTS unsent_at
  timestamptz`), which its own header's blanket "additive" gloss does not admit.
  It is additive and idempotent, and it does not collide with 2810, which adds
  the same column with the same type under the same guard and applies after it.
- It creates no table, so `check:production-drift` gains no entry from it — the
  three entries that check DID gain came from 2311 and 2320, which are Intel and
  Highlights/Memories work and are recorded in those lanes.

### 26.5 WHAT WOULD TURN THIS RED

- **PR #472 merging.** Then the route and the test arrive, the eleven rows become
  live questions, and §9's *"neither PR below is scored in any bucket"* needs
  re-deriving rather than re-reading.
- **Anything calling `telegraph_unsend_message_before_seen` in this tree.** The
  claim in 26.3 is a grep, and a grep expires. `check:writerless-reads` does not
  cover it: that check reports tables read with no writer, and this is a function.
- **`messages.unsent_at` appearing in production.** That is the fact 26.3 rests
  on, and the snapshot it is read from is refreshed, not continuous.

---

## §27 — The four reads §19.6 priced and declined, closed at zero line-shift; and the one that was telling people the wrong thing

**Measured at** `76698a377` (the squash of PR #484, and an ancestor of `main`). **`head_commit`
is NOT moved and NO verdict moves.** This section re-reads four lines and their tests; it
re-opens no row, and §1's reading rule applies to every row it does not name.

### 27.1 Why this is a section and not a footnote

§19.6 listed these four as *read against the code and deliberately NOT changed*, and the reason
it gave for three of them was identical and was a COST: *"Changing it would shift every line
below it in a 3,900-line file, and this section is not spending that on a log."* That sentence
is the reason a real defect sat named-but-open through §20, §21, §22, §23, §24, §25 and §26, and
it deserves to be answered rather than quietly overtaken, because **the cost was real and the
conclusion was still wrong twice over**:

1. **The cost was avoidable.** All four sites were repaired by replacing lines ONE FOR ONE —
   `git diff --stat` on `routes/messaging.ts` reads `23 insertions(+), 23 deletions(-)` and the
   file is the same 4,082 lines it was. Not one of the ~45 anchored citations this census holds
   into that file moved, nor census-compass's two, nor census-trust's two. A long chained builder
   collapsed onto one line frees the lines beneath it for the branch that was missing.
2. **One of them was not "a log".** See 27.2.

### 27.2 The accept path was telling recipients their request had been ACCEPTED when it may have been DECLINED

§19.6 item 2 graded the post-CAS status re-read as *"Real, small"*. The substance of the claim it
makes is indeed true — the swap matched no row, so the request really has left `pending`. What
§19 did not price is **which** wrong state the fallback picks:

```
sendError(res, 'invalid_payload', `Request is already ${(current as any)?.status ?? 'accepted'}`);
```

A request leaves `pending` in exactly two ways, `accepted` and `declined`, and on a failed read
this line asserts the first of them **by name, to the person who was refused**. supabase-js
RESOLVES on a database failure, so there is no throw and no 500 to notice: the outage is
delivered as a confident sentence about somebody else's decision. That is not a degraded answer
and not a missing log; it is a false statement about another person, produced by a read that
never happened.

The repair keeps the existing contract for the case the contract was written for — a status that
WAS read is still named and still answers `invalid_payload`'s 400 — and refuses to name one that
was not. An unreadable status answers `degraded_unavailable`, which is 503 and the only code
`lib/http.ts` marks retryable, because *"this was already answered and we cannot tell you how"*
is the true sentence available, and because a retry re-runs the guard at the top of the same
handler, which reports the real status the moment the table is back. A 500 was rejected
deliberately: `db_error` is not retryable, so a client acts on it by giving up, which is the one
outcome this path must not produce. A row that has VANISHED between the swap and the re-read is
absent rather than accepted, and gets the same 404 the pre-read gives.

### 27.3 The other three

- **`artifacts/api-server/src/routes/messaging.ts:413#const { data: before, error: beforeErr } = await client` — the prior-language read.** §19.6's analysis of the gate is
  correct and its conclusion does not follow from it: `null` and `undefined` do decide
  identically here, and the decision both reach is *sweep*. `retranslateForUser` pushes up to
  `RETRANSLATE_BATCH_LIMIT` messages through the PAID translation provider, so every save whose
  prior-language read failed billed a ~200-message sweep for a change nobody had made. The gate
  call now carries `!beforeErr`, and the failure is warned.
- **`artifacts/api-server/src/routes/messaging.ts:1114#const { data: previewMsg, error: previewErr } = await sc` — the preview-message insert.** §19.6 placed it outside this class
  as write-chain territory. Being outside a checker's scope is not being handled: the 200 is
  already sent when this runs, so the log is the only record the write can leave, and without it
  a preview that never landed left the thread created, the accept reported, the first message
  missing and nothing saying why. Still best-effort; now logged.
- **`artifacts/api-server/src/routes/messaging.ts:1565#const { count: hCount, error: hCountErr } = await q;` — the highlights count in the unread badge.** The last read in
  that block whose error was not bound at all, while its two neighbours — the block set and the
  circle-membership read — each already log and each already say the badge under-reports. The
  `0` on the wire and the test that pins it are untouched: **the owner decision §19.6 item 4
  surfaced is still open and is not taken here.** Only the silence is closed.

### 27.4 Why T344 and T363 do not move

Both are `W`, both stay `W`, and the reason is each row's own stated ceiling rather than an
arithmetic convenience. T344's blocker as §19 recorded it is the FOURTEEN sites of this class in
`routes/telegraph.ts`, `routes/telegraphChat.ts` and `routes/telegraphStream.ts` — *"those three
files are not this lane's, and a row is closed by whoever can close all of it"* — and none of
them is in `routes/messaging.ts`. T363's is stated even more directly: *"the open remainder is
outside `routes/messaging.ts` entirely."* Four more closures inside that file therefore move
neither row, and nothing here moves a row in the other direction either: every change is a
read-path refusal or a log where there was silence, so no `C` becomes `W`.

### 27.5 What would turn this red

- **A line inserted into `routes/messaging.ts`.** The zero-shift property is what keeps ~49
  citations across three censuses pointing at the right lines, and it is a property of this
  change, not of the file. The next edit there has to choose it again or repoint.
- **`shouldRetranslateOnLanguageChange` learning to distinguish "unreadable" itself.** The
  `!beforeErr` term is at the CALL SITE, because the gate module lib/retranslateGate.ts is
  shared with a second caller, routes/profile.ts, which makes the same prior-language read and
  was NOT touched here. **That second call site is not closed and is not this section's to
  close.** Both files are named here in plain text rather than cited: neither is a Telegraph
  behaviour this census grades, and `check:census-scope-coverage` is right to expect a cited
  file to be watched for staleness. Naming a neighbour is not grading it.
- **A client switching on the exact message text of the CAS-loss refusal.** The 400's wording is
  unchanged; the new 503 is a code that path never produced before.

---


> **RENUMBERED AT INTEGRATION, 2026-09-15.** This section was written as `§27` by the
> TELEGRAPH lane on `claude/telegraph-lane-wave` and the SWALLOWED-READS lane wrote a
> different `§27` on `claude/messaging-swallowed-reads` at the same time; both are above.
> This one is now `§28` and every `§27.x` reference INSIDE it was renumbered with it.
> Nothing else changed — no row, no verdict, no evidence. Under this census’s
> LAST-STATEMENT-WINS rule the two sections are independent: `§27` moves NO verdict, and
> the three rows this one moves (T178, T233, T416) are named in no other section of this
> pass.

## §28 — DELIVERED becomes a fact the bus already knew, reconnect stops starting from scratch, and the fan-out gets a size it will not exceed

TELEGRAPH lane, 2026-09-15, worktree `claude/telegraph-lane-wave` off
`claude/post-merge-census-redeclare` (`44ae0d4fe`). Three rows move. Everything
else this section says is a BLOCKER, written down so the next lane does not
re-derive it.

**No migration was written, no database was touched, no flag was flipped.** That
is the constraint this section worked inside and it is why it is three rows and
not thirty: §1's closing paragraph is right that a large part of the 157 W is
capped at 2810–2813 and at flags seeded FALSE, and nothing in a worktree moves
that. The three rows below are the ones whose missing half was CODE, in files
this lane holds, with no schema behind them.

### 27.1 T178 — `message.delivered`, and what a delivered receipt is allowed to claim

| id | was | now | why |
| --- | --- | --- | --- |
| T178 | N | **C** | §13.2 `message.delivered`. In the union (`artifacts/api-server/src/lib/telegraphEvents.ts:116#| "message.delivered" | "stream.resumed"`) and emitted from the BUS rather than from a send handler (`artifacts/api-server/src/lib/telegraphEvents.ts:416#function emitDeliveryReceipt(`), so the four call sites that publish `message.created` cannot forget it. No migration, no flag: true on every deployment of this branch. |

The row's reason was *"No delivered concept exists to emit (T69)"*, and T69's
is *"no DELIVERED concept anywhere"*. Both were true about the SCHEMA and both
missed the same thing: the realtime bus already observed a delivery fact on
every fan-out and threw it away. `publishToUsers` knows whether a recipient had
an open connection that ACCEPTED the event. That is what DELIVERED means in
every messaging product that has one, and it needs no column.

**What it claims, exactly, and what it refuses to.** That a recipient's open
connection took the event. Not that the message reached device storage — this
transport carries no client acknowledgement and inventing one would be a lie
with a number attached. Not that anybody read it: that is `message.seen`, it has
a different writer, and collapsing the two would destroy the distinction §7.4's
unsend window is built on. A callback that THREW is not a delivery
(`artifacts/api-server/src/test/telegraphDeliveryReceipts.test.ts:52#test("a delivered message emits message.delivered back to the sender", () => {`
and the throwing-subscriber case beside it); counting the attempt would make
DELIVERED mean "we tried".

**It carries a count, not a roster.** A delivery receipt is also a presence
disclosure — it says somebody's device is online right now — so `recipientUserId`
is populated only when the audience was exactly one person
(`artifacts/api-server/src/lib/telegraphEvents.ts:452#recipientUserId: recipients.size === 1 ? [...recipients][0] : null,`).
In a two-party thread that names somebody the sender already knows. In a larger
one it would turn a delivery receipt into a per-member presence feed — *who on
this trip has their phone open* — which nobody in the thread agreed to publish.
The rule keys off audience SIZE and not thread type, because this module does
not know the thread type and a rule that has to ask a caller can be answered
wrongly. The test asserts no member id appears anywhere on the wire
(`artifacts/api-server/src/test/telegraphDeliveryReceipts.test.ts:91#test("a multi-recipient audience is counted, never named", () => {`).

**`deliveredCount: 0` is a claim too, so it is scoped.** Zero means no
connection on THIS instance took it, which is not the same as offline when a
cross-instance broadcast hook is registered and another instance may hold the
socket. The receipt says which world it is reporting from
(`artifacts/api-server/src/lib/telegraphEvents.ts:454#crossInstance: _broadcastHook !== null,`)
rather than letting a local zero read as a global one
(`artifacts/api-server/src/test/telegraphDeliveryReceipts.test.ts:72#test("an offline audience is reported as delivered to nobody, not as silence", () => {`).
The failure to deliver is also a counter — `messagesDeliveredNowhere`
(`artifacts/api-server/src/lib/telegraphEvents.ts:440#if (origin === "local" && delivered.size === 0) stats.messagesDeliveredNowhere++;`)
— because a realtime outage that reaches an operator as *"the app feels slow"*
is unattributable, which is the same argument this file's own header already
makes about every other thing it swallows.

**An edit is not a delivery.** `message.updated` carries the same two fields a
receipt is addressed from, and receipting one would report the same message
delivered twice — which would make §28's duplicate-delivery SLO count this bus's
own bookkeeping as a defect
(`artifacts/api-server/src/test/telegraphDeliveryReceipts.test.ts:155#test("an edit is not a delivery", () => {`).

**Mutation results, ten mutants.** Nine caught: suppressing the receipt (7 of 10
tests red), naming a multi-party audience, counting a throwing callback as
delivered, suppressing the zero-delivery receipt, counting the sender's own
copy, emitting with no sender to address, hard-coding `crossInstance`, dropping
the `messagesDeliveredNowhere` counter, and widening the event-type guard so any
event could generate a receipt. **One survived and is reported rather than
hidden:** removing `publishToUsersLocalNoReceipt` changes nothing, because the
event-type guard already prevents recursion. That helper is defence in depth,
not the mechanism; the mechanism is the guard, and the guard IS caught.

### 27.2 T233 — reconnect resumes the conversation. It does not resume the event log, and cannot.

| id | was | now | why |
| --- | --- | --- | --- |
| T233 | N | **W** | §17.3 reconnect resume. Every frame now carries an `id:` line (`artifacts/api-server/src/routes/telegraphStream.ts:297#const frame = (id: string | null, event: string, data: unknown) => {`), so an EventSource returns its own `Last-Event-ID` and the cursor round-trips through the transport; the messages missed while away are replayed from `messages` (`artifacts/api-server/src/routes/telegraphStream.ts:144#async function readResume(`) and `stream.resumed` states on every connection whether the gap was actually closed (`artifacts/api-server/src/routes/telegraphStream.ts:368#frame(null, "stream.resumed", { type: "stream.resumed", ...outcome, ts: new Date().toISOString() });`). **W and not C: only the CONVERSATION resumes.** |

The row said *"The SSE stream carries no cursor … Gap recovery is delegated
entirely to polling"*. It carries one now, and polling is a fallback rather than
the mechanism.

**Why W.** The requirement names a *conversation/event* sequence and only the
first half is recoverable here. The bus is in-memory and lossy **by design** —
T369 records that the real tree emits no durable event log and that nothing in
production is rebuildable from events — so there is nothing to replay for
typing, presence or receipts, and replaying a typing indicator from four minutes
ago would be a false statement about the present rather than a recovered fact
about the past. **EXACT BLOCKER: a durable event log. The substrate for one is
`telegraph_outbox` in migration 2810, which no database has (T154, T195).**
Until that is applied and drained, the event half of this row cannot move, and
no amount of code in this file changes that.

**The cursor is a timestamp, and it is inclusive.** `messages` has no sequence
column on this tree — 2810's exists in no database (T228) — so the cursor is
expressed in `created_at` coordinates, the same convention migration 2400 used
for the §14.3 bound and for the same reason. The comparison is `>=`, not `>`
(`artifacts/api-server/src/routes/telegraphStream.ts:203#.gte("created_at", since)`):
`created_at` is not unique, an exclusive cursor drops a tied boundary row
silently and forever, and a duplicate is something the client already absorbs
because every replayed frame is labelled and carries a messageId
(`artifacts/api-server/src/routes/telegraphStream.ts:352#replay: true,`).
A gap is recoverable by nothing.

**A resume that did not happen says so.** Both reads bind their error. This is
the §20.7 class exactly: supabase-js resolves `{data: null, error}`, so an
unchecked read would make *"nothing arrived while you were away"*
byte-identical to *"we could not look"*, and a client that believed the first
would stop polling and lose the conversation. An unreadable roster and an
unreadable `messages` both resume NOTHING and report `resumed: false`
(`artifacts/api-server/src/test/telegraphStreamResume.test.ts:293#test("an unreadable roster resumes NOTHING and says so", async () => {`).
A malformed cursor is refused as a cursor rather than treated as the beginning
of time, and a cursor older than the 24-hour window is refused rather than
silently truncated
(`artifacts/api-server/src/test/telegraphStreamResume.test.ts:332#test("a cursor older than the resume window is refused rather than silently truncated", async () => {`);
a truncated replay reports `resumed: false` for the same reason, because a
partial replay that claimed success leaves a hole nobody looks for.

**Scope of the replay.** Live threads only — a thread the caller has LEFT is not
replayed into their stream — and the caller's own sends are excluded, because
their client wrote them optimistically and already holds them.

**Mutation results, eleven mutants, all caught:** exclusive cursor, roster error
swallowed, messages error swallowed, `left_at` filter dropped, own messages
replayed, `id:` line removed, `Last-Event-ID` ignored, malformed cursor treated
as epoch, resume window unbounded, `stream.resumed` never emitted (7 of 9 red),
replay marker dropped.

### 27.3 T416 — the fan-out gets a bound, on the path rather than on a thread type that does not exist

| id | was | now | why |
| --- | --- | --- | --- |
| T416 | N `∅` | **W** | §30A.12 bounded fan-out. Two bounds, both exported and both proved: presence-class events are shed above 50 recipients (`artifacts/api-server/src/lib/telegraphEvents.ts:596#export const FANOUT_PRESENCE_MAX = 50;`) and every event degrades to a single poll signal above 500 (`artifacts/api-server/src/lib/telegraphEvents.ts:606#export const FANOUT_HARD_MAX = 500;`). The absence is no longer unguarded. **W and not C: §30A.12's Event conversations still do not exist (T415), so the bound has never been exercised by a real large thread.** |

The row read *"Unguarded absence: `publishToThread` fans out to every active
member with no size bound, and the rule is unviolated only because event
conversations do not exist."* The second clause is still true and is the ceiling;
the first is not.

**The bound belongs on the PATH.** `publishToThread` is the same function for
every thread type, so a bound attached to a thread type that does not exist yet
is a bound that will be missing on the day it first matters. It is applied to
the resolved audience, which is the thing that actually costs.

**Two bounds, because there are two costs.** Presence-class events — typing,
read receipts, per-message seen, and the delivery receipts §28.1 just added —
cost O(members) per KEYSTROKE and carry nothing a reader loses by missing, so
they stop at the smaller bound
(`artifacts/api-server/src/test/telegraphFanoutBounds.test.ts:93#test("presence is SHED above the presence bound, and counted", async () => {`).
Message-class events carry the conversation itself and are deliberately NOT shed
for being popular
(`artifacts/api-server/src/test/telegraphFanoutBounds.test.ts:119#test("a message SURVIVES the presence bound — the conversation is the payload", async () => {`);
above the hard bound they degrade to a poll signal that names the original type,
so one publish costs a constant payload instead of a roster and no message body
rides a fan-out that wide
(`artifacts/api-server/src/test/telegraphFanoutBounds.test.ts:134#test("above the hard bound a message degrades to a poll signal, never to silence", async () => {`).
**Degrading is not silence** — the member is told the thread moved and what kind
of thing moved — and both sheds are counters, not silent drops.

**What this does NOT close, stated so it is not quoted as more than it is.** The
shed is by conversation SIZE, not by LOAD. T259's second half asks for
server-side shedding *under load*, and there is still no load signal here; T239's
gap is a bandwidth signal on the device, which is a client fact this lane holds
no file for. Neither row moves. Both thresholds also sit above every conversation
this repository can create, which is why nothing shipped changes behaviour — and
why this row is W: the mechanism is proved on a synthetic roster.

**Mutation results, eight mutants, all caught:** presence bound removed,
`message.created` added to the presence class, hard bound degrading to silence,
degraded signal carrying the original payload, hard bound removed, presence shed
applied to small threads, counters not incremented, `originalType` dropped.

### 27.4 Rows examined and NOT moved, with the exact blocker

Read in full from the `CENSUS_INTEGRITY_DUMP=ALL` dump — 157 W and 61 N — under
last-statement-wins. These are the ones that looked closable and are not.

| id | exact blocker |
| --- | --- |
| T69, T72, T139, T141, T156, T210, T228, T230, T231 | Columns that exist only in `2810`/`2811`. **No database has run them.** T69 gains DELIVERED as a concept from §28.1 — two of six becomes three of six — and still has no `lifecycleState` column and no UNSENT, so it does not move. |
| T142, T143, T144, T147, T154, T158, T161, T163, T181, T195, T196 | Same: 2810–2813 tables and triggers, applied nowhere. |
| T211, T313, T389, T390, T444 | Migration `2400` applied nowhere AND `telegraph_history_bound_enabled` seeded FALSE. Two independent external settings; code changes neither. |
| T276, T278, T283, T284 | Flag seeded FALSE plus an unapplied migration. T278 additionally: five of its six origins are unverifiable in principle here. |
| T53, T63, T225, T243, T274, T371 | Voice. Needs a migration widening `messages.media_type` and an audio MIME in the pipeline. Neither is this lane's to write. |
| T75, T76, T77, T326, T327, T338, T348, T387 | Unsend. PR #472 is unmerged and applied to `portava-ci` only; §26.3 is the standing record. |
| T347 | SLO-02's exact form needs the idempotency key the send path does not have (T231) — which needs 2810. |
| T233 (event half), T369, T428 | A durable event log. Substrate is `telegraph_outbox` (2810), applied nowhere. |
| T435 | A durable diagnostics audit needs a `record_type` `admin_access_log` does not accept — a migration, or a false label in an audit trail. |
| T11, T123, T295, T320, T411, T413, T423, T448 | Client-side, and this lane deliberately did not take them: the client test surface here is `jest`, which this worktree's brief does not establish a command for, and a client change proved only by typecheck is a change this census would have to record as untested. |
| T35, T319, T359, T397, T445 | Named files belong to other lanes (`routes/circle.ts`, `services/groupChatSync.ts`, `NotificationDeduplicationService.ts`). |
| T259, T239 | See 27.3 — a LOAD signal and a BANDWIDTH signal, neither of which exists. Size is not load. |

### 27.5 The swallowed reads this lane found and did NOT fix, and why

§20.7's class, re-scanned across the Telegraph tree. Result:
`src/services/telegraph/`, `src/domain/telegraph/`, `src/server/telegraph/` and
`src/routes/telegraph*.ts` hold **no** `const { data } = await` site — the
earlier lanes closed them. Two findings remain.

**`src/routes/telegraph.ts` — five sites, ruled HARMLESS, reasoning here.** This
file is the AI recommendation route and is not in `CENSUS_SCOPE`. Each of its
five error-discarding reads fails CLOSED: an unreadable `feature_flags` degrades
to no location context; an unreadable `user_hashtag_follows` or `hashtags`
produces no span rather than a wrong one; an unreadable `profiles` empties the
candidate set so no mention resolves; and an unreadable `user_follows` leaves
both follow sets empty, which makes the `friends_only` and `interacted` tests
false and therefore SUPPRESSES those mentions. None of the five can admit
something a successful read would have refused. The one site in that file that
could have — the `blocks` read — already binds its error and suppresses every
mention span on failure.

**`src/routes/messaging.ts` — four sites, REAL, and BLOCKED for a reason worth
recording.** They are: the prior-`preferred_language` read whose dropped error
makes the retranslate gate see a change that may not have happened and bill a
200-message provider sweep; the lost-CAS-race status read that falls back to the
literal `'accepted'` and so tells a caller their request was ACCEPTED when it may
have been declined; the accept path's preview-message insert whose error is
discarded, so a message that never landed leaves no record; and the highlights
count in the unread badge, the last unbound read in a block whose two neighbours
already log and under-report by choice. LDB-05 is still `divergent` and this is
what is left of it.

**The blocker is not the code.** A fix was written, tested and reverted. Any
insertion in that file shifts lines, and `routes/messaging.ts` is cited by
`census-compass.md` (three anchored citations), `census-trust.md` (one) and this
census (roughly forty-five). `check:doc-citations` goes red on all of them, and
repairing the first two means editing two other lanes' censuses — which this
lane does not own — and ageing them in `check:census-freshness` besides. The
same collision cost the union declarations in `lib/telegraphEvents.ts` their
natural position: `census-layover.md` cites that file by the line number of its
`payload` field comment, so the two new
event types are declared on the existing `reconnect` line and documented below
the interface, which is ugly and is the honest price of not silently repointing
another lane's evidence. **Recommendation for the coordinator: the four
`messaging.ts` sites are a single small commit plus four citation repoints
across three censuses, and they should be done by whoever can touch all three.**

### 27.6 What would turn this section red

- **`message.delivered` losing its emitter.** It is emitted from the bus, so a
  future send path cannot drop it by forgetting — but moving the emit back into
  a handler would restore exactly the fragility it was placed there to avoid.
- **An exclusive resume cursor.** `>` instead of `>=` reintroduces the silent
  gap; the mutation is in the suite and goes red.
- **Either fan-out bound rising above a real thread size, or `message.created`
  entering `PRESENCE_CLASS_EVENTS`.** The second would shed conversations.
- **A durable event log arriving.** Then T233's event half becomes a live
  question and §28.2's ceiling must be re-derived rather than re-read.

### 27.7 Headline, restated from the rows

`check:census-integrity` parsed every one of the 451 and counts, at this commit:

| Measure | Value |
| --- | --- |
| BUILT-AND-CORRECT | **231** |
| BUILT-BUT-WRONG | **159** |
| NOT-BUILT | **58** |
| CANNOT-VERIFY | **3** |
| **CONSTRUCTED%** = (231+159)/451 | **86.5 %** |
| **CORRECT%** = 231/451 | **51.2 %** |

This supersedes §24.2's `C 230 / W 157 / N 61 / X 3` and §1's much older
`209 / 176 / 51`, both of which are left in place because this document is
append-only. **The delta from §24.2 is exactly the three rows in §28.1–§28.3 and
nothing else: T178 N→C, T233 N→W, T416 N→W.** It is the tool's count, not an
addition sum — §24's own correction records what happens when a headline is
arrived at by adding a pass's moves to the previous headline — and it certifies
nothing about the other 448 rows, which were read in this pass and not
re-measured.

---

## §29 — An INDEPENDENT check of §27 and §28's ledger arguments at `a97bfdac0`: both hold, and §27.5 says two things about routes/profile.ts that are false

*Written 2026-09-16 by an independent reviewer with no lane in this tree, sent to
check the arguments in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`
rather than to inherit them. Measured against `a97bfdac0`. **No verdict of this
census moves.** `head_commit` is NOT re-declared here and the ledger is NOT
edited; §29.4 states what this licenses.*

### 29.1 §27's zero-shift claim, re-derived

§27 and its ledger entry both rest on a property rather than on a promise: that
`artifacts/api-server/src/routes/messaging.ts` changed `+23/-23` with **no line
moving**, so ~49 citations across three censuses kept pointing at the right code.
Re-derived at both commits by this reviewer:

- `git diff --stat 1fe72289b..a97bfdac0` on that path reads **23 insertions, 23
  deletions**.
- The file is **4,081 lines** at `1fe72289b` and **4,081 lines** at `a97bfdac0`.
  (§27's entry and the `census-trust.md` entry both say "4,082"; `wc -l` says
  4,081 at both commits. The PROPERTY they are asserting — that the count is the
  same — is true; the number they print is off by one, a final-newline artefact
  and nothing else. Recorded because a number in an argument should be right.)
- `check:doc-citations` reports **0** unresolvable citations and **0** broken
  anchors at this tree.

**The claim holds.** `T344` and `T363` stay `W` on their own stated ceilings —
§19's fourteen sites in `routes/telegraph.ts`, `routes/telegraphChat.ts` and
`routes/telegraphStream.ts`, none of which is in `routes/messaging.ts`.

### 29.2 §27.5 is FALSE in two places about profile.ts, and the second is now stale as well as wrong

*File names in this subsection are written in PLAIN TEXT, without line pointers,
for the reason §27.5 itself gives: neither file is a Telegraph behaviour this
census grades, and check:census-scope-coverage is right to expect a cited file to
be a watched one. **The cited evidence for everything below is in
`census-trust.md` §20**, which is the census that counts routes/profile.ts.*

§27.5's second red-flag bullet reads, of the shared gate module
lib/retranslateGate.ts:

> *"the gate module lib/retranslateGate.ts is shared with a second caller,
> routes/profile.ts, **which makes the same prior-language read** and was NOT
> touched here. **That second call site is not closed and is not this section's
> to close.**"*

Both emphasised clauses are false at `a97bfdac0`, and the first was false when it
was written.

**(1) routes/profile.ts does not make a prior-language read, and never did.** It
performs no change detection at all: the PATCH handler has already written the
new language by the time it reaches the gate, so no prior value is in scope, and
the file's own comment says exactly that. What it reads is the
auto_translate_messages PREFERENCE, which feeds the same gate through a different
argument. **The blast radius is the OPPOSITE of the one §27 describes for
routes/messaging.ts.** There, a swallowed read bound the prior language to null,
the gate read that as A CHANGE, and every failing save billed a ~200-message
sweep to a PAID provider. Here, a swallowed read handed the gate an undefined
preference, which it correctly reads as "unknown, fail closed" — so the failure
SUPPRESSED a sweep the user was entitled to, and a user with auto-translate ON
kept their old-language translations permanently and silently, because the sweep
is fire-and-forget and is never retried. Same module, same swallow, opposite
direction. §27.5 called it "the same read"; it is not, and that distinction is
precisely why the discrimination belongs at each call site rather than inside the
gate — which is the ruling §27 itself made and then mis-stated the evidence for.

**(2) That call site IS closed, at `a97bfdac0`.** The error is bound and the loss
is logged, and the gate call carries an explicit non-error term so the property
survives anyone later giving the preference a permissive default. Four further
sites in the same file were bound in the same change. The ANSWER does not move,
on purpose: "could not read the preference" must keep meaning "do not spend", and
the profile write has already committed, so a 503 would tell a client to retry a
save that succeeded.

**Neither correction moves a Telegraph verdict**, and neither is a verdict at
all: §27.5 is a "WHAT WOULD TURN THIS RED" register, routes/profile.ts is in no
Telegraph row's evidence, and §27.5 itself says — correctly — that naming a
neighbour is not grading it. **This is an ACCOUNTING correction.** It is recorded
here rather than edited into §27.5 because the corpus is append-only, and it is
recorded at all because §27.5 hands the next reader a live to-do item that has
been done, and a characterisation of it that would send them looking for the
wrong defect in the wrong direction.

### 29.3 A file this census's verdicts rest on changed, and nothing aged

*Plain text again, and for the same reason; the cited evidence is in
`census-trips.md` §74.*

The trip-membership invariant module under domain/trips/invariants/ gained 121
lines between `1fe72289b` and `a97bfdac0`, and **four of its reads left** the
repository's unchecked-reads allowlist. It is not in this census's CENSUS_SCOPE
and it is named in no acknowledgement for this census — so
`check:census-freshness` reported this document ACKNOWLEDGED while a file two of
its statements rest on moved underneath it. **That is the shape of the gap, and
it is structural: the freshness model ages a census on the files it CITES, and a
verdict can rest on a file that a cited file CALLS.** Stated as a finding about
the instrument, not as a complaint about any lane.

**Checked, and nothing moves.** §11.11's `T278` ceiling paragraph states that
*"the `catch` in `resolveRequestOrigin` is currently unreachable, because
`isAcceptedTripMember` has its own try/catch"*. At `a97bfdac0` that is still
exactly true, and it is true BY DESIGN rather than by luck: a new discriminating
read that keeps DENY and UNKNOWN apart was added beside it, and
`isAcceptedTripMember` was deliberately left as a NON-THROWING wrapper over that
read — because, in the module's own words, its two callers are outside its lane
and neither has a catch for it. One of those two callers is this census's own
`artifacts/api-server/src/domain/telegraph/policies/requestOrigin.ts:49#import { isAcceptedTripMember }`.
An unreadable roster still answers `false`, so a failed membership read still
cannot resolve to `verified`, which is `P24`'s named attack. `T278` stays `W`
for the two reasons §11.11 gives: no database has 2813, and five of six origins
are unverifiable in principle.

### 29.4 What this licenses, and what it does not

Re-measured here: §27's zero-shift property; `T344`/`T363`'s stated ceiling;
`T278`'s unreachable-catch claim and the trip-membership hop behind it. Not
re-measured: everything else, including the three moves §28 records
(`T178` `N`→`C`, `T233` `N`→`W`, `T416` `N`→`W`) and the other 448 rows.

**This census's `head_commit` should NOT advance to `a97bfdac0` on this section
alone.** Eleven counted files are named in its ledger entries; four were re-read
here. The licence, if the coordinator grants one, has to come from §27 and §28's
own measurements together with this check, and the declaration should say so.

**Headline unchanged**, at §28.7's C 231 / W 159 / N 58 / X 3 — no row moves in
this section. **Guards at this tree:** `check:census-freshness` **0**,
`check:census-scope-coverage` **0**, `check:census-integrity` **0**,
`check:census-row-move-labels` **0**, `check:doc-citations` **0**,
`check:citation-targets` **0**. `check:write-path-columns`,
`check:missing-live-columns`, `check:authorization-contract`,
`check:media-objects` and `check:rank-events-surfaces` exit **2** without live
credentials — **UNVERIFIED, not green**, and nothing above rests on them.

---

## §30 — VOICE IS BUILT ON THIS BRANCH, AND NO ROW BELOW HAS BEEN RE-GRADED FOR IT

**This section moves no verdict.** It exists because several statements above are
now false about this tree, and a census whose last word is a false statement is
worse than one that is merely old.

### 30.1 What changed

The telegraph build lane implemented VOICE messages end to end and the
integrating lane merged that work at this branch's head:

| Piece | Where |
| --- | --- |
| Payload, duration and MIME bounds | `artifacts/api-server/src/services/telegraph/voice.ts` |
| Upload + send routes | `artifacts/api-server/src/routes/telegraphVoice.ts` (`POST /api/telegraph/voice/upload`, `POST /api/threads/:threadId/voice`) |
| Audio sniffing | `artifacts/api-server/src/lib/mediaProcessing.ts#sniffVoiceAudio` and `#isoTrackHandlers`, `artifacts/api-server/src/lib/mediaPipeline.ts#guardUploadRequest` |
| `media_type` widening | `artifacts/api-server/src/migrations/2989_messages_audio_media_type.sql` |
| Envelope + parse | `artifacts/api-server/src/services/telegraph/messageKinds.ts` |
| Recorder, player, client API, policy | `travel-buddy-standalone/src/features/telegraph/voice/` |

### 30.2 The statements above that are now false, named

* **§21.5's T53 line** — "*deliberately NOT moved … REFUSED by name with the
  constraint that blocks it*" — described a tree in which VOICE had no payload,
  no route and no audio MIME. All three now exist.
* **T225's evidence** — "*`lib/mediaPipeline.ts:75` `ALLOWED_MEDIA_MIME` admits
  no audio type*" — remains literally true of that constant, and is no longer
  the whole story: voice audio is admitted by a voice-only allowlist on its own
  route, which is why the general one did not need widening.
* Any row whose evidence turns on "there is no voice message in this tree".

**The rows themselves are unchanged and are NOT to be read as measurements of
this branch.** Every verdict in this document is a LOWER BOUND at
`head_commit 1fe72289b`. The direction of the error is known and one-way —
nothing in this build removed a capability — but a row that says a thing is
absent may now describe a thing that exists. Promoting a verdict requires
reading the row against the code; that is the verification phase's work, and
doing it here, from the builder's own account, is exactly the shortcut this
corpus exists to prevent.

### 30.3 Two things that are NOT built, so the recensus does not over-correct

1. **`2989` is applied to NO database** — not production (`ajrurzioarfkagpuxfnb`),
   not portava-ci (`hwokxgbmezheskbzskfr`). On every database that exists today
   `messages.media_type` still refuses `audio`, so the send route's insert would
   fail its CHECK. **Voice is built in this tree and is live nowhere.**
2. **§6.3's optional transcript/translation is not built**, and the blocker is
   an owner/infrastructure decision rather than code: no speech-to-text provider
   is configured in or reachable from this tree. A nullable `transcript` field
   was deliberately not added to `VoicePayload`, because nothing would write it.
   Consequence: a voice note is not findable by §6.4's object-aware search, and
   `searchableTextOf` returns null for it — which is correct, and asserted,
   rather than indexing a storage URL.

Six further defects the lane found and did not fix are in
`docs/BUILD-BACKLOG.md` under `## telegraph lane — 2026-09-16`, including
`sniffMedia` classifying an audio-only ISO-BMFF file as `video/mp4` and the
VOICE drawer row drawing the literal `voice` as its title.

### 30.4 Provenance of this section

Written by the integrating lane at the telegraph merge, from the merge diff and
the lane's own report, not from a re-measurement. `head_commit` is unchanged at
`1fe72289b`; the acknowledgement covering these files is in
`artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` and is the
only acknowledgement in that file that argues a verdict DID move rather than
that none could.

---

## §31 — Nearby becomes a referent: buckets that cannot hold a coordinate, an order that cannot disclose one, and a precise fix that stops following the account

Written by the TELEGRAPH LANE 3 (location, proximity and privacy) worktree.
**Nothing here is merged and no flag was enabled.** `head_commit` is not
re-declared for the census as a whole; this section measures only the rows it
names.

PROVENANCE, stated rather than rounded off: the worktree was checked out at
`857ad9fb9` and every measurement below was taken there. The branch had since
advanced to `e43fc628a` (the offline-substrate merge), so this lane's commits
were REBASED onto it and the census checks, the citation check and the suites
covering every file touched were re-run on the rebased tree. `857ad9fb9` is an
ancestor of `e43fc628a`, and nothing between them touches a file this section
grades — the overlap is two shared ledgers, `CENSUS_STALENESS_ACKNOWLEDGED.json`
and `checkCensusFreshness.ts`, both of which this lane also edits and both of
which rebased without conflict.

Seven rows move, all `N → W`, and none moves to `C`. The reason is the same for
all seven and is stated once here rather than seven times: the surface built
below is **dark**. `nearby_reachable_enabled` is seeded FALSE by
`migrations/2998_nearby_reachable_flag.sql`, which is applied to no database, so
it has no `feature_flags` row on any deployment; `isFlagEnabled` answers false
for an absent row exactly as it does for a false one, and no client calls the
route. A capability nobody can reach is built, not correct.

### 31.1 What was built, and where

**The bucket ladder that cannot be handed a coordinate** —
`lib/proximityBuckets.ts`. `proximityBucketBetween`
(`lib/proximityBuckets.ts:224#export function proximityBucketBetween`) accepts
only a `CoarsePoint`, and the single constructor of one is `coarsePointFor`
(`lib/proximityBuckets.ts:114#export function coarsePointFor`), a wrapper over the map's existing
grid-snap + per-user jitter coarsener. There is no `fromExact`, no exported
distance and no exported km → bucket function: the haversine and
`proximityBucketFromKm` are module-private, so the "compute the true distance,
then round it" pipeline cannot be assembled out of this module's parts. A point
that claims to be coarse but carries a fine cell is refused at runtime
(`lib/proximityBuckets.ts:141#export function assertCoarsePoint`), and the narrowest bucket edge is
bounded below by twice the finest coarsening cell
(`lib/proximityBuckets.ts:183#export const MIN_BUCKET_EDGE_KM`) so bucket membership can never resolve
a position more finely than the coordinate it was computed from.

**The projection** — `services/telegraph/reachablePeople.ts`.
`projectReachablePerson` (`services/telegraph/reachablePeople.ts:376#export function projectReachablePerson`) builds
§30A.2's six inputs — relationship, availability, permitted proximity, shared
context, privacy and safety — into one object whose `proximity.precision` is the
LITERAL TYPE `"bucket"` (`services/telegraph/reachablePeople.ts:192#readonly precision: "bucket"`), so a precise rung
is not representable and every construction site would be a compile error rather
than a review comment. It is **not a fifth relationship resolver**: §30A.1's
evidence names four already, so `relationshipFrom`
(`services/telegraph/reachablePeople.ts:129#export function relationshipFrom`) projects `canMessage`'s own
`relationship_context` and reads no table.

**The ranking, and the order** — `nearbyRank`
(`services/telegraph/reachablePeople.ts:285#export function nearbyRank`) scores
§4.3's nine factors. Its input type carries no distance, no ETA and no
timestamp, so the ranker cannot see anything finer than a bucket.
`orderReachablePeople` (`services/telegraph/reachablePeople.ts:319#export function orderReachablePeople`) sorts on
rank and then on `stableTiebreak` (`services/telegraph/reachablePeople.ts:309#export function stableTiebreak`), a
per-(viewer, person) hash with no geographic content.

**Invisible mode** — `lib/invisibleMode.ts`. Resolved from the three live
location-consent columns (`lib/invisibleMode.ts:125#export function resolveInvisibleMode`), fail-
closed: an unreadable `location_preferences` row engages invisibility
(`lib/invisibleMode.ts:127#prefs_unreadable`). Suppression and permission are two disjoint sets, and
the second half of §4.4 is a TYPE — `permitsPrivateMapUse`
(`lib/invisibleMode.ts:167#export function permitsPrivateMapUse`) returns the literal `true`, so
making invisible mode take the private map away does not fail a test, it fails
to compile.

**The read layer** — `services/telegraph/reachablePeopleQuery.ts`. Every
consent-bearing read checks `error` and returns a named refusal
(`services/telegraph/reachablePeopleQuery.ts:374#stage: "candidate_prefs"` and its eight siblings); an unknown block state
refuses the whole answer (`services/telegraph/reachablePeopleQuery.ts:267#if (blockedSet === null)`); the emergency stop
is consulted on the SERVE path (`services/telegraph/reachablePeopleQuery.ts:255#isKillSwitchEngaged`). The candidate set is
the viewer's circle members and accepted trip crew, capped at
`services/telegraph/reachablePeopleQuery.ts:80#export const MAX_CANDIDATES` — there is no viewport parameter and no "who is
near this point" query, which is §4.6's separation expressed as an absence
rather than a filter.

**The surface** — `routes/nearbyReachable.ts`, mounted at
`routes/index.ts:393#router.use(nearbyReachableRouter)`. Flag-gated
(`routes/nearbyReachable.ts:105#nearby_reachable_enabled`), rate-limited, and quantised: `quantiseNow`
(`routes/nearbyReachable.ts:84#export function quantiseNow`) floors the clock to 60 s so two polls inside
one quantum are byte-identical. A failed read is a retryable 503
(`routes/nearbyReachable.ts:128#degraded_unavailable`), never an empty list. The one success log carries
counts and bucket names (`routes/nearbyReachable.ts:132#req.log.info`).

**Device-bound precise location** — `lib/preciseLocationDevice.ts` plus the two
`/me/location-state` handlers. A precise coordinate is served only to the device
that published it (`lib/preciseLocationDevice.ts:154#export function precisionForDevice`,
`lib/preciseLocationDevice.ts:172#device_mismatch`), proven against the account's own rows in the `devices`
registry (`lib/preciseLocationDevice.ts:210#export async function verifyDeviceForUser`) — the registry T235
recorded as *"not consulted by any location path"*. The GET degrades to a
grid-snapped point and NAMES the degradation
(`routes/location.ts:134#coordsPrecision: coords ?`); the POST binds the
publishing device and CLEARS the binding for a publish it cannot attribute
(`routes/location.ts:293#bindPreciseShare(user.id`, `routes/location.ts:297#clearPreciseShare(user.id)`).
The client presents its registered device id
(`travel-buddy-standalone/src/hooks/useActiveLocation.ts:142#async function deviceIdHeaders`),
never treats a restored approximate point as live
(`travel-buddy-standalone/src/hooks/activeLocation.state.ts:235#export function clampFreshnessForPrecision`)
and drops the held location on an account change
(`travel-buddy-standalone/src/hooks/activeLocation.state.ts:251#export function buildAccountChangeState`, wired at
`travel-buddy-standalone/src/hooks/useActiveLocation.ts:272#buildAccountChangeState(prev)`) —
the same shape `platform/input-assistance/services/policyStore.ts:198#setActiveAccount`
uses for its policy snapshot.

**One honest read added to an existing service** —
`services/passport/OpenToPlansService.ts:342#export async function listWindowsForOwners`
returns `null` on a failed read where its single-owner sibling returns `[]`. The
sibling is left exactly as it is; a multi-person projection cannot use a shape
that says "none of these twenty people is available" when a table was unreadable.

### 31.2 The three disclosure channels, and where each is closed

| channel | closed by | what a regression would look like |
| --- | --- | --- |
| response body | `ReachablePersonProjection` has no positional field and `proximity.precision` is the literal `"bucket"` (`services/telegraph/reachablePeople.ts:192#readonly precision: "bucket"`) | a `distanceKm` appears "just for the UI" — caught by `nearbyRankOrderChannel.test.ts` walking the payload's KEYS (a substring scan cannot: "relationship" contains "lat") |
| logs | the only success log is `reachableTelemetry`'s counts (`routes/nearbyReachable.ts:132#req.log.info`); nothing in the lane hands a logger a position, because the projection layer never holds one | a debug field carrying ids and coordinates — caught by `nearbyReachableRoute.test.ts`, which captures the payload the handler actually hands `req.log` |
| ranking ORDER | `nearbyRank` takes a bucket index, `orderReachablePeople` breaks ties on a geography-free hash (`services/telegraph/reachablePeople.ts:309#export function stableTiebreak`) | "nearest first, it reads better" — caught by swapping two people's true positions INSIDE one bucket and asserting the published order does not change |

### 31.3 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| T24 | N | **W** | **`nearbyRank` over availability, relationship, intent, shared context, overlap window, travel time, proximity bucket, freshness, safety** — The ranking function over people now exists: `services/telegraph/reachablePeople.ts:285#export function nearbyRank` scores all nine, each as a rank on a small ladder, with availability weighted above proximity so the surface is not a proximity radar wearing an availability label. Its factor type has no distance and no ETA, and the ORDER is rank then a per-viewer hash (`services/telegraph/reachablePeople.ts:319#export function orderReachablePeople`). Still W: the route that serves it is flag-dark, `safety` is supplied as the constant `clear` because no safety signal is wired to it, and the candidate set is capped at 24 graph members — a ranking over a bounded list, not over "people near me". |
| T25 | N | **W** | **Approximate proximity or controlled distance buckets BY DEFAULT** — The default is not a coarsened precise value; it is a value the code cannot express precisely. `lib/proximityBuckets.ts:224#export function proximityBucketBetween` takes only points produced by `lib/proximityBuckets.ts:114#export function coarsePointFor`, exports no distance and no km → bucket function, and refuses a forged coarse point at runtime (`lib/proximityBuckets.ts:141#export function assertCoarsePoint`). The narrowest edge is pinned to ≥ 2× the finest map cell (`lib/proximityBuckets.ts:183#export const MIN_BUCKET_EDGE_KM`, asserted in `test/proximityBuckets.test.ts`). Still W: the only consumer is the dark route, so no live surface serves a bucket today. |
| T26 | N `∅` | **W** | **Repeated refreshes must not become a movement-tracking side channel** — No longer an unguarded absence. There is now a refreshable proximity endpoint and it is guarded twice: a per-user rate limit, and — the one that closes the channel — an information quantum, `routes/nearbyReachable.ts:84#export function quantiseNow`, which floors the clock so two polls inside 60 s return byte-identical bytes. Differencing needs the subject to cross a ≥ 5 km bucket edge. Still W: the guard is per-request quantisation, not the per-relationship budget §4.5 describes, and nothing bounds observations across a long session. |
| T29 | N | **W** | **Invisible mode suppresses Nearby / Bump / public availability while ALLOWING private Map use** — Both halves exist and are separately enforceable. `lib/invisibleMode.ts:125#export function resolveInvisibleMode` derives the state from the three live location-consent columns and fails closed on an unreadable row (`lib/invisibleMode.ts:127#prefs_unreadable`); the projection applies it as TWO live suppressions rather than one early exit (`services/telegraph/reachablePeople.ts:398#const nearbySuppressed`, `services/telegraph/reachablePeople.ts:399#const availabilitySuppressed`), so knocking either out is a red test rather than dead code; and the private half is a type — `lib/invisibleMode.ts:167#export function permitsPrivateMapUse` returns the literal `true`. Deliberately NOT derived from `show_online_status`: that would collapse two of §4.1's four permissions into one, and the test pins it. Still W: there is no user-facing "invisible mode" control — it is a server-side reading of controls that already exist — and the live Discovery map enforces the same columns through its own code rather than through this module. |
| T235 | N | **W** | **Active precise location is device-specific and must not automatically transfer to a newly authenticated device** — `GET /me/location-state` now serves a precise coordinate only to the device that published it: `lib/preciseLocationDevice.ts:154#export function precisionForDevice` is precise in exactly one case and degrades to a grid-snapped point in six, including `lib/preciseLocationDevice.ts:172#device_mismatch`, which is this row's scenario. The `devices` registry the row recorded as never consulted by a location path is consulted (`lib/preciseLocationDevice.ts:210#export async function verifyDeviceForUser`), and the publishing device is re-bound on every fix, with an unattributable publish CLEARING the binding (`routes/location.ts:297#clearPreciseShare(user.id)`) so the reverse transfer is closed too. Still W, and the reason is structural: the binding is PROCESS-LOCAL with a 60-minute TTL, because no deployed location table has a device column. A restart, or a second instance, coarsens every share until the owning device publishes again — safe, but not durable — and `trip_crew_location_sessions` and the Safe Return live share are still keyed by account alone. |
| T382 | N | **W** | **§30A.2 Server-built `ReachablePersonProjection` combining relationship, availability, permitted proximity, shared context, privacy and safety** — The projection exists and is built server-side from all six: `services/telegraph/reachablePeople.ts:376#export function projectReachablePerson`, fed by `services/telegraph/reachablePeopleQuery.ts:245#export async function loadReachablePeople`. Relationship comes from the canonical resolver rather than a fifth one (`services/telegraph/reachablePeople.ts:129#export function relationshipFrom` over `canMessage`'s context), availability from the §4/§31 audience predicate plus the live quick-status opt-in, proximity as a bucket only, and consent fails closed on every read. Still W: it is served by a dark route, `safety` is a constant, and the projection is computed per candidate with one `canMessage` round each, which is why the candidate set is capped at 24. |
| T400 | N | **W** | **Precise location sharing is device-specific and must not SILENTLY transfer to a newly authenticated device** — Same mechanism as T235, and the word *silently* is what this row adds: the degraded answer names itself on the wire — `coordsPrecision` and `coordsPrecisionReason` (`routes/location.ts:134#coordsPrecision: coords ?`) — and the client refuses to present a restored approximate point as live (`travel-buddy-standalone/src/hooks/activeLocation.state.ts:235#export function clampFreshnessForPrecision`). A new phone still gets the city and a coarse point, so the account is not left locationless. Same W ceiling as T235. |

**Rows looked at that did NOT move, and why:**

| id | stays | why it did not move |
| --- | --- | --- |
| T22 | W | **AVAILABLE ≠ ONLINE ≠ NEARBY ≠ SHARING LOCATION** — NEARBY now has a referent, which was the row's stated gap, but the row asks for four separate permissions and this lane added no new consent store: the nearby surface READS the three that exist. What it does add is a guard against the collapse — invisible mode is deliberately not derived from `show_online_status`, asserted in `test/invisibleMode.test.ts`. The four-way separation is still a three-way one with a fourth surface reading them. |
| T23 | W | **`AvailabilitySignal` contract** — `audiencePolicyId`, `proximityVisibility` (HIDDEN/NEARBY/DISTANCE_BUCKET/ETA_IF_MUTUAL) and `geographyScope` are still absent from `availability_windows`. The projection expresses a proximity rung of its own, but it is not a field of the signal and the signal's vocabulary is unchanged. |
| T27 | W | **Exact ETA / location requires stronger mutual coordination permissions** — No ETA was built; `travelBandForBucket` is a band derived from a bucket, deliberately not a time. The reciprocity this lane does add (a viewer who publishes no position receives no bucket) is symmetry, not the mutual-coordination grant the row asks for. |
| T28 | W | **Availability expires automatically and revokes across Telegraph, Discovery and Compass** — A second Telegraph reader now exists (`services/telegraph/reachablePeopleQuery.ts:245#export async function loadReachablePeople`) and it re-evaluates expiry on the read, through Passport's own predicate for windows and through `expires_at` for quick status. Cross-surface revocation is still not implemented, and `open_to_plans_windows_enabled` is still seeded OFF, so the windows half is empty on every deployment. |
| T30 | W | **Blocking is absolute and removes both parties from each other's proximity surfaces** — The proximity half is no longer vacuous: the new surface removes blocked people before they are candidates and refuses the whole answer when block state cannot be established (`services/telegraph/reachablePeopleQuery.ts:267#if (blockedSet === null)`). The row's other divergence — blocking does not close an existing thread — is in `routes/messaging.ts` and untouched by this lane. |
| T219 | W | **Block cascade across … Nearby, Bump …** — Nearby now has a referent and blocks cascade to it, fail-closed. Bump and Crew suggestions still have none, and the messaging-side read this row's sibling T220 names is owned by another lane. Five of eight becomes six of eight on a dark surface, which is not enough to move a row whose subject is the cascade as a whole. |
| T383 | W | **Nearby geographical, availability temporal, reachability contextual; clients must not recompute** — Reachability now exists as a server-computed object, which it did not. The row's other half — the client recomputing thread membership from a raw table (T295) — is untouched, and no client consumes the projection yet, so "clients must not recompute" is satisfied by there being no client rather than by one having stopped. |
| T31 | W | **Privacy zones suppress discovery around home / lodging** — `lib/protectedLocations.ts` is still not consulted by anything in Telegraph. The new surface does not read it, and that is a gap this lane is naming rather than one it closed: a bucket computed from a coarse point near a protected place is still a bucket near a protected place. |
| T215 | W | **A meetup grant cannot be silently reused for general Nearby discovery** — Now genuinely load-bearing rather than vacuous, and still unmet: Nearby exists, so there is something to reuse INTO, and no share row carries a purpose (T214), so nothing binds a grant to one. The new surface does not read any grant — it reads standing consent — which sidesteps the question rather than answering it. |

### 31.4 The tests, and how each was shown red

Seven new files, 106 assertions. Nothing here was written green-first: every
gate below was mutated in place and the suite re-run, which is the only way to
tell a gate from a comment.

| # | mutation | result |
| --- | --- | --- |
| P-M1 | `assertCoarsePoint` stops checking the cell size | RED — a forged fine-celled "coarse" point is accepted |
| P-M2 | `MIN_BUCKET_EDGE_KM` 5 → 2 | RED — the narrowest edge is finer than 2× the map's own cell |
| P-M3 | the travel-band lookup becomes an object literal | RED — `constructor` and `toString` answer, exactly the inherited-key truthiness that got a real gate deleted in this repo before |
| I-M1 | an unreadable `location_preferences` no longer engages invisibility | RED ×2 — absent consent stops failing closed |
| I-M2 | invisible mode suppresses every surface | RED — the private map goes with it; half the row satisfied, a feature broken |
| I-M3 | `show_online_status` added as an invisible-mode input | RED — T22's collapse |
| R-M1 | `blockStateKnown` dropped from the refusal | RED — unknown block state publishes |
| R-M2 | `canMessage`'s `degraded` no longer refuses | RED — a relationship floor published as a fact |
| R-M3 | invisible mode stops suppressing Nearby | RED ×3 |
| R-M4 | invisible mode stops suppressing public availability | RED ×3 |
| R-M5 | the viewer's invisible mode stops withholding their own point | RED |
| R-M6 | presence consent stops gating the bucket | RED ×5 |
| R-M7 | the projection grows a `distanceKm` and the list is ordered by it | RED ×2 — the payload-key walk AND the swap test. This is the channel the lane exists for |
| Q-M1 | the candidate consent read's `error` goes unchecked | RED ×2 — `?? []` becomes "nobody is reachable" |
| Q-M2 | an unknown block set becomes an empty one | RED |
| Q-M3 | the candidate availability-window read's `null` collapses to an empty map | **GREEN at first** — see 31.5 |
| Q-M4 | the emergency stop stops being read on the serve path | RED ×2 |
| Q-M5 | a degraded relationship verdict is cleared and published | RED |
| N-M1 | the capability flag stops gating the route | RED |
| N-M2 | the success log grows a per-person debug field with coordinates | RED |
| N-M3 | a refusal is served as an empty list | RED |
| N-M4 | `quantiseNow` returns the raw clock | RED |
| D-M1 | the GET serves the stored fix precisely to whoever asks | RED — the whole of T235 |
| D-M2 | an unattributable publish no longer clears the binding | RED — phone A keeps reading phone B's fix |
| D-M3 | only the first publisher ever binds | RED — the binding stops following the publisher |
| D-M4 | the device lookup drops its `user_id` filter | RED — another account's device id would do |
| D-M5 | the binding TTL is removed | RED |
| C-M1 | the client stops clamping an approximate point's freshness | RED — a 2 km cell rendered as live |
| C-M2 | the account change keeps the previous account's coords and place | RED ×2 |
| C-M3 | an unknown `coordsPrecision` value is trusted | RED |

### 31.5 The mutation that did not land, and what it was hiding

Q-M3 knocked out the candidate window read's `null` check and **nothing went
red**. The conclusion available at that moment — "the check is redundant,
delete it" — is exactly the reasoning that removed a real gate in this repo
before, and it was wrong here for a reason that only shows up when you ask
whether the inputs covered the reachable space.

They did not. `availability_windows` is read TWICE — once for the candidates,
once for the viewer's own windows — and the test failed the whole TABLE, so the
sibling check fired and produced the same refusal stage. The gate was doing its
job; the test could not see which gate had done it.

Two tests now fail ONE read at a time, selected by the ids the query filters on
(`test/reachablePeopleFailClosed.test.ts`, "a failed CANDIDATE window read
refuses even though the viewer's own windows read fine", and its converse). With
those in place Q-M3 goes red. The check stays, and it is now covered rather than
merely present.

### 31.6 The ceiling

Stated plainly, because a reader must not have to discover it:

1. **The surface is dark.** `nearby_reachable_enabled` is seeded FALSE by
   `migrations/2998_nearby_reachable_flag.sql`, which is applied to NO database
   — so the row does not exist on any deployment. The migration exists because
   `check-flag-polarity.mjs` refuses a flag read by code and created by no
   migration, and because an explicit FALSE is a decision on the record where an
   absent row is the absence of one. Every row above is W for this reason before
   any other.
2. **The precise-location binding is not durable.** It lives in the API
   process with a 60-minute TTL. After a restart, or on a second instance, every
   precise share degrades to approximate until the owning device publishes
   again. That is the safe direction and it is a real limitation. A durable
   binding needs one `device_id` column on `user_location_state`, and this lane
   did not add it: a rule that lives behind an unapplied migration enforces
   nothing, and the enforcement above runs today. (2998 adds no column — it
   seeds one feature-flag row, for the reason in item 1.)
3. **Only `/me/location-state` is device-bound.** `trip_crew_location_sessions`
   and the Safe Return live share are still keyed by account, so T235 is closed
   on the self-read path and open on the two sharing paths.
4. **`safety` is a constant.** The projection's safety term is always `clear`;
   `nearbyRank` weights it and no producer sets it. The factor is modelled, not
   sourced.
5. **The candidate set is 24 graph members.** One `canMessage` round per
   candidate is the cost of not building a fifth relationship resolver. A batch
   resolver is the obvious follow-up and was not built here.
6. **Nothing consults `lib/protectedLocations.ts`.** A bucket computed near a
   protected place is still a bucket near a protected place (T31).
7. **No client consumes any of it.** The client changes in this lane are the
   device-id header, the precision discriminator and account isolation — the
   Nearby surface itself has no screen.

### 31.7 What this lane deliberately did not do

`routes/messaging.ts` was not touched: it belongs to the history-privacy lane
and nothing here required a change in it. `OpenToPlansService.listWindows` still
returns `[]` on a failed read — a silent-zero path this section records rather
than repairs, because five call sites depend on its return type and an honest
sibling (`listWindowsForOwners`) was the smaller change. The `location_sessions`
/ `trip_crew_location_sessions` device columns were not added, for the reason in
31.6.2. No verdict was moved for a row this lane did not build against.

### 31.9 A live defect this lane found on the way past, and closed

`lib/mapTravelers.ts#effectiveDiscoveryVisibility` is the opt-in gate for the
Discovery live traveler map — a route that is mounted, authenticated and NOT
behind a flag (`routes/index.ts:213#router.use(mapTravelersRouter)`). Reading it
to build the bucket ladder on top of it turned up this:

**The column carries two vocabularies and the gate only knew one.** The module
speaks `no_location | city_only | neighborhood | venue_tagged`, mirroring
`services/location/LocationPermissionService.ts:49#off:                  "no_location",`. The LIVE table
constrains the same column to `everyone | circle | trip_members | nobody`
(`location_preferences_discovery_visibility_check` in
`artifacts/api-server/baseline/20260819_baseline_structure.sql`). The gate hid a person only
when the value was exactly `no_location` — **a value that CHECK does not
admit** — so on a real database the column could not hide anyone:

* `nobody`, a person who asked to be discoverable by NO ONE, fell through as an
  unrecognised string and was published at the ~2.2 km area grid;
* `circle` and `trip_members`, audience restrictions the traveler map has no way
  to honour because it takes a viewport rather than an audience, were likewise
  published to every viewer.

Read as a denylist of one value the defect is invisible. The gate is now an
ALLOWLIST — `lib/mapTravelers.ts:142#const PUBLISHABLE_DISCOVERY_VIS` — so a
value nobody has taught the module about costs a person a pin on a map instead
of costing them the setting they chose. `everyone`, the live default and a real
unrestricted grant, still publishes.

Four assertions in `test/mapTravelers.test.ts` pin it, and both mutations land:
restoring the denylist reading reddens three, and turning the Set into an
object literal reddens the inherited-key one.

**NO CENSUS-MAP VERDICT IS MOVED HERE.** This is census-telegraph, the defect is
on a Map surface, and moving a row in another census on the strength of a fix
made while passing is exactly the kind of cross-grading that produces a verdict
nobody measured. The Map lane should read this section and decide; the
acknowledgement ledger names the two files so it will be asked to.


### 31.8 The headline, restated from the rows

Seven rows moved `N → W` and nothing else changed, so the previous headline
(§28.7's C 231 / W 159 / N 58 / X 3) no longer describes the table under it.
Restated by COUNTING THE ROWS, not by adding seven to the old numbers — a
headline arrived at by arithmetic on the previous headline carries the previous
headline's error forward while looking freshly measured:

| bucket | count |
| --- | --- |
| BUILT-AND-CORRECT | **231** |
| BUILT-BUT-WRONG | **166** |
| NOT-BUILT | **51** |
| CANNOT-VERIFY | **3** |

451 rows. CONSTRUCTED (C + W) is 397 of 451 = 88.0 %; CORRECT is 231 of 451 =
51.2 %. **Neither percentage moved because anything became correct.** Seven
absences became partial implementations behind a flag that is off on every
deployment, which is what `W` means and why none of the seven is `C`. §1's
reading rule applies unchanged: this document is append-only and last-statement-
wins, and a `W` here is a claim about construction, never about liveness.
## §32 — The two "dead" report tables, reconciled: unified storage already satisfies the requirement

**LEAD RECONCILIATION, 2026-09-22.** §1's third headline finding says
`message_reports` and `thread_reports` are dead tables with no writer and no
reader, and that "two of production's seven Telegraph tables are orphans". Every
fact in that finding is correct. **Its implication is not**, and the difference
decides whether anybody should build anything.

### 32.1 What was measured

**Code, on `main` at `857ad9fb9`.** Both Telegraph report handlers write to the
**unified `reports` table** — `routes/messaging.ts:3867` (threads) and `:4116`
(messages). Neither legacy table has a writer.

**And the unified table is READ, extensively** — which is what separates this
from §1's second finding about `saved_messages`:

| reader | what it does |
|---|---|
| `routes/admin.ts` (10+ sites incl. `:1284`, `:1391`, `:2186`, `:2308`) | the moderation surface — lists, reviews and updates reports |
| `domain/telegraph/policies/sendRateLimit.ts:191` | **reports feed a send rate limit** — a report has a behavioural consequence, not just a row |
| `scripts/verifyModerationFkE2E.ts:144,257` | an end-to-end verifier that writes, reads back and cleans up |

**Schema, read from production.** The unified table is **strictly richer** than
two purpose-built tables would be: `target_type` + `target_id` make it
polymorphic, `context_type` + `context_id` let a message report carry the thread
it came from, and `reason_code` / `severity` / `status` / `moderation_notes` /
`reviewed_by` / `reviewed_at` give it a moderation lifecycle that each legacy
table would otherwise need duplicated.

### 32.2 The ruling

**THE REQUIREMENT IS SATISFIED BY THE UNIFIED STORAGE.** Nothing is missing, and
**no new reporting system may be built for Telegraph.** A second path would be
the duplication this document spends §23 warning against, and it would split the
moderation queue in two — the admin surface reads one table.

**THE TWO LEGACY TABLES ARE SUPERSEDED, AND THEY STAY.** Measured in production
on 2026-09-22: `message_reports` **0 rows**, `thread_reports` **0 rows**. So
nothing is at risk either way — and that is *not* the argument for keeping them.
The argument is that **"current code does not reference it" is not a reason to
drop a table.** A drop is irreversible, it buys no capacity at zero rows, and
this repository's own history is the case for caution: migration 2298 is the
precedent for a ledger row whose effects were absent, and 2890/2900/2958 for
objects live with no ledger row. A tree that has twice been wrong about what the
database contains should not be dropping tables to tidy a census finding.
They are **retained, unreferenced, and recorded as superseded**.

### 32.3 One thing this reconciliation found and did NOT resolve

**`public.reports` itself holds ZERO rows in production.** Given the readers
above, that most plausibly means nothing has been reported yet, which is
unremarkable for an app in this state. But it is **not proof** of that: an
identical zero would be produced by a write path that fails. The two are not
distinguishable from this environment, because distinguishing them needs either
production logs or a report submitted through the deployed app.

**Recorded as unresolved rather than assumed benign.** This is the same
distinction §32 of `census-input-intelligence.md` draws for migration 2950,
which is applied and whose table is also empty: *reachable is not answered*. No
verdict moves on this section — the §22 rows keep their current verdicts, and
whoever owns them next should settle this with a submitted report rather than an
inference.

## §33 — TELEGRAPH LANE 4: the coordination session's LIFECYCLE, and the four §13.2 events nothing was firing

Written 2026-09-22 in worktree `.claude/worktrees/agent-a42971a7bc32f7302`, on
branch `claude/portava-continuation-uqta94` from `e43fc628a`. **Nothing here is
deployed and no flag was enabled. This lane wrote NO migration** — see §33.7 for
the one it considered and declined, and why.

The rows this lane was sent at are the ones §21 left behind when the
CoordinationSession became an object: the object existed, and nothing about its
LIFE did. There was no command to create one, no event when one started or
ended, and the two expiry events §13.2 names were still what T188 called them —
"evaluated lazily on read … and emits nothing".

### 33.1 What was re-derived before anything was written

Four rows were re-executed against the tree rather than taken from the census.

| Row | The census's reason | What the tree said on 2026-09-22 |
|---|---|---|
| T150 | "No table, service or route." | **One third true.** `services/telegraph/coordination.ts` is the service and `routes/telegraphCoordination.ts` is the route, both since §21. What was genuinely missing was the shape of T84's complaint: an object projectable per thread but not LISTABLE. |
| T168 | "Nothing (T85)." | **True, and its own refusal was lying.** `domain/telegraph/commands/telegraphCommands.ts` listed it in `UNIMPLEMENTED_COMMANDS` annotated "no coordination session ENTITY exists", which stopped being true in §21. The endpoint answered 501 "nothing in this repository implements it" for a thing that existed — the same wrong-direction refusal this file had already corrected once, for `SET_COORDINATION_STATUS`. |
| T188 | "expiry is evaluated lazily on read (`2260:38-42`) and emits nothing" | **True, and the citation understates the scope.** Lazy-on-read is not only `availability_windows`: every reader of `quick_availability_status` does it too, and that table is NOT behind `open_to_plans_windows_enabled` and IS one of production's tables. So the live availability substrate had the same defect as the flag-gated one, on every deployment. |
| T196 | "Idempotent: no. Without an outbox, event ids or dedup keys, a retried consumer double-applies." | **True.** No event on the bus carried anything a consumer could dedupe on. |

### 33.2 Retries: the command is idempotent, and it is enforced TWICE

§17.2 asks that "offline resend must be idempotent", and a coordination session
is exactly the object a person creates by tapping a button on a phone with one
bar of signal. `createCoordinationSession`
(`services/telegraph/coordinationSessions.ts:151#export async function createCoordinationSession`)
REQUIRES an idempotency key — the trip kernel's rule, verbatim and for the same
reason: "a generated one would make every retry a new command".

The write-side check reads this conversation's own sessions for a row carrying
the same `(sender, key)` and returns the existing session with `duplicate: true`
and a 200. That closes every SEQUENTIAL retry.

It cannot close two genuinely concurrent ones: both read, neither sees the
other, both insert. There is no constraint to lean on — a session is a
`messages` row, `messages` has no unique index on an envelope field, and adding
one needs a migration no database has. So the READ collapses them as well
(`services/telegraph/coordination.ts:857#export function projectConversationSessions`):
the earlier row is the session, the later one is inert and named in
`duplicateSessionIds` rather than deleted, because it is a message somebody's
client sent. **The pair is what makes the command idempotent in observable
behaviour rather than only in the happy case.**

Transitions carry the same key and are deduped in the fold
(`services/telegraph/coordination.ts:791#const seenKeys = new Set<string>();`),
so one tap on "we're off" cannot become PREPARING → ASSEMBLING → ACTIVE. The
route answers a repeat 200 `duplicate` **before** the legality gate, and the
order is the whole point: checked after it, a retried COMPLETE would be refused
as "this session is COMPLETE, §9 allows nothing" — telling a client its own
successful command had failed, which is the worst of the three available
answers.

### 33.3 Expiry: a mechanism, not a column

`server/telegraph/lifecycleScheduler.ts:172#export function startTelegraphLifecycleScheduler`,
started at boot (`index.ts:162#  startTelegraphLifecycleScheduler();`), runs
every five minutes and is shaped after the trip crew live-share scheduler,
including the three defects that file records having been rewritten to fix: a
failed sweep that looks idle, `setInterval` with no overlap guard, and no
idempotent start or stop.

**Availability is exactly-once, by conditional write.**
`services/telegraph/lifecycleSweep.ts:96#export async function sweepExpiredAvailability`
DELETEs the expired `quick_availability_status` rows and emits one
`availability.expired` per row the delete returned. Of two instances sweeping
the same row exactly one delete matches it, and because the row is GONE a
restart cannot replay it.

It is TWO statements and the second is still the conditional write, because
PostgREST refuses a limited DELETE that carries no `order` — so a one-statement
version either drops its bound or fails every tick, and the bound is what stops
the first tick after an outage from being unbounded. A capped SELECT names the
candidates and the DELETE names BOTH the ids and the expiry predicate. Keeping
`lte("expires_at", …)` on the delete is the whole point: a signal the owner
re-armed between the two statements no longer matches, so a clock reading from
before they pressed it cannot revoke what they just set. Dropping it turns the
sweep into "delete the rows I saw a moment ago", and the test for that race
fails 25/3 when it is dropped. The delete is safe precisely because every reader
already refuses to render these rows past `expires_at` —
`routes/availability.ts:87#  const quickStatus = qs && (qs as any).expires_at > new Date().toISOString()`,
`routes/availability.ts:152#  if (!data || (data as any).expires_at <= new Date().toISOString()) {`,
`routes/availability.ts:250#    if ((r as any).expires_at > now) qsMap[(r as any).user_id] = r;`,
`services/passport/PassportProjectionService.ts:883#      .from("quick_availability_status")` and
`services/passport/SharedContextService.ts:104#      .from("quick_availability_status")` —
so it removes data nothing was allowed to show, which is a privacy improvement
rather than a behaviour change.
**The delete is qualified** (`.lte("expires_at", …)`): this database's supautils
safeupdate guard rejects an unqualified one in a PostgREST-role session, and a
sweep that could ever be unqualified is a sweep that could delete everybody's
availability.

**Location is at-least-once, bounded by ONE INTERVAL, and says so.** A scoped
in-thread share is a `messages` row with no mutable per-share state this lane
owns, so there is nothing to flip. The tick emits over a half-open window
(`services/telegraph/lifecycleSweep.ts:176#export function sharesExpiringIn`) —
inclusive at `since` would re-emit the boundary share forever, exclusive at
`now` would drop the one that expires exactly on it — and a cold start resumes
from `now - interval` rather than the epoch, so a deploy replays at most one
window instead of a day. Claiming exactly-once over a bus whose own header says
publishes are "logged and swallowed" would be a claim the transport cannot make;
what is claimed instead is a stable `eventKey` on every payload
(`lib/telegraphEvents.ts:782#export function lifecycleEventKey`), which is what
§13.3's "consume … idempotently" needs a consumer to have.

**The sweep's query is index-backed, and the narrowing is derived rather than
written out.** `messages` has no index on `msg_type` and none on `created_at`
alone, so the obvious "all LOCATION rows in the last eight hours" is a
sequential scan of the hottest table in the product every five minutes. It DOES
have `idx_messages_subtype`, and a LOCATION message's subtype is its precision,
so the read narrows on the precision ladder first — measured against
`portava-ci` as `Bitmap Index Scan on idx_messages_subtype`, cost 4.45, where
the unnarrowed form is a seq scan. The `msg_type` equality stays and is not
redundant: it is what stops a future kind that happens to use one of those
subtype words from being swept as a location share. The list comes from
`LOCATION_PRECISIONS` (`services/telegraph/messageKinds.ts:96#export const LOCATION_PRECISIONS`)
rather than being written twice, because a second copy would drift and the drift
would be SILENT — a new precision would produce shares the sweep never looked
at, and the only symptom would be a live chip nothing takes down. A test asserts
the sweep's filter IS the payload's own enum.

**The watermark advances only on a clean tick**
(`server/telegraph/lifecycleScheduler.ts:142#  if (ok) _locationWatermark = now;`).
Advancing it after a failed read would lose every share that expired inside the
broken window, silently and permanently, which is worse than emitting one window
twice.

### 33.4 Cancellation, and membership changes mid-session — the spec's answer

**Cancellation** is §9's own arrow and was already reachable; what was missing
was that anybody else learned about it. `coordination.completed` now fires on
BOTH terminal states with `terminalState` naming which
(`lib/telegraphEvents.ts:912#export async function emitCoordinationCompleted`).
§9's diagram has two terminal states and §13.2 names one event: firing only on
COMPLETE leaves a cancelled panel open on every other client until the next
poll, and collapsing the two into one "ended" claim would tell people an evening
happened that did not — and §10.3's recap is downstream of exactly that
distinction.

**Membership changes** have no §9 rule, and this lane did not invent one. The
spec's answer is §14.2 — *"Authorization must be checked both when sending and
when READING because membership … can change after a message was created"* — and
§30A.11's *"current source-domain capability is rechecked at execution time so …
removed memberships fail safely"*. So:

* A member who has LEFT stops being part of the live participant view: their
  declared quick state is dropped and the arrival counts do not include them
  (`services/telegraph/coordination.ts:1083#export function latestQuickStates`).
  Before this they still counted as ARRIVED forever, and the announcements route
  two hundred lines away was already reading the roster to avoid exactly that.
* The session they STARTED survives. Nothing in §9 ends a session on a
  membership change, and inventing that rule would let one person walking out
  cancel an evening for everybody else. Their transitions stay in the record,
  because they are declarations about the SESSION rather than about themselves,
  and because this module's rule throughout is that the record of the evening
  may not disagree with the evening.
* They may not post a new one: the write gates already refuse a departed member.
* **An unreadable roster reports `rosterKnown: false` and filters NOTHING**
  (`routes/telegraphCoordination.ts:707#    const activeMemberIds = rosterErr`).
  Both wrong answers were available and both are worse: treating the failure as
  "nobody is active" empties the arrival counts on a database blip, and
  presenting the unfiltered list as verified is a claim nothing checked.

### 33.5 Version conflict, and its path is proved

`COORDINATION_TRANSITION` takes an optional `expectedVersion` — the number of
APPLIED arrows the client believes the session has, counted from applied arrows
and not from rows, so a REFUSED arrow does not make a client stale. A stale one
answers 409 `TELEGRAPH_COORDINATION_VERSION_CONFLICT` naming both numbers and
the current state (`routes/telegraphCoordination.ts:490#TELEGRAPH_COORDINATION_VERSION_CONFLICT`).
Absent means "I did not look", which stays legal: this is a capability a careful
client opts into, not a new requirement on every caller. The conflict path, the
matching path and the absent path are each a test, and deleting the check fails
the first of them.

### 33.6 Ten rows move

| id | Was | Now | Evidence |
|---|---|---|---|
| T168 | N | **C** | **§13.1 `CREATE_COORDINATION_SESSION`.** One command, TWO doors, ONE writer: `POST /api/threads/:id/coordination` with kind `COORDINATION_SESSION` and `POST /api/telegraph/commands` with type `CREATE_COORDINATION_SESSION` (`server/telegraph/commandRoute.ts:169#    if (type === "CREATE_COORDINATION_SESSION") {`) both call `createCoordinationSession` (`services/telegraph/coordinationSessions.ts:151#export async function createCoordinationSession`). Two handlers would have drifted on the idempotency rule, which is the one thing here that is easy to get slightly different and impossible to notice. It is the ONE §13.1 command on that bus that needs no unapplied schema, so the kernel gate is now per-command rather than per-endpoint (`domain/telegraph/commands/telegraphCommands.ts:107#export const SCHEMA_GATED_COMMANDS`) — gating it behind `telegraph_message_kernel_enabled`, seeded FALSE on every deployment, would have made a live capability unreachable. `UNIMPLEMENTED_COMMANDS` is now empty and the 501 branch is kept for the next §13.1 command that arrives unbuilt. |
| T187 | N | **C** | **§13.2 `availability.started`.** In the union and published by `PATCH /api/me/quick-availability` (`routes/availability.ts:200#  emitAvailabilityStarted(user.id, {`) through a dedicated emitter (`lib/telegraphEvents.ts:798#export function emitAvailabilityStarted`) whose signature has no parameter that could carry a thread id or a second recipient. **Owner-only, and that is the design**: who else may see a person's availability is §4's question, answered by the gates those routes already run, and a realtime bus must not route around them. The owner's other devices are the audience that needs it — §4.3's revocation begins when the signal starts, and a device that missed the start expires nothing. The same rule `emitDeliveryReceipt` applies to `message.delivered`, for the same reason. |
| T188 | N | **C** | **§13.2 `availability.expired`.** Fired by a real mechanism, not implied by a timestamp: `services/telegraph/lifecycleSweep.ts:96#export async function sweepExpiredAvailability` DELETEs the rows whose window closed and emits one event per row the delete RETURNED, which makes it exactly-once across instances and unreplayable across restarts. The row was already invisible to every reader past `expires_at`, so the delete removes data nothing was allowed to show. `expiredAt` is the signal's OWN expiry and `sweptAt` is the clock, so a late sweep is visible as lag rather than reported as a longer disclosure than happened. Lazy-on-read is UNCHANGED and is the other half: the sweep makes the event fire, the read keeps the answer right. |
| T189 | N | **C** | **§13.2 `location.started`.** §12 asks `location_shares` to be "purpose/audience/precision/expiry scoped"; precision was already on §6.2's LOCATION payload and the audience is the conversation, so this adds the other two and the event that starts the clock (`routes/telegraphKinds.ts:303#      void emitLocationStarted(client, threadId, {`). An `expiresAt` is what makes a share a SHARE rather than a pin — a pin has no lifecycle and emits nothing — and the route refuses one already in the past (it could never be taken down) or beyond `MAX_LOCATION_SHARE_HOURS` (`services/telegraph/messageKinds.ts:141#export const MAX_LOCATION_SHARE_HOURS`), which is §15.1's bound rather than an unbounded capability wearing a timestamp. `purpose` names an id the canonical registry publishes (`services/telegraph/messageKinds.ts:85#export const TELEGRAPH_SHARE_PURPOSES`), asserted against `lib/locationPurposes.ts` by a test, because a purpose field validated against nothing is how a purpose field stops meaning anything. The event carries NO coordinate. |
| T190 | N | **C** | **§13.2 `location.expired`.** `services/telegraph/lifecycleSweep.ts:197#export async function sweepExpiredLocationShares`, on the same five-minute tick, over the half-open window §33.3 describes. Published to the whole conversation and the owner is NOT excluded — nobody performed this event, a clock did, and the sharer's own screen is the one most likely still showing it live. At-least-once bounded by one interval, stated rather than glossed, with a stable `eventKey` so a consumer can be idempotent (`lib/telegraphEvents.ts:875#export async function emitLocationExpired`). |
| T191 | N | **C** | **§13.2 `coordination.started`.** Published when a session opens and NOT when a retry resolves to one (`lib/telegraphEvents.ts:888#export async function emitCoordinationStarted`) — a duplicate command is not a second evening. To the conversation, opener included: a session event that excluded the actor would leave the one device certainly showing the panel without the fact that opened it. |
| T192 | N | **C** | **§13.2 `coordination.completed`.** Emitted from the ARROW the gate just accepted rather than from a re-read, so a REFUSED transition cannot fire it, and on BOTH of §9's terminal states with `terminalState` naming which (`lib/telegraphEvents.ts:912#export async function emitCoordinationCompleted`). See §33.4 for why one event covering two terminal states is the right reading of §13.2 and why collapsing them would not be. |
| T150 | N | **W** | **`coordination_sessions`.** The evidence was "No table, service or route"; two thirds of that was stale by §21 and the third is answered the way T84's was — "a query is a route, not a table". `GET /api/me/coordination-sessions` (`routes/telegraphCoordination.ts:1333#  "/me/coordination-sessions",`) lists the caller's open sessions ACROSS every conversation they are still an active member of, each thread's rows bounded by that thread's own §14.3 window, from the SAME projection the thread view uses. Fourteen days rather than commitments' ninety, because §12 calls a session "TEMPORARY active real-world coordination state" and a session from three months ago is history. The per-thread read is no longer bounded by the general message scan either (`routes/telegraphCoordination.ts:192#async function readSessionRowsForThread`) — it was, and in a busy crew thread the coordination panel VANISHED mid-evening and came back when the chat went quiet. **It stays W because there is still no row per session**: nothing can be indexed, nothing a sweeper can advance, and no question can be asked that is not "scan the caller's own threads". §33.7 states why this lane did not write that table. |
| T266 | N | **W** | **§20 Discovery — Discover Together.** `GET /api/threads/:id/discover-together` (`routes/telegraphSharedContext.ts:405#  "/threads/:threadId/discover-together",`) intersects the three inputs the row names and reports, per item, which of the three admitted it. AVAILABILITY invents no entitlement: it is read only on a TRIP thread and only after re-verifying ACCEPTED trip membership for the viewer AND for each other member — the gate `GET /api/trips/:id/availability` already runs for the same data, doubled for T262's reason, because the thread roster and the trip roster are not one transaction (T319). On a direct or circle thread the input is absent and the response names the reason rather than rendering "nobody is free". §4.3's expiry is re-evaluated on this read as well as being swept. TIME is an explicit number of hours with `frame: "UTC"` stated, never an implied destination-local "tonight" (T423). **It stays W for the half the row's title names**: the opportunity set is drawn from the conversation's own §3 shared context and NOT from Discovery's candidate corpus — ranking and proximity belong to another surface and this route does not reach into them. A reader who requires the Discovery corpus should read this row as unbuilt rather than partial. |
| T155 | N | **N** | **`conversation_snapshots` — evidence correction, verdict unchanged.** "Absent" is still true and this lane deliberately did not close it; see §33.7. Recorded here because the row was opened, priced and declined rather than overlooked. |

**What would turn these red.** T168: a retry that mints a second session (the
write check), two concurrent retries that both survive the read (the collapse),
or the command falling back under the kernel flag, which would make it
unreachable on every deployment. T187/T188: an availability event reaching
anybody but the owner; an unqualified delete; a sweep that reports `expired: 0`
for a table it could not read; `expiredAt` stamped with the sweep's clock.
T189/T190: `location.started` emitted for a pin with no expiry; an expiry
accepted in the past or beyond the ceiling; the half-open window made inclusive
at `since`; the watermark advanced after a failed tick; a coordinate on either
payload. T191/T192: `coordination.started` on a duplicate; `coordination.
completed` only on COMPLETE, or emitted for a transition the gate refused.
T150: a session that a busy thread hides; the cross-thread list including a
conversation the caller has left; an unreadable membership list answering "you
are coordinating nothing". T266: availability read on a thread nothing entitles;
the per-member crew re-verification dropped; an expired row counted as somebody
free; an unreadable table rendered as an empty set. Every one of these was run
as a mutation — §33.9 — and two of them did not land on first measurement.

### 33.7 `conversation_snapshots` was priced and DECLINED, and the reason is not effort

The reserved migration band `2963`–`2969` was available and `2966` is free. A
`conversation_snapshots` table modelled on `trip_snapshots` +
`trip_snapshot_verify_replay` is a day's work and would have moved T155 N → W.
It was not written, for three reasons stated in the order they decided it.

1. **§12's own wording is "rebuild/replay checkpoints WHERE USEFUL"**, and the
   thing that would have made one useful here was a bound, not a cost. The
   projections this lane owns are pure folds over `messages`; what was actually
   breaking was that the per-thread session read was filtered out of a general
   400-row scan. That is fixed directly, by reading the session's own kinds
   (§33.6, T150), and a checkpoint would have papered over it at the price of a
   second store.
2. **It would be a durable second copy of message-derived content that the
   account-deletion path does not know about.** `lib/deletionDispositions.ts`
   and `src/scripts/rlsDispositions.ts` are generated from a captured BASELINE,
   so a table created by a new migration is in neither until the baseline is
   recaptured — which is why 2964's `map_telemetry_disabled_discards` is in
   neither today. Shipping a snapshot store holding session titles and
   transition reasons, with no entry in the deletion cascade, is a retention
   hole created by this lane. The rule this lane was given is never to weaken a
   privacy check, and creating a copy the deletion path cannot see is weakening
   one.
3. **It would be capped at W by the migration anyway.** §12.12's first ceiling —
   "a migration no database has" — applies exactly as T85's own row once argued.

**What would change the answer:** a thread long enough that even the
kind-scoped read is truncated (`sessionScanTruncated` in the coordination
response is the number to watch), or a consumer that needs to rebuild a
conversation's state at a past cursor rather than now. Neither exists today.

### 33.8 The §9 W rows, enumerated, and which were taken

§9 has three W rows left at HEAD — **T104, T106, T107** — after §10.14 moved
T105, T109, T111, T112, T113 and T114 to C. **None of them moved here**, and
each has a reason that is not this lane's to remove:

| id | Why not |
|---|---|
| T104 | *Preparing UI: plan card, attendance, leave-by, route, availability conflicts.* Three of five. §21.5b already priced the fourth: in-thread availability-conflict detection is buildable and INERT, because `open_to_plans_windows_enabled` is seeded OFF and on no database. That reason is now half stale — §33.3's substrate, `quick_availability_status`, is NOT flag-gated and IS in production, so a conflict detector over it would be exercisable. It was still not built: this lane holds no client file, and the remaining fifth item (route) belongs to the Map programme. **The blocker is now the drawing, not the data.** |
| T106 | *Active UI: minimal conversation, next step, crew state, optional location scope.* The location-scope half moved: a scoped in-thread share with a purpose, a precision and an expiry is now expressible and observable (T189/T190), which is the first time "optional location scope" has had a referent inside a conversation rather than on a separate screen. Crew state is the declared-status list and is now correctly bounded to CURRENT members (§33.4). "Minimal conversation" is expressible through §21.2's layers. **There is still no next-step surface, and nothing DRAWS any of it** — the same reason T11, T12 and T218 stay W, and this lane holds no client file. |
| T107 | *Returning UI: heading back, Safe Return, shared transport, return checkpoint.* Unchanged. Heading-back is a declared state and the return checkpoint is a RENDEZVOUS; Safe Return is still its own subsystem rather than a conversation state, and shared transport does not exist. Nothing this lane built touches either half. |

### 33.9 Every mutation, and the four measurements that were not what they looked like

Thirty-four mutations were run across three suites. **Thirty-three land. One
does not, and that one was re-derived rather than written off as redundant.**
Three of the thirty-three did not land on FIRST measurement, and in each case
the TEST was wrong rather than the code — which is the whole reason for running
them, and the ratio is the argument.

| mutation | first measurement | what it found | after |
|---|---|---|---|
| the VIEWER-side crew gate removed (Discover Together) | GREEN | every fixture had the viewer as accepted crew, and the only non-trip case short-circuits earlier — the gate on somebody else's availability was UNTESTED | a case was added: a viewer on the thread roster who has left the trip. 10/1 |
| the DELETE's own `error` check deleted (availability sweep) | GREEN | the fake injected on the TABLE, so the candidate SELECT failed first and the sweep returned on that — the second check was never reached | a case that fails ONLY the delete. The two checks are now separately pinned, 28/1 each |
| the DELETE's expiry predicate dropped (availability sweep) | 25/2 | it landed on the two shape tests but NOT on the race it exists for: the fake re-armed the row BEFORE the SELECT read it, so the row never entered the candidate list and the test passed for the wrong reason | the re-arm moved to after the read. 25/3 |
| the `ctx.tripId &&` term removed (Discover Together) | GREEN | **nothing. It is genuinely behaviour- and read-equivalent** — `isAcceptedTripMember` cannot pass with a null trip id, because `requireTripMember` falls through to a `trips` lookup on a null id and finds nothing. A saved pair of reads on every DM, not a gate | the test says that in place of a claim it cannot support. Still green, and recorded as green |

**Coordination lifecycle** — `telegraphCoordinationLifecycle.test.ts` with
`telegraphCoordination.test.ts` and `telegraphCommandRoute.test.ts`:

| mutation | result |
| --- | --- |
| the write-side idempotency lookup never matches | pass 160 / fail 3 |
| the read-side collapse removed | pass 161 / fail 2 |
| `coordination.completed` fires only on COMPLETE | pass 162 / fail 1 |
| `expectedVersion` ignored | pass 162 / fail 1 |
| `latestQuickStates` not filtered by the active roster | pass 161 / fail 2 |
| an unreadable roster treated as "nobody is active" | pass 162 / fail 1 |
| the retry check moved AFTER the legality gate | pass 161 / fail 2 |
| a retried transition applied twice in the fold | pass 162 / fail 1 |
| `CREATE_COORDINATION_SESSION` put back under the kernel flag | pass 162 / fail 1 |
| `coordination.started` emitted on a duplicate | pass 162 / fail 1 |

**Lifecycle events** — `telegraphLifecycleEvents.test.ts`:

| mutation | result |
| --- | --- |
| the DELETE's own `error` left unchecked | pass 28 / fail 1 |
| the candidate SELECT's `error` left unchecked | pass 28 / fail 1 |
| the availability DELETE left unqualified | pass 24 / fail 4 |
| the DELETE's expiry predicate dropped, keeping only the ids | pass 25 / fail 3 |
| `expiredAt` stamped with the sweep's clock | pass 28 / fail 1 |
| `availability.started` published beyond the owner | pass 28 / fail 1 |
| a pin with no expiry emitting `location.started` | pass 28 / fail 1 |
| the expiry window made inclusive at `since` | pass 28 / fail 1 |
| the watermark advanced after a FAILED tick | pass 28 / fail 1 |
| a cold start resuming from the epoch | pass 28 / fail 1 |
| `lastSuccessAt` moved on a failed tick | pass 28 / fail 1 |
| an expiry already in the past accepted | pass 28 / fail 1 |
| the four-hour share ceiling removed | pass 28 / fail 1 |
| `purpose` as a free string instead of a registry id | pass 28 / fail 1 |
| `location.expired` excluding the owner | pass 27 / fail 2 |
| the sweep's subtype narrowing hardcoded instead of derived from the ladder | pass 28 / fail 1 |

**Discover Together** — `telegraphDiscoverTogether.test.ts`:

| mutation | result |
| --- | --- |
| the per-member crew re-verification dropped | pass 9 / fail 1 |
| `expires_at` not re-evaluated on the read | pass 9 / fail 1 |
| `busy` counted as availability | pass 9 / fail 1 |
| an unreadable availability table folded into an empty set | pass 9 / fail 1 |
| a crew-read throw reported as entitled | pass 9 / fail 1 |
| the time window ignored | pass 9 / fail 1 |
| the VIEWER-side crew gate removed | pass 10 / fail 1 (after the case above was added; GREEN before it) |
| the `ctx.tripId &&` term removed | pass 11 / fail 0 — GREEN, and it stays green; see the table at the top of §33.9 |

### 33.10 Tests, shown red first

`src/test/telegraphCoordinationLifecycle.test.ts` (37),
`src/test/telegraphLifecycleEvents.test.ts` (29) and
`src/test/telegraphDiscoverTogether.test.ts` (11) are new and registered in the
`test` script. The first was run at HEAD before any implementation existed and
**did not load at all** — the module it exercises was not there — which is red
but weak, and is why §33.9's mutation pass is the evidence that each individual
assertion can fail rather than this sentence.

`telegraphCoordination.test.ts` 105/105, `telegraphCommandRoute.test.ts` 29/29,
`telegraphSharedContext.test.ts` 40/40, `availability.test.ts`,
`telegraphKinds.test.ts` and `passportSharedContext.test.ts` 79/79 combined —
all unchanged by this lane except one deliberate edit, below.

**One invariant the full suite caught and this lane had broken.**
`splitClockGuard.test.ts` refuses a function that calls both `Date.now()` and a
no-arg `new Date()`, and the typed-message route did after the location-share
validation landed: two independent clock reads mean the expiry this route
VALIDATED and the `created_at` it STORED can straddle a tick, so a share could
be accepted against one instant and recorded against another. One read is now
taken at the top of the handler and everything derives from it. 24076/24076.

**One existing test was rewritten and the rewrite is a strengthening.**
`telegraphCommandRoute.test.ts` asserted that `CREATE_COORDINATION_SESSION`
answers 501 "nothing in this repository implements it". It now asserts the
command is ISSUABLE and still refuses a call with no idempotency key, plus a new
assertion that `UNIMPLEMENTED_COMMANDS` is empty — so the §13.1 partition stays
exhaustive and a command cannot quietly fall through to "unknown".

### 33.11 Checks

`npx tsc -p tsconfig.json --noEmit` clean. `check-test-typecheck` **863
diagnostics across 115 files against a baseline of 863 across 115 — this lane
added none.**

`check:telegraph-share-producers` passes, and **§21.9's cross-lane request is
discharged in the same edit**: the coordination route's `produces` list had gone
three values short when `ACTION_RESPONSE`, `COORDINATION_SESSION` and
`COORDINATION_TRANSITION` landed, the checker does not verify that list is
exhaustive, and the three are now declared. The new writer
(`coordinationSessions.ts`) is declared beside it.

`check:telegraph-inventory` regenerated in the same commit as the change that
moved it, as that checker asks. `check:telegraph-certification`,
`check:telegraph-package-boundaries`, `check:telegraph-slos`,
`check:census-integrity`, `check:census-row-move-labels` and
`check:doc-citations` pass.

**`check:doc-citations` — a debt this lane created and repaired.** Editing
`lib/telegraphEvents.ts`, `services/telegraph/messageKinds.ts`,
`services/telegraph/coordination.ts`, `routes/telegraphCoordination.ts`,
`routes/telegraphKinds.ts`, `routes/telegraphSharedContext.ts`,
`domain/telegraph/commands/telegraphCommands.ts` and `index.ts` shifted 44
anchored citations across five documents — including three belonging to
`census-trips`, `census-trust`, `census-sensing`,
`census-highlights-memories` and `intel-spine-liveness`. Every one was
re-anchored to its new line, mechanically where the needle was unique and by
hand where it was not, and no anchor was moved onto a different occurrence. The
one anchor whose TEXT this lane invalidated — `telegraphEvents.ts:116`, the
union's last line, which now carries six more event types — was shortened to the
part that is still verbatim rather than repointed.

**`check:census-scope-coverage` FAILS, and the remedy is three lines this lane
was not allowed to write.** The scope this census WATCHES already covers
`services/telegraph/`, `server/telegraph/`, `domain/telegraph/` and the two
routes by prefix, so every product file §31 cites is watched. The three NEW TEST
files are not, and the ratio falls from 87 % (270 cited / 235 watched) to 86 %
(273 / 235) because of exactly those three. The list lives in
`artifacts/api-server/src/scripts/checkCensusFreshness.ts`, under
`"census-telegraph.md"`, which this lane was told not to touch. The lines are:

    "artifacts/api-server/src/test/telegraphCoordinationLifecycle.test.ts",
    "artifacts/api-server/src/test/telegraphLifecycleEvents.test.ts",
    "artifacts/api-server/src/test/telegraphDiscoverTogether.test.ts",

Adding them restores the floor. **The floor must not be lowered instead** — it
is a ratchet, and lowering it to get green is the thing it exists to stop.

`check:census-freshness` will report this document STALE once this lane's work
is committed. `CENSUS_STALENESS_ACKNOWLEDGED.json` is the integration owner's
file and this lane did not touch it. §33.6 is a re-measurement of the ten rows
it names and of nothing else.

The other five `check:all` failures are environmental and pre-existing: they are
the live-DB guard refusing a target because `CI_SUPABASE_PROJECT_REF` and
`KNOWN_PROD_PROJECT_REF` are unset in this container, and they exit 2 before
touching any code this lane wrote.

### 33.12 Headline, restated from the rows

`check:census-integrity` counted this document at **C 231 / W 159 / N 58 / X 3
across 451** when this lane opened it — §27.7's figure. After §33.6 the same
tool parses every one of the 451 and counts:

| Measure | Value |
| --- | --- |
| BUILT-AND-CORRECT | **238** |
| BUILT-BUT-WRONG | **168** |
| NOT-BUILT | **42** |
| CANNOT-VERIFY | **3** |
| **CONSTRUCTED%** = (238+168)/451 | **90.0 %** |
| **CORRECT%** = 238/451 | **52.8 %** |

*Restated at the integration merge, 2026-09-22, FROM THE TOOL rather than by
addition.* This lane measured `W 161 / N 49` in its own worktree and that was
right there. It is wrong here, because §31 — the location, proximity and privacy
lane, written in parallel and merged just before this section — moves SEVEN rows
`N` → `W` (T24, T25, T26, T29, T235, T382, T400). Those seven are in the same
document now, they come EARLIER in it, and `check:census-integrity` takes the
last statement per row, so the merged document counts `W 168 / N 42`.
BUILT-AND-CORRECT is unchanged at 238: the two lanes moved disjoint rows and
neither overwrote the other. The denominator is untouched at 451.

This supersedes §27.7's `C 231 / W 159 / N 58 / X 3`, which is left in place
because this document is append-only. **The delta is exactly the ten rows in
§33.6 and nothing else**: T168, T187, T188, T189, T190, T191 and T192 N→C, T150
and T266 N→W, T155 unmoved. It is the TOOL's count and not an addition sum —
§24's own correction records what happens when a headline is arrived at by
adding a pass's moves to the previous one — and it certifies nothing about the
other 441 rows, which this lane did not re-measure. §1's much older
`209 / 176 / 51` is older still and is likewise left alone.

### 33.13 Not claimed

  - **Nothing is deployed and no flag was enabled.** No row above depends on a
    migration, and this lane wrote none.
  - **`GET /me/coordination-sessions` and `GET /threads/:id/discover-together`
    have no client.** They join the five endpoints §21.9 lists in the same
    state: reachable through `routes/index.ts`, unmounted in the app's UI. That
    is precisely what T150 and T266 stay W for.
  - **The sweep is in-process and per-instance.** Two servers run two sweeps.
    Availability is safe under that by conditional write; location is
    at-least-once and the duplicate is what `eventKey` exists for. There is no
    leader election in this tree and this lane did not add one.
  - **T196 is NOT moved.** Six events now carry a dedupe key; the other twenty
    do not, there is still no outbox, and one family of six is not the row's
    claim. The half that closed is recorded here and nowhere else.
  - **T149 is NOT moved.** The in-thread LOCATION share now carries purpose,
    precision, audience and expiry, but T149 is about `location_shares` as a
    canonical store — `trip_crew_location_sessions` — which this lane did not
    touch and does not own.
  - **`availability_windows` is untouched.** §33.3 sweeps
    `quick_availability_status`, which is live and ungated. The flag-gated
    window store still expires lazily on read and emits nothing; T148's and
    T172's ceiling is unchanged.
  - **No coordinate was added to any event payload**, and the location sweep
    parses message bodies only to reach `expiresAt`.
  - The 151 W rows this section does not name were not re-read, and §33.12's
    headline is a count of the table rather than a claim about them.
