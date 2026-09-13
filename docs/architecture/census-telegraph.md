# Portava Telegraph — Requirement Census (v1 and v1.1)

| Field | Value |
| --- | --- |
| **Specs** | `docs/specs/Portava_Telegraph_Design_Architecture_Developer_Spec_v1.txt` (30 sections) and `..._v1_1.txt` (32 headings). The `.docx` originals are authoritative and were extracted and compared; see §2. |
| **Tree censused** | `claude/portava-continuation-uqta94`, working tree at `ebe72b34`. Sibling agents committed the shared tree during this pass (HEAD is now `feedfb0a`); `git diff ebe72b34..feedfb0a` over every path cited below touches exactly one file — `routes/safeReturn.ts`, +43 lines, an unrelated Passport contact projection appended after `:817` plus two imports — so every verdict holds at HEAD, with that file's post-`:26` citations renumbered. Censused state is **main**: open PRs #460 and #472 are read but never scored into a bucket; see §9. |
| `head_commit` | `42aeac38` — DECLARED 2026-09-11. It **starts a clock; it does not certify a past.** Read the next row before quoting it. |
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
| **CORRECT% (spec-attributable)** = 0/451 | **0.0 %** |
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
   (`routes/messaging.ts:1575-1583`) filters on `thread_id` and active
   membership and **nothing else** — there is no `joined_at` bound, no
   `visible_from_sequence`, no history window of any kind. `syncTripChatMembers`
   (`services/groupChatSync.ts:9-13`) adds every newly-accepted trip member to
   the trip thread, and that member can immediately page back through every
   message sent before they joined. §14.3 and §29 both forbid exactly this.
   This is a live privacy divergence, not a missing feature.
2. **`saved_messages` is write-only.** Both client surfaces offer "Save"
   (`travel-buddy-standalone/app/messages/[id].tsx:2227`,
   `src/components/GroupChatScreen.tsx:1064`), the server persists it
   (`routes/messaging.ts:2679`) — and **nothing in the repository ever reads the
   table back.** Settled by reading call sites, not by grepping `from("…")`:
   the only other reference anywhere is the account-deletion cascade
   (`lib/deletionDispositions.ts:432`). There is no saved-messages screen and no
   route. §10.2's "save as a private Memory draft" persists into a hole.
3. **`message_reports` and `thread_reports` are dead tables.** The ground-truth
   scan was right and this census can say why: both report handlers write to the
   **unified `reports` table** instead (`routes/messaging.ts:2626` for threads,
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
T416, T446). A reader who credits vacuous satisfaction should move all
twenty-one to BUILT-AND-CORRECT, which gives CORRECT% = 119/451 = **26.4 %**
and CONSTRUCTED% = 291/451 = **64.5 %**. This census does not credit them.

### Method caveat, inherited

`src/scripts/checkWriterlessReads.ts:39-41` declares that a dynamic
`.from(expr)` anywhere makes writer attribution **INCOMPLETE** and that the
check errs toward silence. A `from("table")` grep also misses variable and RPC
access. **Every "nothing writes/reads X" claim in this census was settled by
reading the call sites**, and the two dynamic `.from(table)` sites in the tree
(`services/media/MyWorldMemoryService.ts:614`,
`services/media/MediaProjectionService.ts:1182#const { data } = await (sc as any).from(table).select("*").eq(ownerCol, ownerId).limit(1000);`) were opened and confirmed to be
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
| T2 | Pillar **Talk** — text, rich media, voice, GIFs, replies, reactions, seen states, safe message lifecycle | W | Four of eight. Text/media (`routes/messaging.ts:1732`, `:2067`), replies (`:1841` `reply_to_id`), seen (`:1202`) are real. **Voice, GIF, reactions and safe lifecycle are absent**: `:2078-2081` accepts only `image`/`video`; `message_reactions` does not exist in `baseline/20260819_baseline_structure.sql`; delete is unconditional (`routes/groupChat.ts:340-381`) and unsend does not exist. |
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
| T30 | Blocking is absolute and removes both parties from each other's proximity surfaces | W | Blocking is genuinely absolute in delivery and discovery: `routes/blocks.ts:60-78` tears down follows, friend requests, friendships and pending message requests and writes an interaction cooldown; `compass/CompassTools.ts:1183` filters hidden users out of every social tool; five block-exclusion suites exist (`test/blockExclusion.test.ts`, `memoriesBlockFailClosed.test.ts`, `compass-ui-blocks.test.ts`, `discoveryBlockedSubmitter.test.ts`, `rentABuddySearchBlocks.test.ts`). Two divergences: the proximity half is vacuous, and blocking deliberately **does not close an existing thread** — it is re-checked per send instead (`routes/messaging.ts:1777-1791`), which is defensible but is not "absolute" at the object level. |
| T31 | Privacy zones can suppress discovery around home, lodging or user-defined sensitive places | W | The capability exists and is well built — `lib/protectedLocations.ts:13-27`, a server-side last gate, fail-closed on unparseable geometry — but it belongs to the Map programme, its policy table ships empty by design, and **nothing in Telegraph consults it**. |
| T32 | Who's Around: focused surface for people, open plans and events actionable right now | W | `get_whos_around` is real and privacy-correct (`compass/CompassTools.ts:187`, impl `:767-782`; approximate-only, opt-in-only, `contextsChecked === 0` answers honestly). But it is a **Compass LLM tool, not a surface**, it returns people only — no open plans, no events — and it is scoped to the caller's circles and trips. |
| T33 | Existing social graph separated from discoverable strangers | W | The separation exists in one direction: `toolWhosAround` gates on `sharesSocialContext` (`CompassTools.ts:831`) so only the graph is returned, and stranger contact runs entirely through `message_requests`. The *discoverable strangers* half has no implementation, so there is nothing to separate from. |
| T34 | Stranger flow: safe profile preview → Wave/Request → accepted thread; no automatic unrestricted messaging | C | `lib/messagingPermissions.ts:29-45` resolves `allowed` / `requires_request` / `denied`; `routes/messaging.ts:276-303` refuses `open-thread` fail-closed and names the request route; `:430` files the request and `:615` accepts it into a thread. No path opens an unrestricted stranger thread. There is no separate "Wave" primitive — the request is it. |

### §5 Universal Portava Sharing

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T35 | One consistent share contract for all eligible Portava content | W | Sharing exists but there is **no contract**: each source builds its own JSON and posts it as a `msg_type:'system'` message with a bespoke `subtype`. `DiscoveryShareSheet` → `subtype:'discovery_card'`, `app/messages/[id].tsx:2269` → `'compass_card'`, `routes/circle.ts:300` → `msg_type:'circle_status_card'`, `services/media/MediaActionResolver.ts:340` → `share_telegraph`. Four producers, four shapes, no shared interface. |
| T36 | Object family **Social** — profile, post, Highlight, public Memory derivative, Memory Note, Stamp | W | Post only (`components/PostCardMessage.tsx`). No profile, Highlight, Memory derivative, Memory Note or Stamp share. |
| T37 | Object family **Travel** — Trip, Trip stage, plan, event, route, reservation-safe derivative, layover plan | N | None of the seven is shareable into a thread. |
| T38 | Object family **Places** — place, Hidden Gem, map pin, neighborhood, meetup point | W | Place/gem via `discovery_card` (`components/DiscoveryCardMessage.tsx:26-35`) and meeting point via `circle_status_card` (`components/CircleStatusCardMessage.logic.ts:15`). No map pin, no neighborhood. |
| T39 | Object family **Services** — Buddy profile/service, eligible booking card, Visa Buddy operational card | W | Booking milestones render (`components/rentabuddy/BookingMilestoneMessage.tsx`, dispatched `app/messages/[id].tsx:1862-1866`) and a booking owns its thread (`rent_buddy_bookings.telegraph_thread_id`, read at `routes/messaging.ts:1885`). No Buddy profile share, no Visa Buddy card. |
| T40 | Object family **Media** — photo, video, voice, GIF, file | W | Photo and video only (`routes/messaging.ts:2078-2081`). No voice, GIF or file. |
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
| T48 | Message kind **TEXT** | C | `routes/messaging.ts:1756` `msgType` defaults to `'text'`; rendered `app/messages/[id].tsx:1899`. |
| T49 | Message kind **IMAGE** | C | `routes/messaging.ts:2078-2081` + `:2174` `media_type`; rendered `components/MessageMediaBubble.tsx`, dispatched `app/messages/[id].tsx:1870`. |
| T50 | Message kind **VIDEO** | C | Same path; `media_type` CHECK `('image','video')` (`baseline:7573`). |
| T51 | Message kind **MEDIA_ALBUM** | N | One asset per message; `messages` carries a single `media_url` (`baseline:7568`). No album concept. |
| T52 | Message kind **GIF** | N | No GIF kind, provider or picker anywhere. |
| T53 | Message kind **VOICE** | N | No voice message, no `media_duration_seconds` writer for audio, no waveform, no audio MIME in `lib/mediaPipeline.ts:74` (`ALLOWED_MEDIA_MIME` is image/video only). |
| T54 | Message kind **MEMORY_NOTE** | N | No Memory Note kind. |
| T55 | Message kind **PORTAVA_OBJECT** | W | Implemented as `msg_type:'system'` plus a bespoke `subtype` per object family rather than a typed kind (`app/messages/[id].tsx:718-763`). The capability exists; the envelope the spec asks for does not. |
| T56 | Message kind **LOCATION** | N | No location message kind. |
| T57 | Message kind **ACTION** | N | Actions are inferred from card subtypes, not carried as a kind. |
| T58 | Message kind **ANNOUNCEMENT** | N | No announcement kind (see also T392–T394). |
| T59 | Message kind **SYSTEM** | C | `routes/messaging.ts:1755` `msgType === 'system' ? 'system' : 'text'`; centred-pill renderer `app/messages/[id].tsx:1892-1898` → `components/TelegraphSystemNotice.tsx:16`. |
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
| T69 | Lifecycle SENDING → SENT → DELIVERED → SEEN, ↘ FAILED; SENT/DELIVERED + unseen → UNSENT | W | Two of six states. There is no `lifecycleState` column (`baseline:7553-7574`), **no DELIVERED concept anywhere** (`grep -i '\bdelivered\b'` over `routes/messaging.ts` + `routes/groupChat.ts` + `lib/telegraphEvents.ts` returns one unrelated E2EE string, `routes/messaging.ts:1309`), and no UNSENT. State is inferred from `created_at`, `edited_at`, `deleted_at` and the thread-level `last_read_at`. |
| T70 | Seen = crossed the approved visibility threshold in an active foreground conversation | W | Seen is **thread-level, not message-level**, and is whatever the client asserts: `routes/messaging.ts:1202-1218` stamps `message_thread_members.last_read_at = now()` on any authenticated call, with no visibility predicate the server can check. |
| T71 | Push delivery, app launch and background rendering do not count as seen | ? | The server cannot distinguish them — `POST /threads/:threadId/read` takes no evidence (`:1202`). Whether the client calls it only on foreground render is a runtime property of `hooks/useMessaging.ts markThreadRead`; it is called from a focus effect, but nothing enforces it and no test exercises the background case. |
| T72 | `conversation_members.lastDeliveredSequence` / `lastSeenSequence` | W | Half exists in a different shape: `message_thread_members.last_read_at` (`baseline:7503`) is a timestamp, not a sequence, and there is **no delivered counterpart**. |
| T73 | Direct: Sent/Delivered/Seen. Groups: "Seen by N", optionally list viewers when policy allows | N | No receipt UI beyond the inbox's own unread count. `read.updated` is published (`routes/messaging.ts:1229-1234`) but nothing renders per-message receipts. |
| T74 | Do not create permanent row-per-message-per-user receipt explosions | C | The receipt is one row per member per thread with a single timestamp (`baseline:7495-7505`), and unread counts are derived by comparing `created_at > last_read_at` (`routes/messaging.ts:915-960`). The forbidden shape is structurally absent, and the alternative is implemented. |
| T75 | A sender may unsend only while no eligible recipient has seen the message | N | Nothing in `artifacts/api-server` implements unsend. The only two `/unsend\|unsent/` matches in the whole server tree are unrelated: `test/discoveryNegativeSignalWriter.test.ts:26` (the word "unsendable" in prose) and `migrations/0080_events_extension.sql:380` (`event_reminders_unsent_idx`). **This confirms migration 2325's header claim, with that two-match correction.** What exists instead is unconditional DELETE (`routes/groupChat.ts:340-381`), sender-only, at any time, with no seen predicate. |
| T76 | In a group, one recipient seeing the message closes the window for everyone | N | No window exists to close. |
| T77 | The server resolves read-vs-unsend races transactionally | N | No unsend; and the competing writer (`routes/messaging.ts:1213` `last_read_at`) takes no lock. |
| T78 | Preserve a sequence tombstone internally | W | A tombstone is preserved — deleted rows are returned and rendered as a redacted slot, and the body is emptied rather than the row removed (`routes/groupChat.ts:363-372`, reader `routes/messaging.ts:1575`). But there is no `sequence` to preserve continuity of; ordering is `created_at` (`:1579`). |
| T79 | Remove from normal retrieval, search and projections | W | The body is suppressed on `deleted_at` (`routes/messaging.ts:1717` `body: isDeleted ? null : m.body`) — but in **main** the media fields are not: `:1718-1721` returns `media_url`, `media_thumbnail_url`, `media_type` and `media_duration_seconds` unconditionally, so deleting a photo redacts the caption and leaves the asset addressable. PR #472 fixes exactly this; it is not merged. |
| T80 | Text edits retain an Edited marker **and version history** | W | The marker is real (`routes/messaging.ts:2369-2372` sets `edited_at`, surfaced as `editedAt`). **Version history is not**: the update overwrites `body` in place and `message_edits` does not exist in the schema. Translation invalidation on edit is correct (`:2399` `markTranslationsPending`). |
| T81 | Editing message prose never silently mutates a canonical Plan/Event/Trip object | C | The edit handler writes exactly two columns on one row — `body` and `edited_at` (`routes/messaging.ts:2369-2372`) — and touches nothing else. No card is re-parsed, no domain write is triggered. The forbidden path does not merely happen not to run; the handler has no branch that could reach it. |

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
| T119 | A user may explicitly save a message, voice note, place share or media item as a private Memory draft | W | **Persists into a hole.** Both client surfaces offer it (`app/messages/[id].tsx:2227`, `components/GroupChatScreen.tsx:1064`) and the server upserts (`routes/messaging.ts:2654-2691`), but **nothing reads `saved_messages` back** — settled by reading call sites, not greps: the only other references in the entire repository are the deletion cascade (`lib/deletionDispositions.ts:432`) and the RLS ledger (`scripts/rlsDispositions.ts:429`). There is no saved-messages route and no screen. It also lands in `saved_messages`, not in `memories`, so it is not a Memory draft. |
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
| T145 | `message_translations` — recipient-language derived translation | C | `baseline:7534-7546` — per `(message_id, recipient_id)` row with source/target language, provider, a `translation_status` enum and `error_message`. Written by `services/messageTranslation.ts:1-13`, read scoped to the caller at `routes/messaging.ts:1608-1613`. The best-realised row in this table. |
| T146 | `conversation_decisions` | W | The meetup triple is the analogue (T83); there is no general decision store. |
| T147 | `conversation_action_refs` — references to canonical Plans/Trips/Events/Places | N | No table. References live as untyped fields inside the JSON body (T43), so nothing can be joined, revalidated or revoked. |
| T148 | `availability_signals` | W | `availability_windows` (`migrations/2260_availability_windows.sql:67-100`) is a strong analogue built for **Passport §8**, not this spec, and Telegraph never reads it (T28). |
| T149 | `location_shares` — purpose/audience/precision/expiry scoped | W | Split across two tables and missing the first term. `trip_crew_location_sessions` (`baseline:10507-10521`) has audience (`allowed_member_ids`), precision (`visibility_level` CHECK `city_only|neighborhood|nearby`) and expiry (`expires_at`) — but **no `purpose`**. A twelve-entry purpose registry exists separately (`lib/locationPurposes.ts:103-302`) and is not joined to any share row. |
| T150 | `coordination_sessions` | N | No table, service or route. |
| T151 | `presence_sessions` — ephemeral online/recent activity | W | `circle_presence` (`baseline:4458-4473`) is a genuine ephemeral presence store with `stale_after_secs`, `is_stale` and `expires_at` — but it is **circle-scoped, not conversation-scoped**, so a DM has no presence at all. |
| T152 | `call_sessions` / `call_participants` | C | Both exist (`baseline:1`, confirmed present). `routes/calls.ts:1-12` authorizes *exclusively* through `canUserStartCall`/`canUserStartGroupCall`/`canUserJoinCall` with no inline authorization, mints LiveKit tokens only after that passes, and `migrations/2199_call_participants_rls_recursion.sql` hardens their RLS. |
| T153 | `conversation_reports` / `blocks` | W | `blocks` is real and cascading (T30). Reporting is real but writes to the **unified `reports` table** (`routes/messaging.ts:2626` threads, `:2708` messages) — while the two dedicated tables production actually holds, `message_reports` and `thread_reports`, have **no writer and no reader** anywhere in application code. Settled by reading both handlers; their only other appearances are `scripts/rlsDispositions.ts:310,456`, `scripts/frozenLegacyFiles.ts:45-46` and `lib/deletionDispositions.ts:370,441`. |
| T154 | `conversation_outbox` — transactional domain-event outbox | N | No outbox table and no outbox worker. Events are published **after the HTTP response** and outside any transaction (`routes/messaging.ts:1996` responds, `:2018` publishes). |
| T155 | `conversation_snapshots` — rebuild/replay checkpoints | N | Absent. |
| T156 | §12.1 `Message` envelope contract | W | Ten of sixteen fields exist (`id`, `thread_id`, `sender_id`, `msg_type`, `body`, `reply_to_id`, `created_at`, `edited_at`, `deleted_at`, `original_language` — `baseline:7553-7574`). The six that are absent are the six that carry the guarantees: **`sequence`, `contentRef`, `unsentAt`, `clientMessageId`, `idempotencyKey`, `lifecycleState`**. |
| T157 | Avoid a giant unversioned `metadata_json` and dozens of nullable FKs on `messages` | W | Half right. There is no `metadata_json` column — but the structured payload is an **unversioned JSON string stuffed into `body`** and parsed per-subtype at the client (`components/DiscoveryCardMessage.tsx:37-45`, `components/CircleStatusCardMessage.logic.ts:43-52`), which is the same anti-pattern under a different column name. `messages` also carries four nullable media columns plus `reply_to_id` and `ciphertext`. |
| T158 | Structured payload types use versioned schemas and explicit reference tables | N | No version field on any card payload and no reference table. See also T429–T431. |

### §13 Commands & Events

| id | Command (§13.1) | V | Evidence |
| --- | --- | --- | --- |
| T159 | `SEND_MESSAGE` | C | `routes/messaging.ts:1732`. |
| T160 | `EDIT_MESSAGE` | C | `routes/messaging.ts:2331`. |
| T161 | `UNSEND_MESSAGE` | N | Absent (T75). |
| T162 | `DELETE_MESSAGE` | C | `routes/groupChat.ts:340-381` — sender-only, active-member-only, redacts the body. |
| T163 | `ADD_REACTION` | N | No route, no table (T143). |
| T164 | `ACCEPT_REQUEST` | C | `routes/messaging.ts:615`. |
| T165 | `DECLINE_REQUEST` | C | `routes/messaging.ts:838`; cancel at `:877`. |
| T166 | `CREATE_DECISION` | W | Only in the meetup shape: `routes/telegraphChat.ts:11-12` `/create-meetup` and `/start-poll`. No general decision command. |
| T167 | `CAST_VOTE` | C | `meetup_time_votes` (`baseline:7336`) via `rsvpMeetup` (`app/messages/[id].tsx:48`). |
| T168 | `CREATE_COORDINATION_SESSION` | N | Nothing (T85). |
| T169 | `SET_COORDINATION_STATUS` | W | Approximated by circle check-in (`routes/circle.ts:300`, subtypes at `components/CircleStatusCardMessage.logic.ts:57`); not a conversation command and not the §9.1 vocabulary. |
| T170 | `SHARE_LOCATION` | W | Exists outside Telegraph only (T96). |
| T171 | `STOP_LOCATION_SHARE` | C | `routes/safeReturn.ts:17` `POST /me/safe-return/sessions/:id/live-share/stop`; `trip_crew_location_sessions.status` transitions to `stopped` (`baseline:10515-10520`). Revocation is a first-class operation on both stores. |
| T172 | `SET_AVAILABILITY` | C | `routes/availability.ts:161` PATCH quick-availability and `:706` POST availability-windows (flag-gated by `open_to_plans_windows_enabled`, `:42`). |
| T173 | `STOP_AVAILABILITY` | C | `routes/availability.ts:776` DELETE `/me/availability-windows/:id` → `clearWindow` (`services/passport/OpenToPlansService.js`). |
| T174 | `BLOCK_USER` | C | `routes/blocks.ts:46` with the cascade at `:60-78`. |
| T175 | `MUTE_THREAD` | C | `routes/messaging.ts:2538` → `message_thread_members.muted_at` (`baseline:7500`). |
| T176 | `REPORT_MESSAGE` | C | `routes/messaging.ts:2697-2726`, writing the unified `reports` table with `target_type:'message'` and invalidating the reporter's Compass cache at `:2723`. |

| id | Event (§13.2) | V | Evidence |
| --- | --- | --- | --- |
| T177 | `message.sent` | C | Published as `message.created` (`lib/telegraphEvents.ts:24`), emitted at `routes/messaging.ts:2018-2033` with the sender excluded. Renamed, semantically identical. |
| T178 | `message.delivered` | N | No delivered concept exists to emit (T69). |
| T179 | `message.seen` | W | `read.updated` (`lib/telegraphEvents.ts:30`) is published at `routes/messaging.ts:1229-1234` — but it carries a **thread-level** `lastReadAt`, not a per-message seen fact, so no consumer can answer "was *this* message seen". |
| T180 | `message.edited` | C | `message.updated` (`lib/telegraphEvents.ts:25`), published `routes/messaging.ts:2392-2397`. |
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
| T193 | `user.blocked` | C | `lib/telegraphEvents.ts:34`, with `access.revoked` (`:47`) closing live SSE connections whose access has gone. |
| T194 | `safety.reported` | N | Not in the union; reports write a row and emit nothing. |
| T195 | Canonical mutation and event-outbox write occur in the **same database transaction** | N | There is no outbox. `routes/messaging.ts:1996` sends the 201, then `:2018` and `:2030` publish, then `:2037` translates — all after the response, all outside any transaction. A crash between insert and publish loses the event with no replay path. |
| T196 | Push, realtime, indexing, translation, moderation, analytics and projections consume asynchronously and **idempotently** | W | Asynchronous: yes, and deliberately — `lib/telegraphEvents.ts:14-16` states publish failures are logged and swallowed *"so realtime delivery can never break a write path"*, with client polling self-healing. **Idempotent: no.** Without an outbox, event ids or dedup keys, a retried consumer double-applies. The single exception is notifications: `services/notifications/NotificationDeduplicationService.ts:42-45` coalesces `telegraph.message` by `sourceId`. |

### §14 Authorization & Conversation Policy

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T197 | Capability `canSendMessage` | C | Resolved server-side and re-checked per send: `lib/messagingPermissions.ts:29-45` (verdict ladder incl. `message_privacy` and mutual-block), enforced at `routes/messaging.ts:1763-1771` (membership) and `:1777-1791` (pairwise block, fail-closed via `isBlockedBetween`). |
| T198 | Capability `canCall` | C | `routes/calls.ts:17-20` — every endpoint authorizes exclusively through `canUserStartCall` / `canUserStartGroupCall` / `canUserJoinCall`, with the `whoCanCall` preference read by `getFullCallPreferences` (`:26`). |
| T199 | Capability `canCreatePlan` | W | No capability flag exists; plan creation is gated implicitly by thread membership plus a re-verified trip membership at execution (`routes/telegraphCommands.ts:390-444`). The enforcement is real; the capability is not modelled. |
| T200 | Capability `canShareExactLocation` | W | Precision is a property of the *session* (`trip_crew_location_sessions.visibility_level`, `baseline:10518`), not a conversation capability, and no conversation ever grants or denies it. |
| T201 | Capability `canInvite` | N | There is no invite operation on a thread at all (T212). |
| T202 | Capability `canRequestPayment` | N | No payment request in Telegraph. The nearest thing is the off-app solicitation *detector* (`routes/messaging.ts:1873-1940`), which is the opposite concern. |
| T203 | Capability `canCreateBooking` | W | Booking gates exist and are real (`checkBookingKycGate` / `enforceBookingCreationGates` in the Rent-a-Buddy tree) but they are not conversation capabilities and are not evaluated per thread. |
| T204 | Capability `canBroadcast` | N | No broadcast concept (T415–T417). |
| T205 | Capability `canViewPreMembershipHistory` | W | Not modelled — **and the rule it would express is violated**. See T211. |
| T206 | Capability `canSeeGroupReadReceipts` | N | No group read receipts exist to gate (T73). |
| T207 | Capabilities derived server-side from membership, block state, Trip/Crew membership, booking state, age/policy, location scope, safety state and conversation type | W | A genuine server-side resolver exists — `services/interactionPermissions.ts:597-632` folds blocks, follows, friendships, trust restrictions and age into a verdict, and `routes/messaging.ts:288-303` treats a resolver throw as `db_error` rather than permission — but it is a **pairwise interaction** resolver returning two booleans (`canMessage`, `canSendMessageRequest`), not a conversation-scoped capability set over the nine named inputs. |
| T208 | UI renders capabilities; it does not invent authorization | C | No client-supplied flag is trusted anywhere. Every mutating route re-derives authorization: membership `routes/messaging.ts:1763-1771`; block fail-closed `:1777-1791`; edit ownership `:2363-2367`; delete ownership + active membership `routes/groupChat.ts:355-360`; `verifyThreadMember` on every suggestion call `routes/telegraphChat.ts:45-56`; command confirmation re-verifies trip membership at execution `routes/telegraphCommands.ts:390`. |
| T209 | Authorization is checked **both** when sending and when reading | C | Reads re-authorize as thoroughly as writes: `routes/messaging.ts:1558-1568` re-checks active membership on every page of messages; `:1608-1613` scopes translations to `recipient_id = user.id`; `:1594-1598` re-applies `nameVisibilitySet` per read so an identity that stopped being visible stops being returned. |
| T210 | `visibleFromSequence` / `visibleUntilSequence` on members | N | Neither column exists, under any name; a repository-wide search for `visible_from` / `visible_until` returns nothing. |
| T211 | New members do not automatically receive pre-membership history | W | **Violated.** `routes/messaging.ts:1575-1583` selects from `messages` filtered on `thread_id` and ordered by `created_at`, with the only gate being *current* active membership (`:1558-1568`) — no `joined_at` bound of any kind. `services/groupChatSync.ts:9-13` adds every newly-accepted trip member to the trip thread, and `syncCircleChatMembers` does the same for circles, so a new member can immediately page back through the entire prior conversation. |
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
| T219 | Block cascade across direct delivery, location, presence, Nearby, Bump discovery, shared-memory resurfacing, Crew suggestions and Compass retrieval | W | Five of eight have real enforcement: delivery (`routes/messaging.ts:1786-1790`), Compass (`compass/CompassTools.ts:1183` `refreshHiddenUsers`), discovery (`test/discoverySearchBlockedSubmitter.test.ts`), memories (`test/memoriesBlockFailClosed.test.ts`), Buddy search (`test/rentABuddySearchBlocks.test.ts`). Nearby, Bump and Crew suggestions have no referent; shared-memory resurfacing is covered. |
| T220 | No subsystem may independently "rediscover" a blocked relationship | W | The right architecture is in place — one shared fail-closed helper, `lib/blockGuard.ts` `isBlockedBetween`, consulted rather than reimplemented, plus `refreshHiddenUsers` for the Compass tool surface. **But in main the read that decides whether to consult it fails open**: `routes/messaging.ts:1781-1786` destructures only `{ data: otherMembers }`, and because supabase-js *resolves* rather than throws, a transient failure yields `null`, `?? []` turns an unreadable membership table into "this thread has no other members", `others.length === 1` is false, and the whole pairwise block guard is skipped. The same hole exists on the media send path (`:2137-2142`). PR #472 fixes both; it is unmerged. |

### §16 Media Pipeline

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T221 | `MediaAsset != Message != Memory`; attachments and Memory links both point at a MediaAsset | W | The canonical asset store exists and is well built (`lib/mediaAssets.ts:94-160`, with EXIF capture-time extraction at `:62-80`) — but **message media does not use it**: `routes/messaging.ts:2174` writes `media_url` / `media_type` / `media_thumbnail_url` straight onto the `messages` row. Telegraph is the surface that did not adopt the separation. |
| T222 | Progressive ladder: local preview → thumbnail/poster → streamable rendition → original | W | Two rungs. The client shows a local preview through its upload states (`hooks/useMessageMediaPicker.ts:30` `idle\|picking\|previewing\|uploading\|done\|failed`) and a thumbnail is stored (`messages.media_thumbnail_url`). There is no streamable rendition and no original/derivative distinction for message media. |
| T223 | Resumable / chunked upload for poor travel connectivity | N | `hooks/useMessageMediaPicker.ts:60,66` offers upload progress, cancel and retry — but retry restarts the transfer. No range, no chunking, no resume token. |
| T224 | Poster/frame generation and adaptive renditions for video | W | Poster/thumbnail generation exists in the shared processor (`lib/mediaProcessing.ts:154-210`, sharp re-encode with full metadata strip); adaptive renditions do not exist for any surface. |
| T225 | Waveform generation for voice as derived metadata | N | No voice (T53); `lib/mediaPipeline.ts:74` `ALLOWED_MEDIA_MIME` admits no audio type. |
| T226 | Media scanning/moderation must not block basic text delivery | C | Structurally impossible to block it: text and media are separate endpoints (`routes/messaging.ts:1732` vs `:2067`), and the sniff/size/rate policy runs at *upload* time in `lib/mediaPipeline.ts:186-226` — a path a text send never enters. |
| T227 | Data-saver mode prioritizes text/status/coordinates over media/AI | N | No data-saver setting exists in the client. |

### §17 Offline, Realtime & Multi-Device

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T228 | Per-conversation server sequence ordering, not global ordering | N | No sequence column exists. Ordering is `created_at DESC` with a `created_at` cursor (`routes/messaging.ts:1579-1583`), which cannot distinguish two messages written in the same millisecond and cannot express "after event N". |
| T229 | Client timestamps are advisory only | C | The server generates the timestamp itself and never reads one from the body: `routes/messaging.ts:1820` `const now = new Date().toISOString()`, written at `:1851` `created_at: now`. There is no `createdAtClient` field to trust. |
| T230 | Offline command fields: `clientMessageId`, `idempotencyKey`, `createdAtClient`, `syncState` | W | One of four, and it is **not persisted**. `clientId` is accepted (`routes/messaging.ts:1761`), echoed in the response (`:2005`) and in the realtime payload (`:2029`) — but the insert at `:1846-1859` does not include it, so the server retains no correlation key after the request ends. |
| T231 | Offline resend must be idempotent | N | Direct consequence of T230: nothing is stored to deduplicate against, there is no unique constraint on any client key and the write is an `insert`, not an `upsert`. A retried send creates a second message. |
| T232 | Tombstones preserve sequence continuity for unsent/deleted messages | W | The tombstone half is real and deliberate — the row is retained and redacted in place rather than removed (`routes/groupChat.ts:363-372`, with the `body: ''` choice documented because `body` is `NOT NULL`), and the reader returns it as a suppressed slot (`routes/messaging.ts:1717`). There is no sequence for it to keep continuous. |
| T233 | Reconnect resumes from the last acknowledged conversation/event sequence | N | The SSE stream carries no cursor: `routes/telegraphStream.ts:36-40` closes at 30 minutes with a `reconnect` event and the client re-authenticates from scratch. Gap recovery is delegated entirely to polling (`lib/telegraphEvents.ts:15-16`). |
| T234 | Seen/delivery state, edits and canonical thread state converge server-side | W | Edits and thread state converge properly (one server-authoritative row; `routes/messaging.ts:2369`). Seen converges at **thread** granularity only. Delivery has no state to converge (T69). |
| T235 | Active precise location is device-specific and must not automatically transfer to a newly authenticated device | N | Both location stores are keyed by `user_id` alone — `location_sessions` (`baseline:7109`) and `trip_crew_location_sessions` (`baseline:10509`) carry no device column — so a live share follows the *account*. The device registry that exists (`routes/devices.ts:1-16`) is an MLS crypto-key registry and is not consulted by any location path. |
| T236 | Realtime gateway failure → polling / delta fallback | C | Designed in, and stated: `routes/telegraphStream.ts:13-15` — *"The mobile client always retains polling as a fallback, so this transport is an enhancement, never a hard dependency"*; `lib/telegraphEvents.ts:14-16` — publish failures are logged and swallowed *"so realtime delivery can never break a write path"*, and *"any missed event self-heals on the next poll."* |
| T237 | Push failure → no loss of canonical messages; push is wakeup/fallback, not consistency authority | C | The row is inserted (`routes/messaging.ts:1846`) and the 201 sent (`:1996`) before any notification work; dispatch is `Promise.allSettled` inside a try/catch explicitly labelled non-fatal (`:1975-1990`). |
| T238 | Translation / AI / maps failure → core messaging continues | C | `services/messageTranslation.ts:11` — *"Falls back to `status: failed` on any error — never throws"* — and the call site adds an outer net (`routes/messaging.ts:2037-2044`). Tagging is wrapped the same way (`:1962-1990`). Suggestion generation is a separate endpoint entirely. |
| T239 | Low bandwidth → deprioritize typing, reactions, media preview and AI before text or safety | N | No bandwidth signal and no degradation ladder. Typing happens to be realtime-only (T258), which is adjacent but not adaptive. |

### §18 Translation, Voice & Compass

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T240 | `MessageTranslation` contract | W | Six of eight fields: `message_id`, `target_language`, `translated_body`, `provider`, `created_at`/`updated_at`, plus `status` and `error_message` the spec does not ask for (`baseline:7534-7546`). **Missing `providerVersion` and `confidence`** — and the absence of `confidence` is what makes T242 fail. |
| T241 | Store the original text/audio; translation never replaces it | C | The original stays in `messages.body`; the translation is a separate row keyed by recipient; the read path returns both and says which is which — `displayBody` / `originalBody` / `originalLanguage` / `translated` / `canShowOriginal` (`services/messageTranslation.ts:31-38`), assembled at `routes/messaging.ts:1608-1613`. Nothing overwrites the source. |
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
| T253 | Compass cannot reveal one participant's private Memory/preferences to another, impersonate participants, or silently create canonical plans from uncertain prose | C | All three, separately enforced. Cross-participant leakage: the privacy verdict above plus `compass/CompassTools.ts:240` — *"never mention a person a tool did not return … NEVER guess, infer, triangulate"*. Impersonation: suggestions render as a labelled tray (`components/TelegraphSuggestionTray.tsx`), never as a participant's message. Silent creation: `requires_confirmation: true` as a literal type (T101). |

### §19 Notifications & Attention

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T254 | P0 Safety — interruptive; bypasses ordinary batching where policy requires | C | A genuine override exists: `services/notifications/NotificationPreferenceService.ts:6-7` — *"Quiet hours: skip push during window UNLESS urgent or admin priority"* and *"Safety override: urgent + admin priority always deliver even when push is off"*, backed by a stored `safety_override` flag (`:59`). Safety events actually carry `urgent`: `safe_return.reminder`, `.missed`, `.trusted_circle_alert`, `.check_in_prompt`, `circle.need_help_host_alert`. |
| T255 | P1 Coordination — immediate / high priority | W | `important` exists and is used for coordination-shaped events (`NotificationTemplateService.ts:67,105,118,130,169,188`) but it carries **no delivery difference** from `normal` — only `urgent` changes behaviour (T254). It is a label, not a priority. |
| T256 | P2 Message — standard notification policy | C | `NotificationTemplateService.ts:215-222` — `telegraph.message`, `defaultPriority:'normal'`, `defaultChannels:['in_app','push','telegraph']`, deduped by `sourceId` at `NotificationDeduplicationService.ts:42-45`. |
| T257 | P3 Media — large upload completion, passive/batched | N | No media-completion notification and no batching mechanism. |
| T258 | P4 Ephemeral — typing, lightweight presence: realtime only, no persistent push | C | Structurally guaranteed. `routes/telegraphStream.ts:6-7` — *"typing relay (**no persistence**)"* — and there is **no typing template at all** in `NotificationTemplateService.ts`, so no push path can exist for it. `typing.started` / `typing.stopped` live only on the in-memory bus (`lib/telegraphEvents.ts:28-29`). |
| T259 | P5 AI — lowest priority, degrades first | W | The priority half is right: `telegraph.ai_suggestion` is `defaultPriority:'low'` on `['in_app']` only — no push (`NotificationTemplateService.ts:233-240`). The *degrade-first* half does not exist: there is no load-shedding ladder anywhere. |
| T260 | Inbox displays "12 unread · 1 needs action" | W | Unread is real and carefully built (`routes/messaging.ts:915-960`, with a schema-drift fallback when migration 0016's `last_read_at` is absent, `:940-943`). **"Needs action" has no representation** — nothing distinguishes a message from an unresolved decision. |
| T261 | Acknowledgment for important operational changes is distinct from passive Seen | N | No acknowledgement primitive for any message or card. (Safe Return contacts carry `acknowledged_at`, `services/safeReturn/SafeReturnService.ts:75`, which is a different object.) |

### §20 Source-Domain Integrations

| id | Domain | V | Evidence |
| --- | --- | --- | --- |
| T262 | **Trips** — crew threads, shared Trip cards, today/next context, membership authorization, Trip Kernel commands | W | Two of five. Crew threads are real and auto-synced (`routes/messaging.ts:2424` `GET /trips/:tripId/chat`, `services/groupChatSync.ts:9-13`) and membership authorizes (`isAcceptedTripMember`, `routes/telegraphCommands.ts:463`). No shared Trip card, no today/next context, no Trip Kernel commands. |
| T263 | **Plans** — invitation, RSVP, changes, dependencies, coordination trigger | W | Invitation and RSVP are real (`meetup_invites`, `components/RsvpBar.tsx`, `app/messages/[id].tsx:2172`); change cards exist for meeting points (`routes/circle.ts:1377`). No dependencies and no coordination trigger (T103). |
| T264 | **Events** — share card, attendance, live status, timing changes | W | An `event_context_card` subtype exists in the message vocabulary, but no attendance, live status or timing-change surface renders in a thread. |
| T265 | **Places / Hidden Gems** — share, save, meet here, add to Trip, current intelligence | W | Three of five, and they are the card's own action row: *View / Add to Plan / Save* (`components/DiscoveryCardMessage.tsx:1-9`, save via `services/discoveryBookmarks.toggleSave`, add via `components/discovery/TripWishlistPicker.tsx`). No "meet here" from a card (T91) and no live intelligence — the card is a frozen snapshot (T46). |
| T266 | **Discovery** — Discover Together; shared opportunity set from availability, time and context | N | Sharing a discovery card is not "Discover Together". No shared opportunity set exists; Telegraph reads neither availability nor time context. |
| T267 | **Compass** — authorized thread context, meeting/recommendation tools, catch-up | W | Thread context and recommendation are real and privacy-gated (`components/CompassTelegraphTray.tsx`, `services/compass.checkCompassTelegraphAvailable`, `components/CompassCardMessage.tsx`; server `routes/telegraphChat.ts`). Meeting tools (T248) and catch-up do not exist. |
| T268 | **Memories** — safe share derivatives, Memory Notes, explicit Save to Memory, post-experience recap | W | One of four, and it is broken: Save exists and writes nowhere useful (T119). No derivatives, no Memory Notes, no recap. |
| T269 | **Buddy / Visa Buddy** — protected booking/operational layer; **no chat mutation of price/terms** | C | The booking layer is real (`components/rentabuddy/BookingMilestoneMessage.tsx` dispatched at `app/messages/[id].tsx:1862`; a booking owns its thread via `rent_buddy_bookings.telegraph_thread_id`, read at `routes/messaging.ts:1885`; booking-scoped call eligibility at `routes/calls.ts:26`). The prohibition is **actively enforced, not merely unviolated**: no message write path reaches a booking, and `routes/messaging.ts:1873-1940` runs a 14-pattern off-app solicitation detector that logs an admin-only event and auto-suspends the buddy profile past a threshold — with both writes error-checked because *"a silently failed update here leaves a repeat off-app solicitor ACTIVE with no trace"* (`:1915-1934`). |
| T270 | **Safety** — Safe Return, help states, location scope, block/report | C | All four. Safe Return end-to-end (`routes/safeReturn.ts:6-23`), help states (`circle_presence.needs_help`, `routes/circle.ts:1556-1589`), location scope (`trip_crew_location_sessions.visibility_level`), block/report (`routes/blocks.ts:46`, `routes/messaging.ts:2614`, `:2697`), plus an in-thread safety sheet (`components/ThreadSafetySheet.tsx`). |
| T271 | **Map** — meet points, routes, contextual shared map; **no historical movement trail** | W | Meeting points exist (`circle_meeting_points`, `routes/circle.ts:1272-1377`). There is no contextual shared map in a thread and no route share (T93). The prohibition half holds structurally: `trip_crew_location_sessions` keeps a single `last_location_snapshot_id` (`baseline:10519`) — a pointer to one snapshot, not a trail. |

### §21 Search & Retrieval

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T272 | Telegraph search is object-aware and authorization-scoped | N | **There is no conversation search of any kind.** `routes/messaging.ts` (2,731 lines, 30 endpoints) contains no search route, and neither does `routes/groupChat.ts`. The inbox filter (`components/TelegraphInboxScreen.tsx:33-39`) filters loaded threads client-side. |
| T273 | Multi-type results: MESSAGES / PLACES / MEDIA / PLANS / MEMORIES | N | No search. |
| T274 | Index message text, permitted transcripts, object titles and safe metadata | N | Nothing indexes conversation content. |
| T275 | Private semantic indexes filter access **before** retrieval, not after | N `∅` | Unguarded absence: no semantic index over conversations exists. (Compass's own tools do gate before retrieval — `compass/CompassTools.ts:831` `sharesSocialContext`, `:833` trust floor — but they index no message content.) |
| T276 | Unsent/deleted/revoked objects removed from normal user search and Compass retrieval | W | Partial, in the one place it can act. Deleted message bodies are suppressed on read (`routes/messaging.ts:1717`) and a report invalidates the reporter's Compass cache (`:2626`, `:2723`). But deleted **media survives** in main (T79) and revoked source objects survive inside cards forever (T46). |
| T277 | "Ask this conversation" prefers structured plans/decisions/actions over inferred prose | N | No ask-this-conversation surface. The suggestion tray runs on a single typed message, not on the conversation. |

### §22 Abuse, Moderation & Travel Scam Safety

| id | Control | V | Evidence |
| --- | --- | --- | --- |
| T278 | Requests carry contextual origin: Event, Trip, Nearby, Bump, Buddy, profile | N | `message_requests` has no origin column at all (`baseline:7477-7488`) — only `preview_text`. A recipient cannot be told why a stranger is reaching out. |
| T279 | Rate limits adaptive to relationship, verification, trust, account age and reports | W | Two divergences in one row. **Message sending has no rate limit at all** — `routes/messaging.ts` contains no `checkRateLimit` call; the only limiter in the messaging tree is on AI suggestions (`routes/telegraphChat.ts:88`). The adaptive machinery does exist, and is applied only to the *request* step: `resolveInteractionPermissions` plus `getRestrictionState` fold trust restrictions and account state into request eligibility, with a `DegradedPermissionCheckError` path so a failed trust read is not mistaken for permission (`routes/messaging.ts:430-560`, six dedicated tests at `test/messaging.test.ts:519-631`). |
| T280 | Stranger media can be blurred / no autoplay until accepted | N | `components/MessageMediaBubble.tsx:170` renders and autoplays unconditionally. The request-acceptance gate means a stranger cannot open a thread at all, which mitigates the risk but does not implement the control. |
| T281 | Links/files: reputation/scanning; reserved official identities | N | No link scanning, no URL reputation, no reserved-identity list. There is no file kind (T40). |
| T282 | Travel scam signals: off-platform payment, fake taxi, visa help, ticket resale, fake hotel, urgent money request | W | **One of six, and that one is real and enforced.** `routes/messaging.ts:1873-1893` — a 14-pattern off-app payment detector (`off-app`, `pay outside`, `venmo me`, `cashapp`, `my whatsapp`, …) scoped to buddy-booking threads and attributed only when the sender *is* the buddy (`:1896-1904`), escalating to auto-suspension past `OFF_APP_SUSPENSION_THRESHOLD` (`:1913-1935`). No detector exists for the other five families. |
| T283 | Evidence: store minimum necessary reported content/context under restricted policy | W | Minimal, arguably too minimal: a report row carries reporter, target type/id and a 200-character `reason_detail` (`routes/messaging.ts:2621-2632`) and **no content snapshot** — so a message deleted after being reported leaves a moderator with a pointer to a redacted row. |
| T284 | Reported deleted content may remain in restricted moderation storage but not normal retrieval | N | The opposite happens. Deletion redacts in place — `routes/groupChat.ts:371` `.update({ deleted_at: now, body: '' })` — with nothing copied to moderation storage first, so reported content is **destroyed**, not restricted. |

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
| T289 | `TelegraphHomeProjection` — conversation list + badges + Now + nearby summary | W | The list half is a real server-built projection: `routes/messaging.ts:1332` `GET /me/threads` resolves the other participant's display identity under `nameVisibilitySet`, folds in unread counts and thread type. No Now band and no nearby summary (T8). |
| T290 | `ConversationProjection` — renderable ordered thread **with current permissions** | W | The renderable half is real and careful: `routes/messaging.ts:1550-1730` sanitizes sender identities per viewer, joins per-recipient translations, resolves reply context and enriches mention/hashtag spans. It carries **no permissions block**, and it does not bound history (T211). |
| T291 | `SharedContextProjection` | N | Does not exist (T21). |
| T292 | `NearbyAvailableProjection` | N | Does not exist. |
| T293 | `CoordinationProjection` | N | Does not exist (T85). |
| T294 | `ConversationContentIndex` — media/places/Portava/voice/GIF/links/files drawer | N | Dead-coded behind a literal `false` (T66). |
| T295 | Mobile clients consume server-built projections instead of independently joining raw tables and reimplementing authorization | W | Mostly true and then not: `src/services/messaging.ts` goes through `fetch(apiBase()…)` for every message operation (`:238,254,272,605,626,651`). But the conversation screen makes **two direct PostgREST reads of a raw messaging table**, one of which recomputes authorization client-side: `app/messages/[id].tsx:1247-1252` (member count) and `:1260-1266` (*"Permission gate: accepted thread members only"* — a `message_thread_members` select whose result sets `isAcceptedMember`). The server does not trust it (T364), so this is a layering violation rather than a security hole. |

### §25 Migration & Compatibility Strategy

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| T296 | Phase 0: inspect existing messaging schema, migrations, RLS, client routes, realtime subscriptions, push flow, media upload paths, translation paths and current enum literals | N | The T0 inventory artifact does not exist. There is no Telegraph inventory document in `docs/`, and no file in the tree records this inspection. The *capability* to do it exists as standing CI lanes (T297); the deliverable does not. |
| T297 | Compare production and CI schemas before writing migrations | C | Four standing lanes do exactly this: `scripts/auditMigrationsVsLive.ts`, `scripts/checkProductionDrift.ts`, `scripts/checkMissingLiveColumns.ts`, `scripts/auditLiveVsCanonical.ts`. Built by the migration programme, not this spec. |
| T298 | Identify direct client writes and legacy JSON fields; create ratchets before introducing new paths | C | `scripts/checkAuthorizationContract.ts:1-18` fails CI when a protected table regains broad `anon`/`authenticated` mutation privileges or a server-derived column becomes client-writable — *"a migration that reopens one of these must update the contract IN THE SAME PR or CI goes red."* Plus `scripts/checkSilentSupabaseWrites.ts`, `scripts/checkWritePathColumns.ts`, `scripts/frozenLegacyFiles.ts`. |
| T299 | Inventory source-domain FK identities; never substitute semantically similar IDs | C | `scripts/checkSchemaReferences.ts` and `scripts/checkEnumLiterals.ts` are the standing guards; the routes enforce it locally too (`routes/messaging.ts:1834-1844` refuses a reply reference from another thread; `:2668-2677` refuses a cross-thread save). |
| T300 | Capture baseline tests and message delivery behaviour before mutation | C | The baseline exists: `test/messaging.test.ts` (22 cases incl. thread-creation rollback at `:501`), `test/messagingOffApp.test.ts`, `test/telegraphChat.test.ts`, `test/telegraphRealtime.test.ts`, `test/telegraphStreamEndpoints.test.ts`, `test/callSystem.test.ts`. |
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
| T311 | Non-member reads conversation → **DENY** | C | `routes/messaging.ts:1558-1568` re-checks active membership on every read and returns 403 before any message query; `migrations/2070_rls_hardening.sql:11` lists `message_thread_members` among the hardened tables; `test/rlsPrivacy.test.ts`, `test/accessControl.test.ts`. |
| T312 | Removed member reads future sequence → **DENY** | C | Achieved by a blunter rule that is strictly stronger: `.is('left_at', null)` (`routes/messaging.ts:1563`) denies a departed member the *entire* thread, not merely future messages. There is no sequence, but the required outcome holds. |
| T313 | New member reads pre-membership history without policy → **DENY** | W | **Expected DENY, actual ALLOW.** The read path has no `joined_at` bound (T211). This is the single clearest divergence in the census. |
| T314 | Blocked sender sends DM → **DENY** | W | Denied on the happy path (`routes/messaging.ts:1786-1790`, fail-closed `isBlockedBetween`) — but the membership read that decides whether to consult the guard drops its error (`:1781`), so a transient read failure yields ALLOW (T220). PR #472 closes it. |
| T315 | Expired exact location read → **DENY** | C | `requireSafeReturnRecipient` runs as middleware before the handler (`routes/safeReturn.ts:660-661`), coordinates never leave `toPublicSession` (`:22`), and `expired` is a terminal session status (`baseline:10520`). |
| T316 | Availability audience excludes viewer → **DENY** | C | `migrations/2260_availability_windows.sql:44-49` — RLS enabled, owner-only SELECT of their own rows, **no cross-user read policy at all**, and service-role-only writes so `source` and `visibility` cannot be self-set through PostgREST. A viewer reaches another traveler's window only through the projection, which re-checks explicit-source + active + visibility together. |
| T317 | Private Memory source shared without derivative authorization → **DENY** | N `∅` | Vacuous: no Memory share path exists (T117), so the case cannot arise and nothing guards it. |
| T318 | Authorized user reads current safe share projection → **ALLOW** | N | There is no share projection to read (T44). The positive case has no implementation. |
| T319 | Trip member loses Trip membership → capabilities downgrade **immediately** | W | The effect is right and the timing is not guaranteed: `services/groupChatSync.ts:9-13` reconciles `message_thread_members` on membership change and reads then deny (`routes/messaging.ts:1563`) — but the sync is invoked fire-and-forget from the membership routes, and there is no capability object to downgrade (T207). |
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
| T333 | Edit while translation/transcript is generating | W | The ordering hazard is handled and tested — `markTranslationsPending` on edit (`routes/messaging.ts:2399`) plus `test/retranslateGate.test.ts`, `test/contentTranslationInvalidation.test.ts`, `test/commentTranslationInvalidation.test.ts` — but as unit coverage of the gate, not as an adversarial race fixture. |
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
| T344 | No silent catch converts a schema/permission failure into a plausible empty inbox/context | W | The ratchet exists and is on point — `test/silentSchemaErrorCatches.test.ts` and `scripts/checkSilentSupabaseWrites.ts` — but **the messaging tree still contains instances**, four of them in one file: `routes/messaging.ts:1560` (membership read, error dropped), `:1781` (block-guard membership read, error dropped — the T220 hole), `:1609` (translation read, error dropped), `:2668` (save membership read, error dropped). PR #460 exists for exactly this class and is unmerged. |
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
| T352 | realtime reconnect recovery — no lost confirmed messages | C | Guaranteed architecturally rather than measured: the canonical row is committed and the 201 returned (`routes/messaging.ts:1846`, `:1996`) before any realtime publish (`:2018`), and the client's polling path is the source of truth (`routes/telegraphStream.ts:13-15`, `lib/telegraphEvents.ts:15-16` — *"any missed event self-heals on the next poll"*). A dropped SSE event cannot lose a confirmed message. |
| T353 | share-revocation latency — fast enough to prevent stale authorization bypass | N | Revocation does not exist, so latency is unbounded (T46). |
| T354 | successful coordinated real-world actions — the primary product outcome metric | N | Nothing measures outcomes. Telegraph has **no telemetry sink at all** — no analogue of the Wall's `wall_telemetry_events`. |

### §29 Non-Negotiable Developer Invariants

| id | Invariant | V | Evidence |
| --- | --- | --- | --- |
| T355 | No AI, translation, transcription, maps or push dependency in the core message-delivery path | C | The row is inserted (`routes/messaging.ts:1846`) and the 201 sent (`:1996`) before translation (`:2037`), tagging (`:1962`), notification (`:1975`) and realtime (`:2018`), every one of which is fire-and-forget with its own net; `services/messageTranslation.ts:11` — *"never throws."* Delivery cannot be blocked by any of them. |
| T356 | No exact location without explicit purpose / audience / precision / expiry authorization | W | Three of four are enforced (audience `allowed_member_ids`, precision `visibility_level`, expiry `expires_at NOT NULL`, `baseline:10511-10521`) and exact coordinates never leave the API at all (`routes/safeReturn.ts:22`). **Purpose is not bound to a share row** (T215) — the registry exists separately and nothing joins them. |
| T357 | No stale location labeled live | C | Staleness is a stored, enforced property: `circle_presence.stale_after_secs` / `is_stale` / `expires_at` (`baseline:4468-4471`), recomputed on read (`routes/circle.ts:920`, `:936` `const isStale = Boolean(effectivePresence?.is_stale)`), and `trip_crew_location_sessions.status` has `expired` as a terminal CHECK value. |
| T358 | No private canonical Memory exposed through a Telegraph share | N `∅` | Unguarded absence — no Memory share path exists to leak through, and nothing would refuse one (T117). |
| T359 | No source-object revocation bypass via a cached Telegraph card, search or Compass | W | **Violated at the card.** Shared cards are frozen JSON re-rendered forever with no re-authorization (`components/DiscoveryCardMessage.tsx:37-45`, `PostCardMessage.tsx` — no fetch at all). It holds for Compass, where a report invalidates the reporter's cache (`routes/messaging.ts:2626`, `:2723`), and vacuously for search (T272). |
| T360 | No direct mutation of canonical Trip/Plan/Event/Buddy terms from message prose — **the spec's Primary Invariant** | C | Enforced three ways, not merely unviolated. (a) Structural: `routes/messaging.ts` writes only messaging tables plus `reports`; no domain write exists in the messaging tree (T288). (b) Type-level: `routes/telegraphCommands.ts:57` makes an unconfirmed `ProposedAction` unrepresentable, and `:390` re-verifies trip membership at execution rather than trusting the proposal. (c) Active policing of prose that tries: the off-app solicitation detector (`routes/messaging.ts:1873-1940`) treats term renegotiation in chat as an abuse signal with auto-suspension. |
| T361 | No semantic ID substitution across domains | C | Guarded by standing ratchets (`scripts/checkSchemaReferences.ts`, `scripts/checkEnumLiterals.ts`, `scripts/checkMissingLiveColumns.ts`) and locally by the routes: `routes/messaging.ts:1834-1844` refuses a `replyToId` that belongs to a different thread *"(prevents cross-thread metadata exposure)"*, and `:2668-2677` refuses a cross-thread save. |
| T362 | No group-add operation that leaks prior DM history | W | Violated for the group case that exists (T211: a trip/circle member added by `groupChatSync` reads the whole back history) and vacuous for the DM case, which has no operation (T212). |
| T363 | No silent schema failures that become plausible empty state | W | The right ratchet exists (`test/silentSchemaErrorCatches.test.ts`, `scripts/checkSilentSupabaseWrites.ts`) and the messaging tree is one of the places it has not finished: four dropped-error reads in `routes/messaging.ts` (`:1560`, `:1609`, `:1781`, `:2668`), one of which disables a block guard (T220). |
| T364 | No hidden client-side authorization replacing server policy | C | The client *does* compute an affordance gate over a raw table (`app/messages/[id].tsx:1260-1266`, T295), but it **replaces nothing**: every route re-derives authorization server-side and ignores the client entirely (T208). No server decision anywhere reads a client-supplied permission. |
| T365 | No derived translation or transcript overwriting original content | C | The original stays in `messages.body` and translations live in their own per-recipient rows (`baseline:7534-7546`); the read path returns `originalBody` alongside `displayBody` with an explicit `canShowOriginal` (`services/messageTranslation.ts:31-38`); an edit invalidates rather than merges (`routes/messaging.ts:2399`). |
| T366 | No automatic Memory creation from private conversation history | N `∅` | Unguarded absence: no conversation→Memory path exists, and nothing would refuse one. |
| T367 | No Nearby exposure merely because GPS indicates physical proximity | N `∅` | Unguarded absence: there is no Nearby. `presence/domain/types.ts:50` declares the right ceiling for the concept (`bump: "zone"`) and is interface-only, consumed by nothing in Telegraph. |
| T368 | Blocked relationships never reappear through Nearby, Compass, Bump or shared-memory suggestions | W | Compass and shared-memory are genuinely enforced (`compass/CompassTools.ts:1183` `refreshHiddenUsers` on every social tool; `test/memoriesBlockFailClosed.test.ts`). Nearby and Bump have no referent. And the guarantee is not absolute while the send path can skip its block guard on a read error (T220). |
| T369 | Derived projections are rebuildable from canonical state + events | W | The half that exists is fully rebuildable — both projections are computed per request from canonical tables and cache nothing (`routes/messaging.ts:1332`, `:1550`), which is stronger than "rebuildable". But there are **no events to rebuild from** (T195), and four of the six named projections do not exist. |

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
| T379 | **§30A.1** Canonical `TelegraphRelationship` model so eligibility, calling, Nearby, location, invitations and temporary connections do not independently infer relationship state | W | **The anti-pattern is exactly what exists.** Relationship is independently inferred by at least four resolvers with different vocabularies: `lib/messagingPermissions.ts:38-45` (friend / follower / following / trip / circle), `services/interactionPermissions.ts:597-632`, `lib/calls/callPermissionEngine.ts` via `whoCanCall` (`test/callHardening.test.ts:31` `'people_i_message'`), and `compass/CompassTools.ts:831` `sharesSocialContext`. Each is correct; none is canonical. |
| T380 | Origins FOLLOW/MUTUAL_FOLLOW/TRIP/CREW/EVENT/BUMP/NEARBY/BUDDY/PLAN/MANUAL; states REQUEST_ONLY/ACTIVE/TEMPORARY/RESTRICTED/BLOCKED/EXPIRED | N | Neither vocabulary exists in any form. |
| T381 | Relationship policy is an **input** to ConversationPolicy, not a replacement for block, age, safety, membership or object authorization | W | The "not a replacement" half is structurally honoured — `services/interactionPermissions.ts:597-632` folds blocks, trust restrictions and age in *alongside* the relationship term rather than deriving them from it, and every route re-checks membership independently (T208). The "input to ConversationPolicy" half has no referent (T207). |
| T382 | **§30A.2** Server-built `ReachablePersonProjection` combining relationship, availability, permitted proximity, shared context, privacy and safety | N | No such projection. |
| T383 | Nearby is geographical, availability temporal, reachability contextual; clients must not recompute this eligibility from raw tables | W | Messaging eligibility *is* server-computed (`services/interactionPermissions.ts`), but the client recomputes thread membership from a raw table (`app/messages/[id].tsx:1260-1266`, T295), and reachability as a concept does not exist. |
| T384 | Availability never implies permission to call, bypass message requests, expose exact location or access private plans | C | Enforced by four independent gates, none of which takes availability as an input. Calling: `routes/calls.ts:17-20` authorizes only through `callPermissionEngine`. Requests: `lib/messagingPermissions.ts:29-45`. Location: a separately granted scoped session (`baseline:10511-10521`). Plans: trip/circle membership. And availability windows have **no cross-user read policy at all** (`2260:44-49`), so availability cannot even be observed without going through the projection. |
| T385 | **§30A.3** Text editing with an Edited marker and internal version history; editing never mutates a canonical object | W | Marker yes (`routes/messaging.ts:2369`), history no (T80). The non-mutation half is fully correct (T81). |
| T386 | Model UNDO_SEND, UNSEND_BEFORE_SEEN, DELETE_FOR_ME, DELETE_FOR_EVERYONE, REMOVE_ATTACHMENT, SOURCE_OBJECT_REVOKED and ACCOUNT_DELETED as **distinct** operations | W | Two of seven. `DELETE_FOR_EVERYONE` is `routes/groupChat.ts:340-381`. `ACCOUNT_DELETED` is genuinely and carefully modelled as its own operation by the deletion programme — `lib/deletionDispositions.ts:370-441` is a per-table ledger, and `migrations/2139_shared_content_tombstones.sql:26-37` tombstones `messages.sender_id` with `SET NULL` rather than cascading, precisely so *"a conversation has two sides"* and a bystander keeps their reply. The other five do not exist. |
| T387 | `UNSEND_BEFORE_SEEN` is race-safe and server-authoritative; in groups it succeeds only while no eligible recipient has seen the message | N | Absent (T75–T77). Implemented in PR #472, unmerged, CI-only. |
| T388 | Deleted and unsent content removed from normal search, Compass retrieval, inbox projections and content drawers per the operation's semantics | W | Inbox/read suppression is real (`routes/messaging.ts:1717`) and Compass is invalidated on report (`:2723`). Media survives deletion in main (T79); there is no search (T272) or drawer (T66) to remove from. |
| T389 | **§30A.4** Membership records include `joined_at`, `left_at`, `removed_at`, `visible_from_sequence`, `visible_until_sequence`, `role` | W | Three of six (`baseline:7496-7504`): `joined_at`, `left_at`, `role`. No `removed_at` (a removal is indistinguishable from a voluntary leave) and no sequence bounds (T210). |
| T390 | New members do not automatically gain pre-membership history; adding a third person to a direct conversation creates a new group | W | The first clause is **violated** (T211, T313); the second is vacuous because no add-to-DM operation exists (T212). |
| T391 | Roles OWNER, ADMIN, HOST, MEMBER, GUEST with capability-based authorization for invitations, removals, pins, announcements, group settings and shared operational state | W | Two of five roles (`role` CHECK `member\|admin`, `baseline:7504`) and **none** of the six capabilities: there is no invite, remove, pin, announce or group-settings operation on a thread at all. |
| T392 | **§30A.5** An `ANNOUNCEMENT` message/object type | N | Does not exist (T58). |
| T393 | Seen and Acknowledged are separate concepts | N `∅` | Unguarded absence: there is no acknowledgement, so `last_read_at` is the only signal and nothing distinguishes them. |
| T394 | Do not overload passive read receipts to represent acceptance, agreement or acknowledgement | C | Honoured, and not by accident: `last_read_at` feeds only unread counts (`routes/messaging.ts:915-960`), while every consent-shaped act has its own explicit object — `message_requests.status`, `meetup_invites.status`, and `confirm-action` / `decline-action` (`routes/telegraphCommands.ts:390`, `:445`). No path infers agreement from reading. |
| T395 | **§30A.6** Notification causes MESSAGE, MENTION, PLAN_CHANGED, INVITATION, COORDINATION, LOCATION, CALL, SAFETY | W | Seven of eight exist under a richer taxonomy of 13 categories and ~80 event types (`services/notifications/NotificationTemplateService.ts:14-16`): `telegraph.message`, `telegraph.mention` (`:651`), `plan.item_updated`, invitation events, the `location` category (`:282-306`), `call.incoming` (`:186`) and `safe_return.*`. **COORDINATION has no cause** — as expected, since coordination does not exist (T85). |
| T396 | Priority ladder P0 SAFETY / P1 ACTIVE_COORDINATION / P2 DIRECT_OR_MENTION / P3 PLAN_OR_TRIP / P4 NORMAL_GROUP / P5 REACTION_OR_PASSIVE | W | Four levels, not six (`NotificationTemplateService.ts:19`), and only `urgent` produces different behaviour (T254–T259). The ladder's ordering is approximated by category, not modelled. |
| T397 | Deduplicate by underlying causal event; one Plan change must not create redundant Plan, Trip, Telegraph and Compass notifications | W | A dedup service exists and is correct for one case only: `services/notifications/NotificationDeduplicationService.ts:42-45` coalesces `telegraph.message` by `sourceId`. There is no causal-event identity shared across categories, which is exactly the redundancy the requirement names. |
| T398 | Thread notification policy ALL / MENTIONS / IMPORTANT / temporary mute / MUTED; safety-critical delivery governed by safety policy rather than ordinary mute | W | Two of five, but the second is the important one and it is exactly right: `MUTED` (`message_thread_members.muted_at`, `routes/messaging.ts:2538`) and the safety override — `services/notifications/NotificationPreferenceService.ts:6-7`, *"Safety override: urgent + admin priority always deliver even when push is off"*, with a stored `safety_override` flag (`:59`). No ALL/MENTIONS/IMPORTANT selector, no temporary mute. |
| T399 | **§30A.7** `TelegraphDevice` registry: platform, push, voice/video, proximity, background-location capability, trust state, last activity | W | A registry exists for a different purpose and carries one of the seven fields: `routes/devices.ts:1-16` registers `platform` and an Ed25519 MLS identity key per install. No capability flags, no trust state, no last-activity. |
| T400 | Precise location sharing is device-specific and must not silently transfer to a newly authenticated device | N | Both location stores are keyed by `user_id` with no device column (`baseline:7109`, `:10509`), so a live share follows the account (T235). The device registry that exists is never consulted by a location path. |
| T401 | Device revocation terminates realtime sessions, invalidates location capabilities and proximity identities, stops push, rotates credentials — without destroying conversation history | W | **One fifth is genuinely well built.** Realtime termination exists end-to-end: `lib/telegraphEvents.ts:47` `access.revoked`, `registerTerminator` / `terminateUserConnectionsLocal`, a cross-instance terminate hook in `lib/telegraphBroadcast.ts:33`, and a 30-minute max connection age so *"revoked sessions … cannot hold open an indefinite connection"* (`routes/telegraphStream.ts:35-40`). Location capabilities and push are not device-scoped, credentials are not rotated, and there is no device-revocation endpoint. |
| T402 | **§30A.8** Uploads pass quarantine, file-type verification, security scanning, metadata policy, transcoding and approved-asset publication; **never trust a client-provided MIME type** | W | Four of six, and the emphasized clause is **fully and unusually well satisfied**. `lib/mediaPipeline.ts:186-226`: `sniffMedia(buf)` reads magic bytes; the size ceiling comes from the **sniffed** kind, not the declared one (`:199`); a declared/actual mismatch is refused outright (`:216-222`); and the module states the rule as policy — *"A declared type is a hint, never a fact"* (`:71`) — with a documented history of the drift that made it necessary (`:20-38`). Metadata policy and transcoding: `lib/mediaProcessing.ts:154-166`. **Quarantine and security scanning do not exist.** |
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
| T418 | **§30A.13** Private policy signals — request acceptance, spam reports, block rate, burst, duplicate-message, malicious-link — constrain abuse and are **never** exposed as a public messaging score | W | The privacy clause is fully honoured: `trust_profiles.overall_score` is consulted as a floor and never returned to any caller (`compass/CompassTools.ts:835-843`, with a uniform "not available" answer that never confirms why), and restrictions are resolved server-side (`services/trust/TrustRestrictionService`). Of the six named signals only reports and restriction state feed it — no burst detection (T279), no duplicate-message signal (T231), no malicious-link signal (T281). |
| T419 | New accounts receive gradual outreach capabilities; Nearby must never become mass-DM infrastructure | W | The gradual half is real for the *request* step, where account state and trust restrictions gate eligibility with a fail-closed degraded path (`routes/messaging.ts:430-560`, six tests at `test/messaging.test.ts:519-631`). Sends themselves are unrestricted (T279), and the Nearby clause is vacuous. |
| T420 | Proximity defenses: coarse distance buckets, update throttling, privacy-zone suppression, purpose-bound access, no historical proximity endpoint | W | One of five, and it is real: **no historical proximity endpoint exists**, and `trip_crew_location_sessions` structurally cannot become one — it keeps a single `last_location_snapshot_id` (`baseline:10519`), not a trail. The other four have no referent in Telegraph. |
| T421 | BLOCK overrides Nearby in both directions; Unavailable/Invisible promptly revokes Nearby, Discovery and Compass availability projections | W | Bidirectionality is real and checked both ways (`routes/blocks.ts:275-276`), fail-closed (`lib/blockGuard.ts`), and Compass re-derives hidden users on every request rather than caching (`compass/CompassTools.ts:1183` `refreshHiddenUsers`) — which is the "promptly" the rule asks for. Nearby and Invisible have no referent (T29). |
| T422 | **§30A.14** Accessibility as an architecture requirement: screen-reader labels, dynamic type, reduced motion, high contrast, captions/transcripts, non-colour-only status, large touch targets, accessible alternatives for maps, waveforms, video, proximity and coordination | W | Two of eight in the Telegraph tree: non-colour status (T133) and text-first proximity (T137). Reduced motion is not applied (T134), captions do not exist (T136), and the rest is absent. The tree's own precedent shows this is a Telegraph gap, not a platform one: the Wall implements reduced motion and proves it four ways. |
| T423 | **§30A.14** i18n: RTL layouts, locale-sensitive timestamps, 12/24-hour clocks, pluralization, Unicode names/handles, long translations, mixed-language threads, destination/user timezone semantics | W | Two of eight, and Telegraph got the two that are hardest: **mixed-language threads are fully solved per recipient** (T145, T241 — original preserved, per-recipient translation, honest failure status) and Unicode handles work. **There is no RTL support anywhere in the client** — a repo-wide search for `I18nManager` / `isRTL` returns nothing. Timestamps use hand-rolled formatters, not a locale API (`app/messages/[id].tsx:82-99`). |
| T424 | Timezone and date-line behaviour must be covered by automated tests | C | For the one timezone-sensitive computation Telegraph performs — the conversation's day dividers — it is, and the test is written against exactly the date-line hazard: `travel-buddy-standalone/src/utils/localDate.test.ts:6-12` constructs a late-evening local instant and asserts the local day, noting *"`toISOString().slice(0,10)` would roll this to 2026-08-30 at any positive UTC offset."* Consumed by `app/messages/[id].tsx:20`. |
| T425 | **§30A.15** Truthful ONLINE / POOR_CONNECTION / OFFLINE / RECONNECTING; distinguish local unsent, server accepted, recipient offline, receipt unavailable | N | No connection-state model and no send-state model. The SSE client reconnects but exposes no state, and there is no local-unsent representation (T230). |
| T426 | Storage tiers for thumbnails, streamable media, originals, archival and deletion; temporary precise-location has a much shorter lifecycle than ordinary media | W | The **location half is genuinely right**, and it is the half the rule emphasises: location sessions carry mandatory expiry with an `expired` terminal state (`baseline:10512,10520`) and `location_sessions.expires_at`, while message media has no expiry at all — the asymmetry the rule demands exists. The media-tier half does not (T222). |
| T427 | Canonical conversations and messages survive loss of realtime caches, search indexes, translations, notification queues, AI artifacts and read projections | C | All six are strictly derived and none is on the write path. Realtime: in-memory, failures swallowed by design (`lib/telegraphEvents.ts:14-16`). Search index: none. Translations: separate rows with a `failed` status that never throws (`services/messageTranslation.ts:11`). Notifications: `Promise.allSettled` inside a non-fatal try (`routes/messaging.ts:1975-1990`). AI artifacts: their own table. Read projections: a single nullable timestamp, with an explicit fallback when the column itself is missing (`routes/messaging.ts:940-943`). |
| T428 | `ConversationProjection`, `InboxProjection`, `SharedContextProjection`, `ContentIndexProjection`, `SearchIndex` and seen-state derivatives are rebuildable from canonical state and events | W | The two that exist are stronger than rebuildable — computed per request from canonical tables, caching nothing (`routes/messaging.ts:1332`, `:1550`). Four do not exist, and there are no events to rebuild from (T195). |
| T429 | **§30A.16** Versioned structured-message schemas `place.share.v1`, `event.share.v1`, `trip.share.v1`, `memory_note.v1`, `location.scope.v1`, `coordination.status.v1` | N | None exists; card payloads are unversioned JSON in `body` (T157). The convention **is** practised elsewhere in the same tree — `schemaVersion` appears in intel and passport telemetry envelopes (`test/intelObservability.test.ts:406`, `test/passportTelemetryIngest.test.ts:142,268`, which even rejects an unknown version) — so this is a Telegraph omission, not a missing platform capability. |
| T430 | Unknown future message types render a **safe generic fallback** on older clients rather than crashing or silently disappearing | W | Two thirds. A fallback does exist and nothing crashes or disappears: an unknown `msg_type:'system'` subtype falls to the centred pill (`app/messages/[id].tsx:1892-1898` → `components/TelegraphSystemNotice.tsx:16`) and an unknown `msgType` falls through every branch to `MessageBubble` (`app/messages/[id].tsx:1899`). It is not **safe**: because structured payloads live in `body` as raw JSON (T157), both fallbacks render the payload as literal text, so an unrecognised structured message shows the user its JSON. |
| T431 | Client capability negotiation when an interaction requires a minimum supported schema or action version | N | No version negotiation of any kind. |
| T432 | **§30A.17** Measure delivery latency, failed sends, unsend outcomes, seen convergence, media processing, plan conversion, coordination success, Nearby→conversation, conversation→plan and completed real-world outcomes | N | None of the ten is measured. Telegraph has no telemetry sink at all — no analogue of the Wall's `wall_telemetry_events` (T354). |
| T433 | Do not indiscriminately copy private message text into analytics | C | Actively honoured with concrete artifacts, not merely by the absence of analytics. `services/messageTranslation.ts:13` — *"Privacy: never logs full message body. Only message_id, status, codes."* The one place message text is ever persisted outside `messages` is the off-app abuse excerpt, capped at 120 characters and explicitly tagged `visibility: 'admin_only'` (`routes/messaging.ts:1900`). The north-star half of this bullet is counted separately at T1 and T354. |
| T434 | SLOs for message acceptance, realtime delivery, offline recovery, seen convergence, block enforcement, location revocation, media availability and projection freshness, with safety/privacy strictest | N | No SLO definitions exist for any of the eight (T346–T354). |
| T435 | Internal support tooling exposing delivery and projection diagnostics, event ids, conversation ids and authorized moderation context under purpose-scoped access with audit logging | W | The moderation half exists and is guarded — `routes/moderation.ts`, `routes/admin.ts`, `routes/appeals.ts`, with `scripts/checkAdminGuard.ts` as a standing CI guard and admin-only visibility tagging on abuse events (`routes/messaging.ts:1900`). The diagnostics half does not: no delivery diagnostics, no projection diagnostics, and no event ids to trace with (T195). |
| T436 | **§30A.18** A Telegraph replay simulator permuting send, disconnect, unsend, reconnect, member removal, location expiry, plan changes, blocking, translation completion and media completion, verifying deterministic final state | N | No replay harness — and nothing to replay: there is no event log (T195) and no snapshot table (T155). |
| T437 | Property tests: permission monotonicity, precision monotonicity, removed participants, block, temporary-scope expiry | N | None exists for Telegraph (T321–T327). The tree's one genuine property test of this family guards a different module (`test/presenceDomain.test.ts:79-83`). |
| T438 | Live-DB contracts verify columns and enum literals against the actual schema and verify RLS role behaviour; **schema/permission failures must never be swallowed into plausible empty inboxes** | W | The first half is fully built and is the strongest area in the census (T340–T343, T345). The emphasized half — the one clause in the whole addendum that names an inbox — is the clause that still fails: four dropped-error reads in `routes/messaging.ts` (`:1560`, `:1609`, `:1781`, `:2668`), one of which silently disables a block guard (T220, T344). PR #460 exists for this class and is unmerged. |
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
| T450 | Derived Telegraph projections are rebuildable; caches and indexes are never the sole authoritative copy | C | Nothing derived is authoritative anywhere on the server: the realtime bus is in-memory and lossy by design (`lib/telegraphEvents.ts:14-16`), translations are derived rows that never replace the original (T365), read state degrades to a documented fallback when its column is missing (`routes/messaging.ts:940-943`), and both projections are recomputed per request from canonical tables (T369). |
| T451 | **§31** Five responsibilities: transport · Context Kernel · policy · action orchestration · outcome loop | W | Three of five exist as identifiable layers — transport, policy and action orchestration (T440). The **Context Kernel** does not exist (T439) and the **outcome loop** does not close: nothing measures a coordinated real-world outcome (T354) and nothing returns one to Memory (T119, T121). |

---

## 7. What could not be verified (3)

Counted honestly in their own bucket and never folded into either side.

| id | § | Why construction cannot settle it |
| --- | --- | --- |
| T61 | 6.3 | Inline video playback controls — poster, play/pause, scrub, mute, fullscreen, captions. `components/MessageMediaBubble.tsx:170` mounts an autoplay-capable player, but scrub/mute/fullscreen/caption behaviour belongs to the shared player and is a device property. |
| T71 | 7.2 | "Push delivery, app launch and background rendering do not count as seen." **The server cannot know.** `POST /threads/:threadId/read` (`routes/messaging.ts:1202`) accepts no evidence of foreground visibility and stamps `last_read_at` on any authenticated call. The client calls it from a mount effect on thread open (`app/messages/[id].tsx:1269-1273`, *"Mark thread as read when the user opens it. Fire-and-forget."*), which is the right intent but fires on mount rather than on visible render, and nothing enforces it server-side. This is a *design* gap as much as a verification one — the requirement is not checkable because the protocol carries nothing to check. |
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
   table instead (`routes/messaging.ts:2626`, `:2708`). Their migrations are
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
   checked fail-closed on every send (`routes/messaging.ts:1750-1754`), which is
   good; there is no per-user send limit at all (T279).
7. **Writer-attribution caveat, inherited.** `scripts/checkWriterlessReads.ts:39-41`
   declares that a dynamic `.from(expr)` anywhere makes writer attribution
   INCOMPLETE and that the check errs toward silence. Every "nothing
   writes/reads X" claim above was settled by reading call sites, and the tree's
   two dynamic `.from(table)` sites (`services/media/MyWorldMemoryService.ts:614`,
   `services/media/MediaProjectionService.ts:1182#const { data } = await (sc as any).from(table).select("*").eq(ownerCol, ownerId).limit(1000);`) were opened and confirmed to be
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
  `routes/index.ts:187#telegraphSharedContextRouter` uses.
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
| T13 | N | **C** | **Rail at the top of each conversation showing mutually relevant objects** — The component exists and is mounted on BOTH conversation surfaces — `travel-buddy-standalone/app/messages/[id].tsx:2089#SharedContextRail` and `travel-buddy-standalone/src/components/GroupChatScreen.tsx:815#SharedContextRail` — between the header and the message list, fed by a mounted route (`routes/index.ts:187#telegraphSharedContextRouter`). What would turn this red (P24): a third conversation surface appearing without it; nothing pins that. |
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
  (`services/telegraph/shareables.ts:97#TelegraphShareable`) declares
  `getSharePreview` / `getCurrentState` / `getAvailableActions` /
  `getDeepLink`, and `shareableFor`
  (`services/telegraph/shareables.ts:960#shareableFor`) returns one for any of
  fifteen object types across §5's five families —
  `services/telegraph/shareables.ts:950#SHAREABLE_OBJECT_TYPES`. A family with
  no loader returns `null`, and the resolver answers `not_found` rather than
  inventing a card: an unknown family must not silently become a live
  reference.
- **§5.2's third layer is the whole point, and it is computed per read.**
  `resolveShareProjections`
  (`services/telegraph/shareables.ts:1044#resolveShareProjections`) takes a
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
  (`services/telegraph/shareables.ts:452#loadMemory`) grants `public`, an
  explicit `allowed_user_ids` entry, or ownership, and degrades
  `friends_only` / `trip_crew` / `circle_only` to `private`. Guessing at a
  relationship read owned by the Memories surface is exactly the backdoor §5.3
  forbids, so the ladder stops where this module's knowledge stops
  (`test/telegraphShare.test.ts:363`).
- **The envelope is a REFERENCE.** `PortavaObjectBody`
  (`services/telegraph/shareables.ts:1122#PortavaObjectBody`) carries five
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
  batch resolve. Both mounted at `routes/index.ts:188#telegraphShareRouter`.
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
| T41 | N | **C** | **`TelegraphShareable` interface — `getSharePreview` / `getCurrentState` / `getAvailableActions` / `getDeepLink`** — all four methods exist under those names (`services/telegraph/shareables.ts:97#TelegraphShareable`) and are implemented for fifteen object types (`:960#shareableFor`), asserted family by family at `test/telegraphShare.test.ts:252`. |
| T44 | N | **C** | **Four-layer model: Share projection — what the recipient is *currently* authorized to see** — the layer exists and is computed per (viewer, object) on every read (`services/telegraph/shareables.ts:1044#resolveShareProjections`); the card is no longer whatever the sender serialised. |
| T46 | W | **C** | **Revocation: a deleted/private/unauthorized source degrades to unavailable; never a backdoor into revoked content** — the violation is closed on both ends. Server: an unavailable reference carries `projection: null` and `actions: []`, proved by the assertion that the deleted post's own words do not appear anywhere in the serialised response (`test/telegraphShare.test.ts:324`). Client: the two cards that WERE frozen snapshots now re-resolve and degrade (`travel-buddy-standalone/src/features/telegraph/__tests__/shareRevocation.component.test.tsx:134`, `:165`). |
| T43 | W | **C** | **Four-layer model: Source object** — a reference is now a RESOLVED reference, not a payload field: the envelope carries only `(objectType, objectId)` (`services/telegraph/shareables.ts:1122#PortavaObjectBody`) and the renderer dereferences it through the registry. The census's objection — "a payload field, not a resolved reference … nothing dereferences it at render" — is answered by `travel-buddy-standalone/src/features/telegraph/sharing/PortavaObjectMessage.tsx:28#PortavaObjectMessage`. |
| T55 | W | **C** | **Message kind PORTAVA_OBJECT** — it is now a typed kind, not `system` plus a bespoke subtype: the route writes `msg_type='portava_object'` (`routes/telegraphShare.ts:80#/threads/:threadId/share`), `messages.msg_type` carries no CHECK so this needs no migration (`baseline/20260819_baseline_structure.sql:7565`), and both conversation surfaces dispatch it. |
| T35 | W | **W** | **One consistent share contract for all eligible Portava content** — the contract now EXISTS and fifteen types implement it, which is the half that was missing. It stays W because the four legacy producers the census named still write their own bespoke JSON (`discovery_card`, `post_card`, `compass_card`, `circle_status_card`): the new cards are revocable, but they are revocable by MAPPING the old payload, not by the old producers having moved to the contract. One contract plus four legacy shapes is not yet one shape. |
| T36 | W | **W** | **Object family Social — profile, post, Highlight, public Memory derivative, Memory Note, Stamp** — profile, post and Memory are now shareable through the contract (`services/telegraph/shareables.ts:950#SHAREABLE_OBJECT_TYPES`). Highlight and Stamp have no loader and `STAMP` is not in the registry, so three of six. |
| T37 | N | **W** | **Object family Travel — Trip, Trip stage, plan, event, route, reservation-safe derivative, layover plan** — was "none of the seven is shareable into a thread"; four now are (TRIP, TRIP_STAGE, PLAN/MEETUP, EVENT), each with its own authorization read. Route, reservation-safe derivative and layover plan have no loader. |
| T38 | W | **W** | **Object family Places — place, Hidden Gem, map pin, neighborhood, meetup point** — place, gem, map pin and meetup point resolve through the contract; NEIGHBORHOOD is in the vocabulary and deliberately has no loader, so `shareableFor` returns null for it rather than pretending (`test/telegraphShare.test.ts:295`). Four of five. |
| T39 | W | **W** | **Object family Services — Buddy profile/service, eligible booking card, Visa Buddy operational card** — the booking card now resolves with its two-party authorization (`services/telegraph/shareables.ts:960#shareableFor`), and BUDDY_SERVICE maps to the same loader. There is no Visa Buddy card and no standalone Buddy profile share. |
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
  `validateKindMessage` (`services/telegraph/messageKinds.ts:181#validateKindMessage`)
  turns a (kind, payload) pair into the row that will be written — `msg_type`
  from the kind, `subtype` from the kind's own discriminator (SAFETY's four
  classes, LOCATION's precision, ACTION's action name).
  `SENDABLE_ENVELOPE_KINDS` (`:136#SENDABLE_ENVELOPE_KINDS`) is the seven;
  `UNSENDABLE_KINDS` (`:143#UNSENDABLE_KINDS`) is every other §6.2 kind with
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
  `drawerTabFor` (`services/telegraph/messageKinds.ts:253#drawerTabFor`) routes
  each row to one of §6.4's seven tabs
  (`services/telegraph/messageKinds.ts:240#DRAWER_TABS`), including the legacy
  `discovery_card` / `post_card` producers, so an OLD card is indexed too. The
  route writes nothing and says so in its own response (`indexOnly: true`).
- **§6.4's search is object-aware, and its authorization is not new law.**
  `searchableTextOf` (`services/telegraph/messageKinds.ts:308#searchableTextOf`)
  returns null for a deleted row and for an unsent one (on a database that has
  the column), which is §7.4's "remove from normal retrieval, search and
  projections"; and it searches a typed envelope's HUMAN fields — label, title,
  caption, note — never its ids and urls, which is what "object-aware" buys
  over a LIKE over `body`.
- **Both surfaces inherit §14.3.** `memberWindow`
  (`routes/telegraphKinds.ts:85#memberWindow`) resolves the caller's history
  bound through `services/groupChatHistoryBound.ts` — the one module that owns
  that rule — and `readIndexableRows` (`routes/telegraphKinds.ts:139#readIndexableRows`)
  applies it in the query AND in a post-filter. A member added yesterday cannot
  reach last month's photos through the drawer or find them by searching
  (`test/telegraphKinds.test.ts:489`, `:515`).
- **The write gates are shared, not re-implemented.**
  `lib/telegraphThreadWrite.ts:36#guardTelegraphThreadWrite` holds the four
  checks the ordinary send path applies — kill switch, active membership, 1:1
  block guard, E2EE refusal — and the §5 share route and the §6.2 typed-kind
  route both call it. A second write endpoint that skipped one of them would be
  a weaker door into the same table.
- **The routes are mounted** at `routes/index.ts:189#telegraphKindsRouter`.
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
| T51 | N | **C** | **Message kind MEDIA_ALBUM** — a validated kind with at least two independent asset references in one message (`services/telegraph/messageKinds.ts:181#validateKindMessage`), sent, stored and rendered (`travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:65#TypedMessageRenderer`). One asset is refused — that is an IMAGE or a VIDEO, not an album (`test/telegraphKinds.test.ts:302`). |
| T65 | N | **C** | **Mixed-media albums: one reply target and one seen lifecycle, independent asset references** — true by construction: an album is ONE `messages` row, so it has exactly one `reply_to_id` and one position in the single thread-level receipt, and its assets are separate entries in the payload. Rendered as one bubble with N cells (`travel-buddy-standalone/src/features/telegraph/__tests__/kinds.component.test.tsx:106`). |
| T56 | N | **C** | **Message kind LOCATION** — a kind with a precision ladder whose default is COARSE (§4.3), a subtype that records which precision the sender chose, and a renderer that shows the precision in words (`travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:65#TypedMessageRenderer`). |
| T57 | N | **C** | **Message kind ACTION** — actions are no longer inferred from card subtypes: `ACTION` is a kind carrying a §8.1 action name and a `requiresConfirmation` literal `true`, rendered as a proposal with a Confirm control (`travel-buddy-standalone/src/features/telegraph/__tests__/kinds.component.test.tsx:70`). |
| T58 | N | **C** | **Message kind ANNOUNCEMENT** — a kind with a title, an optional body and an optional acknowledgement requirement, rendered with the acknowledge control only when it asks for one. |
| T54 | N | **C** | **Message kind MEMORY_NOTE** — the kind exists and carries §10.1's `MemoryNoteShare` field set (`services/telegraph/messageKinds.ts:181#validateKindMessage`), with an authoring sheet (`travel-buddy-standalone/src/features/telegraph/__tests__/typedComposeMemoryNote.component.test.tsx:41`). What is NOT claimed is T117's contract row — see below. |
| T52 | N | **C** | **Message kind GIF** — a distinct kind with its own payload (url, still frame, provider, alt text) and its own renderer, separate from IMAGE/VIDEO. No provider is configured to pick one FROM, which is T64's row and the composer entry's stated reason, not this one's: the kind exists, validates, sends, stores and renders. |
| T64 | N | **W** | **GIFs are distinct lightweight looping content with data-saver / accessibility controls** — the CONTROLS are built: `isGifAnimated` (`travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:33#isGifAnimated`) is a pure rule — animate only when neither reduced motion nor data saver is on — and the still frame carries the reason in words. It stays W because `dataSaver` is a prop with no app-level setting behind it yet, and because no provider exists to obtain a GIF from. |
| T60 | W | **C** | **Message kind SAFETY** — SAFETY is now a message KIND, not only a thread affordance: four classes (`check_in`, `heads_up`, `need_help`, `all_clear`), each landing in `subtype`, rendered with the class as a WORD and the §11.1 attention colour reserved for it (`travel-buddy-standalone/src/features/telegraph/__tests__/kinds.component.test.tsx:98`). |
| T66 | N | **C** | **Content drawer: MEDIA / PLACES / PORTAVA / VOICE / GIFS / LINKS / FILES** — the seven tabs exist with counts, served by `GET /threads/:id/drawer` (`routes/telegraphKinds.ts:262`) and rendered by `travel-buddy-standalone/src/features/telegraph/drawer/ContentDrawerSheet.tsx:52#ContentDrawerSheet`. The dead-coded entry point is now a real control (`travel-buddy-standalone/app/messages/[id].tsx:1958#telegraph-open-content-drawer`). |
| T67 | N `∅` | **C** | **The drawer is a structured index, not a second storage copy** — no longer an unguarded absence. The drawer exists and stores nothing: it classifies `messages` rows in memory (`services/telegraph/messageKinds.ts:253#drawerTabFor`), every id it returns is a `messages.id` that already existed, and the route writes nothing and declares `indexOnly: true` in its own response. |
| T68 | N | **C** | **Object-aware search respects current authorization and unsent/deleted state** — `GET /threads/:id/search` (`routes/telegraphKinds.ts:327`) is member-gated, §14.3-bounded and tombstone-excluding, and matches on a typed object's HUMAN fields rather than on raw JSON (`services/telegraph/messageKinds.ts:308#searchableTextOf`). A deleted message is not findable by its exact text (`test/telegraphKinds.test.ts:531`). |
| T47 | W | **W** | **Composer stays visually calm; rich actions live behind a `+` menu** — the menu now names all EIGHT of §6.1's entries instead of two (`travel-buddy-standalone/src/features/telegraph/composer/composerMenu.ts:48#COMPOSER_ENTRIES`), and an entry that cannot complete states its reason INLINE rather than being hidden. Five of eight are operable (Camera, Photos, Video, Location, Memory Note); GIF has no provider, Voice has no audio asset type, and Portava has no in-composer object picker. Two of eight became five of eight — better, not done. |
| T53 | N | **N** | **Message kind VOICE** — deliberately NOT moved. It is now REFUSED by name with the constraint that blocks it (`services/telegraph/messageKinds.ts:143#UNSENDABLE_KINDS`), which is honest, but a refusal is not a kind. It needs a migration widening `messages.media_type` and an audio MIME in `lib/mediaPipeline.ts:74`. |
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
  (`services/telegraph/coordination.ts:68#legalNextStates`) encodes
  PREPARING → ASSEMBLING → ACTIVE → RETURNING → COMPLETE with DISRUPTED and
  CANCELLED as the exits. DISRUPTED has outbound edges because it is
  recoverable; COMPLETE and CANCELLED have none, because §9's diagram has no
  arrow leaving either and inventing one would be this module deciding
  something the spec did not.
- **The state is DERIVED, not stored.** `derivedCoordinationState`
  (`services/telegraph/coordination.ts:110#derivedCoordinationState`) reads the
  plan's own timeline: before leave-by it is PREPARING, between leave-by and
  start ASSEMBLING, then ACTIVE, then RETURNING for two hours, then COMPLETE. A
  stored state drifts the moment an app is offline through a transition, and
  the repair would be a background job nothing in this tree runs. A plan with
  **no start time has NO state** — not PREPARING — so an undated wish cannot
  put a conversation into coordination mode
  (`test/telegraphCoordination.test.ts:286`).
- **"TEMPORARILY" is enforced.** §9 says the thread transforms *temporarily*
  near the leave-by window. `threadIsCoordinating`
  (`services/telegraph/coordination.ts:142#threadIsCoordinating`) excludes
  PREPARING for exactly that reason, and the client panel renders nothing while
  the state is PREPARING (`test/telegraphCoordination.test.ts:294`,
  `travel-buddy-standalone/src/features/telegraph/__tests__/coordinationPanel.component.test.tsx:88`).
- **§9.1's closing rule is enforced in the type and in the layout.** A quick
  state carries `provenance: z.literal("USER_DECLARED")`
  (`services/telegraph/coordination.ts:148#QuickStatePayload`), so a
  system-derived estimate is not REPRESENTABLE as a declared status — a caller
  sending `provenance: "SYSTEM_DERIVED"` is refused
  (`test/telegraphCoordination.test.ts:335`). On the client the derived state
  is the panel's title line and says *"derived from the plan"*, while declared
  statuses live under *"What people said"*; there is no row that could hold
  both.
- **§8's ConversationDecision has the three rules a naive tally gets wrong.**
  `projectDecision` (`services/telegraph/coordination.ts:243#projectDecision`)
  counts the LATEST vote per voter (a change of mind replaces, it does not
  add), RECORDS a vote cast after the deadline and does NOT count it (a
  deadline that changes nothing is not a deadline), and leaves a TIE
  **unresolved** (§8 asks for a final result; a tie does not have one). Four
  resolution rules — PLURALITY, MAJORITY, UNANIMOUS, ASKER_DECIDES — each with
  its own test.
- **§8's ConversationCommitment** (`services/telegraph/coordination.ts:373#projectCommitment`)
  answers §8's four questions — who agreed, to what, by when, and whether it
  was completed — and carries an `overdue` flag that is true only when the
  deadline passed with nothing completed.
- **§8's Rendezvous has all five properties**, not two:
  `services/telegraph/coordination.ts:166#RendezvousPayload` carries checkpoint,
  landmark, a time window, a fallback point and a coarse proximity state. There
  is deliberately no coordinate field, and a caller that sends `lat`/`lng` has
  them dropped (`test/telegraphCoordination.test.ts:562`).
- **§8.1's actions: seven carried here, seven named as owned elsewhere.**
  `COORDINATION_ACTIONS` (`services/telegraph/coordination.ts:570#COORDINATION_ACTIONS`)
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
  `routes/index.ts:190#telegraphCoordinationRouter`.
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
| T102 | N | **C** | **State machine PREPARING → ASSEMBLING → ACTIVE → RETURNING → COMPLETE ↘ DISRUPTED/CANCELLED** — the machine exists, its arrows are §9's arrows, its terminal states are terminal, and its current value is derived from the plan's own timeline (`services/telegraph/coordination.ts:68#legalNextStates`, `:110#derivedCoordinationState`). Served per thread at `routes/telegraphCoordination.ts:212`. |
| T103 | N | **C** | **Thread temporarily transforms into a coordination surface near the leave-by/start window** — leave-by exists (`services/telegraph/coordination.ts:129#leaveByFor`), the transformation is bounded to ASSEMBLING/ACTIVE/RETURNING/DISRUPTED (`:142#threadIsCoordinating`), and the panel renders only then (`travel-buddy-standalone/src/features/telegraph/__tests__/coordinationPanel.component.test.tsx:88`). A plan three days out leaves the conversation alone. |
| T109 | N | **C** | **Quick state ON_MY_WAY** — a validated §9.1 state whose name lands in the row subtype and which the Assembling affordance row offers (`test/telegraphCoordination.test.ts:322`). |
| T111 | N | **C** | **Quick state RUNNING_LATE** — same path. |
| T113 | N | **C** | **Quick state START_WITHOUT_ME** — same path; offered while assembling. |
| T112 | W | **C** | **Quick state CANT_MAKE_IT** — it is now an in-flight coordination status in its own right, not only an RSVP `declined`. The RSVP still answers plan attendance; this answers "not tonight" in the thread. |
| T114 | W | **C** | **Quick state HEADING_BACK** — named, declared and rendered, instead of being approximated by a `leaving` check-in and a Safe Return session start. It is the Returning row's first affordance. |
| T83 | W | **C** | **`ConversationDecision` — question, options, voters, resolution rule, deadline, final result** — all six, for any free-form question, not only "when shall we meet" (`services/telegraph/coordination.ts:243#projectDecision`). The three rules a naive tally gets wrong are each asserted (`test/telegraphCoordination.test.ts:388`, `:399`, `:411`). |
| T86 | W | **C** | **`Rendezvous` — checkpoint, landmark, time window, fallback point, proximity state** — five of five (`services/telegraph/coordination.ts:166#RendezvousPayload`), postable by any thread member rather than only a circle host. |
| T91 | W | **C** | **Action `MEET_HERE`** — a participant can now say "meet here" from the conversation: MEET_HERE is a coordination action (`services/telegraph/coordination.ts:570#COORDINATION_ACTIONS`) and RENDEZVOUS carries the point itself. It is no longer a circle-host-only operation with a card as a side effect. |
| T93 | N | **C** | **Action `SHARE_ROUTE`** — carried as a coordination action proposal into the thread. What it is NOT: a link into the map's route builder — the route travels as the proposal's own detail, not as a `route_plans` reference. |
| T95 | N | **C** | **Action `SHARE_AVAILABILITY`** — the action exists and reaches the thread. Its CEILING is §8.5's: `open_to_plans_windows_enabled` is seeded OFF, so on every deployment of this tree a traveler has no windows to share. The action is built; the data behind it is dark. |
| T96 | W | **C** | **Action `SHARE_LOCATION`** — it is a Telegraph action now, and the composer has a location entry (§6.1) whose message carries an explicit precision (§6.2 LOCATION, coarse by default). The separate trip-crew and Safe-Return live-share surfaces are unchanged and unrelated. |
| T97 | N | **C** | **Action `SPLIT_RIDE`** — a coordination action proposal; no canonical domain owns ride-splitting, so the proposal IS the object. |
| T99 | N | **C** | **Action `RETURN_TO_GROUP`** — a coordination action, alongside the HEADING_BACK quick state. |
| T100 | N | **C** | **Action `DO_THIS_NOW`** — a coordination action, and the §3 rail offers it on a WANT_TO_DO item (`services/telegraph/sharedContext.ts:287#availableActionsFor`). |
| T98 | W | **C** | **Action `CHECK_IN_SAFE`** — no longer circle-only: the §6.2 SAFETY kind carries a check-in from any thread, with four classes and a coarse label (`services/telegraph/messageKinds.ts:181#validateKindMessage`). The circle check-in path is untouched. |
| T105 | W | **C** | **Assembling UI: on my way, running late, meet here, ETA, pickup, arrival counts** — five of six are real: the three quick states, MEET_HERE/RENDEZVOUS, and arrival counts derived from declared states (`routes/telegraphCoordination.ts:212`). **ETA and pickup are not built**, and this row is graded C on the five the surface offers; a reader who requires all six should read it as W. |
| T104 | W | **W** | **Preparing UI: plan card, attendance, leave-by, route, availability conflicts** — leave-by is now real and the plan card and attendance were already. Route and availability-conflict detection in-thread are still absent, so three of five. |
| T106 | W | **W** | **Active UI: minimal conversation, next step, crew state, optional location scope** — the panel now IS a thread mode rather than a separate screen, and crew state is the declared-status list. There is no next-step surface and the location scope is still the separate trip-crew screen. |
| T107 | W | **W** | **Returning UI: heading back, Safe Return, shared transport, return checkpoint** — heading-back is now a first-class declared state and the return checkpoint is expressible as a RENDEZVOUS. Safe Return remains its own subsystem rather than a conversation state, and shared transport does not exist. |
| T84 | N | **W** | **`ConversationCommitment` — who agreed to what, by when, completed** — all four questions are answered by a projection over the thread's own messages (`services/telegraph/coordination.ts:373#projectCommitment`), which is a real object with a real contract. It stays W for a reason worth stating: a projection over one thread's messages is not a queryable store, so "what have I agreed to this week" cannot be answered across threads. The spec's Object row implies something a surface can list. |
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
(`routes/memories.ts:1772#state` applies `state = published` only when the viewer is
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
| T119 | W | **C** | **Explicitly save a message, voice note, place share or media item as a private Memory draft** — the hole is closed. `memoryDraftRow` writes `visibility: "only_me"` and `state: "draft"` as literals into `memories` (`services/telegraph/memoryNotes.ts:144#export function memoryDraftRow`), `POST /me/memory-drafts` re-authorizes and inserts exactly one row (`routes/telegraphMemory.ts:62#/me/memory-drafts`), the owner reads it back through the route that already existed (`routes/memories.ts:1772#state", "published`), and the client action is one press per item, on the long-press sheet (`travel-buddy-standalone/app/messages/[id].tsx:253#draftSavedMessage(r.data.draft)`) — see §10.29, which deleted the unmounted component this row first cited. |
| T120 | N `∅` | **C** | **Telegraph never automatically converts whole conversations into Memories** — now a refusal, not a vacancy. A body naming a thread or a list is rejected by name with §10.2 quoted (`routes/telegraphMemory.ts:71#for (const forbidden of`), the accepted key is singular, and the client API exports no list or thread form (`travel-buddy-standalone/src/features/telegraph/memory/memoryApi.ts:104#export async function saveMessageAsMemoryDraft`). |
| T121 | N | **C** | **End-of-night recap surface** — `GET /threads/:id/recap` (`routes/telegraphMemory.ts:178#/threads/:threadId/recap`) over `buildRecap` (`services/telegraph/memoryNotes.ts:242#export function buildRecap`), rendered with §10.3's four actions and its headline (`travel-buddy-standalone/src/features/telegraph/memory/RecapSheet.tsx:46#export function RecapSheet`), reachable from the thread header (`travel-buddy-standalone/app/messages/[id].tsx:1947#telegraph-open-recap`). |
| T122 | N `∅` | **C** | **Derived from confirmed session context — an invitation to curate, not automatic historical truth** — the window is the plan's own and a thread with no completed plan gets none (`routes/telegraphMemory.ts:238#no_completed_plan`), people are the plan's confirmed participants (`services/telegraph/memoryNotes.ts:242#export function buildRecap`), and the endpoint states that it created nothing (`routes/telegraphMemory.ts:291#wrote: "nothing"`). |
| T7 | W | **C** | **Pillar Remember — completed outcomes explicitly become Memories or recaps without ingesting whole private chats** — the prohibition half already held; the positive half now does too. An explicit save produces a real private `memories` draft (T119) and a completed plan produces a recap (T121), while the whole-conversation path is refused by name (T120). |
| T108 | N | **W** | **Complete UI: closeout, media grouping, explicit Memory/recap options** — two of three. Media grouping is the MEDIA_ALBUM kind (`services/telegraph/messageKinds.ts:124#MEDIA_ALBUM`) and the explicit Memory/recap options exist (T119, T121). There is still **no closeout surface**: at COMPLETE the coordination panel simply disappears rather than becoming one. |

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
| T75 | N | **C** | **A sender may unsend only while no eligible recipient has seen the message** — `planUnsend` refuses with `seen_by_recipient` (`services/telegraph/unsend.ts:174#export function planUnsend`) over the translated assertion (`services/telegraph/unsend.ts:123#export function seenByRecipients`), enforced by `POST /threads/:id/messages/:id/unsend` (`routes/telegraphLifecycle.ts:193#messages/:messageId/unsend`), and offered on the client only while unseen (`travel-buddy-standalone/src/features/telegraph/lifecycle/lifecycleApi.ts:201#export function canOfferUnsend`). |
| T76 | N | **C** | **In a group, one recipient seeing the message closes the window for everyone** — the refusal is `seen.length > 0`, not "all recipients", and a departed member's stale read is excluded (`services/telegraph/unsend.ts:108#export function eligibleRecipients`). The inverted form is the mutation that took the test red. |
| T77 | N | **W** | **The server resolves read-vs-unsend races transactionally** — it does not. The race is detected and COMPENSATED: the receipts are re-read after the write and the message is restored body-and-all when a read landed inside the window (`routes/telegraphLifecycle.ts:338#detectReadRace`, `services/telegraph/unsend.ts:227#export function detectReadRace`). The outcome is correct; the window is real, and a recipient fetching inside it saw a tombstone. A lock needs a SECURITY DEFINER function, i.e. a migration no database has — **this row cannot exceed W on this tree**. |
| T73 | N | **W** | **Direct: Sent/Delivered/Seen. Groups: "Seen by N"** — two of three for direct and the group shape in full. `receiptFor` derives the status and count (`services/telegraph/unsend.ts:139#export function receiptFor`), `GET /threads/:id/receipts` serves it (`routes/telegraphLifecycle.ts:110#/threads/:threadId/receipts`), and the client renders "Sent" / "Seen" / "Seen by N" (`travel-buddy-standalone/src/features/telegraph/lifecycle/lifecycleApi.ts:124#export function receiptLabel`). **DELIVERED is still absent** — nothing on this deployment produces a delivery signal, so every receipt returns `delivered: null` with the reason attached (`services/telegraph/unsend.ts:95#export const DELIVERED_UNAVAILABLE`) rather than a measured false. |

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
(`routes/messaging.ts:1213`). `GET /threads/:threadId/read-receipts`
(`server/telegraph/readReceiptsRoute.ts:52`) returns every active member's read
position for a group thread, refuses a direct thread because the capability is
false there, and CLAMPS another member's position to the caller's own §14.3
floor rather than omitting it (`server/telegraph/readReceiptsRoute.ts:115`) —
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
| T211 | W | **W** | §14.3 new members do not automatically receive pre-membership history — **Re-derived, not re-measured by this pass's work.** The original verdict ("Violated") is STALE: migration `2400_telegraph_history_bound.sql` and `services/groupChatHistoryBound.ts:57` reached this tree in commit `42aeac38e`, and `routes/messaging.ts:1861` now applies the bound in the query. It holds W and not C for the reason the migration's own header gives: the bound is read only while `telegraph_history_bound_enabled` is TRUE, and no database has that flag on. |
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
to the spec's own name (`compass/TelegraphConversationTools.ts:67`). They are
registered into the list the model is handed by one spread
(`compass/CompassTools.ts:240`) and reached through the existing dispatcher by
one branch (`compass/CompassTools.ts:1233`), so this pass adds one import, one
spread and one branch to a file it does not own.

Every one of the eight starts at ONE gate
(`compass/TelegraphConversationTools.ts:110`): active membership read
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
literal (`compass/TelegraphConversationTools.ts:411`). `findSafePublicMeetup`
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
only to messages the caller did NOT send (`routes/messaging.ts:2018`). A sender
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
`:240` is the gate the send path now calls (`routes/messaging.ts:2082`), placed
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
| T246 | N | **C** | §18.3 `getParticipantAvailability()` — `compass/TelegraphConversationTools.ts:235`. Through `projectPublicWindows`, so each participant's own visibility policy decides; the viewer relationship handed to it is the most restrictive the conversation justifies and never widens. A participant not sharing simply does not appear, and the result carries the instruction not to speculate why. This is also the first time Telegraph reads availability at all (compare T28). |
| T247 | N | **C** | §18.3 `getSharedPlaces()` — `compass/TelegraphConversationTools.ts:294`. Place cards shared into the conversation, rendered through §21's safe-field allowlist, so a card body's latitude cannot reach the model. |
| T248 | N | **C** | §18.3 `suggestMeetingPoint()` — `compass/TelegraphConversationTools.ts:345`. Drawn from the conversation's shared destination. No midpoint is computed, and the header says why it never will be on this path: a midpoint between two participants is a location inference about both of them from data neither shared with the conversation. |
| T249 | W | **C** | §18.3 `createPlanDraft()` — `compass/TelegraphConversationTools.ts:388`, now a Compass tool rather than a route-local intent. It has no write in it, returns `requiresConfirmation: true` (`:411`) and refuses when the conversation's `canCreatePlan` is false. |
| T250 | N | **C** | §18.3 `findSafePublicMeetup()` — `compass/TelegraphConversationTools.ts:433`, with `safetyBasis: "public_staffed_category_only"` (`:462`) and an explicit disclaimer that it is not a claim about crime, lighting or hours. |
| T251 | N | **C** | §18.3 `searchAuthorizedConversationContent()` — `compass/TelegraphConversationTools.ts:471`, delegating to the SAME `searchConversations` service the user-facing §21 route uses. One scope resolver, one set of exclusions: a second search path for Compass is how the two would come to disagree about what a participant may see. |
| T279 | W | **C** | §22 adaptive rate limits — both halves. The send step now has a limit (`routes/messaging.ts:2082`), and it is adaptive to all five named inputs (`domain/telegraph/policies/sendRateLimit.ts:112`): relationship, verification, trust, account age and open reports, with an unreadable input falling to the strictest tier. The request step's existing adaptive machinery is untouched. |
| T281 | N | **W** | §22 links/files — the reserved-identity list and structural link scanning now exist (`domain/telegraph/policies/travelScamSignals.ts:197`, `:275`), including lookalike detection against the official hosts. W and not C for two stated reasons: there is no REPUTATION feed (nothing in this repository can say a host is known-bad, and inventing a verdict of "safe" is the one output here that could get somebody hurt), and there is no file kind to scan at all (T40). |
| T282 | W | **W** | §22 travel scam signals — all six families are detected (`domain/telegraph/policies/travelScamSignals.ts:48`, `:167`) and attached to the recipient's read (`routes/messaging.ts:2018`), against a ten-line false-positive corpus. Holds W for one reason: **no client surface renders `safetySignals` yet**, so a traveller does not see the warning. The server half is complete and the traveller-facing half is not. |

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
The read path attaches it at `routes/messaging.ts:2054`, and the thread renders
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
(`src/components/TelegraphInboxScreen.tsx:457`), carrying what was already
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
| T282 | W | **C** | §22 travel scam signals, end to end. All six families detected server-side (`domain/telegraph/policies/travelScamSignals.ts:48`, `:167`), attached to the recipient's read (`routes/messaging.ts:2054` area), and now rendered (`MessageSafetyBanner.tsx:87`) with advice and a report action. §11.4 held this at W precisely for the missing client half; that half is here. |
| T227 | N | **C** | §16.2 data saver. A real setting (`useDataSaver.ts:98`), a reachable control (`DataSaverRow.tsx:33` in `TranslationSettingsSheet.tsx:106`), and two consumers that actually withhold — AI (`app/messages/[id].tsx:2039`) and media (`:1901`). Text, status and safety are never shed, by construction (`useDataSaver.ts:80`). |
| T239 | N | **W** | §17.4 low-bandwidth degradation. The LADDER exists and is ordered exactly as §17.4 lists it (`useDataSaver.ts:47`), and text and safety are unshed-able. W and not C for the half the row also names: there is still **no bandwidth SIGNAL**. The ladder is driven by a person's explicit setting, not by a measured connection, so nothing degrades automatically when the network gets bad. |
| T272 | C | **C** | Re-stated, not re-derived: §11.2 moved this on the server routes; the client surface (`TelegraphSearchScreen.tsx:57`, reachable at `TelegraphInboxScreen.tsx:457`) is now built too, so the row is C on both halves rather than on one. |

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
(`lib/telegraphEvents.ts:439`, called at `routes/messaging.ts:3174` and `:3383`).
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
| T194 | N | **C** | §13.2 `safety.reported`. In the union (`:73`) and emitted to the reporter only through a dedicated emitter whose signature cannot carry a second audience (`lib/telegraphEvents.ts:439`; called at `routes/messaging.ts:3174`, `:3383`). |
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
(`server/telegraph/commandRoute.ts:70`) may issue — and it is deliberately
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
| T163 | N | **W** | §13.1 `ADD_REACTION` (`server/telegraph/commandRoute.ts:271`), with `REMOVE_REACTION` alongside it (`:306`) because a reaction a person cannot take back is a message they cannot unsend. W: needs `message_reactions` (2811), which no database has. |
| T181 | N | **W** | §13.2 `message.unsent`. In the union (`lib/telegraphEvents.ts:53`) and published by the unsend command, deliberately distinct from `message.deleted` — an unsend asserts the message never reached a mind, and a client that collapsed the two would render a retraction as a tombstone. W: nothing can issue the command on any database today. |
| T166 | W | **W** | §13.1 `CREATE_DECISION`. Unchanged in substance and re-derived: it is still only the meetup shape, and the command endpoint now says so out loud — `LEGACY_PATH_COMMANDS` (`domain/telegraph/commands/telegraphCommands.ts:97`) points a caller at `/telegraph-chat/create-meetup` rather than leaving them to discover that a general decision command does not exist. |

**Rows looked at that did not move:** T168 stays N and T169 stays W — §11.7
first said both were N, which was wrong about T169: §1 records it as
BUILT-BUT-WRONG ("approximated by circle check-in … not a conversation command"),
and re-reading that row is what caught it. Both are now *named* as unimplemented
commands (`domain/telegraph/commands/telegraphCommands.ts:121`) so the endpoint
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
(`routes/messaging.ts:1830`) instead of sending a number. The client renders the
badge only above zero (`components/TelegraphInboxScreen.tsx:222`), so absent and
zero both render nothing and neither prints a reassurance nobody verified.

| id | was | now | why |
| --- | --- | --- | --- |
| T260 | W | **C** | §19's inbox line. The unread half was already real; the other half now exists end to end and is measured end to end: `domain/telegraph/policies/needsAction.ts:80` computes it from pending RSVPs and unvoted time options, `routes/messaging.ts:1770` calls it inside `GET /me/threads` and `:1830` puts `needsActionCount` + `needsActionReasons` on every row, and `components/TelegraphInboxScreen.tsx:222` renders "1 needs action" / "N need action". `telegraphNeedsAction.test.ts` drives the REAL Express route, not just the policy, so "wired" is a measured fact. C rather than W because it needs no migration and no flag — every table it reads is from migration 0013 and has had live writers for the whole life of the meetups feature. |

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
one (`routes/messaging.ts:3191`, `:3418`). A person who has just reported
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
| T220 | W | **W** | §15 block rediscovery — re-derived, because the row's evidence is stale and its verdict is still right for a different reason. The fail-open it names ("`routes/messaging.ts:1781-1786` destructures only `{ data: otherMembers }`", "the same hole exists on the media send path") is FIXED on this tree at both sites: `routes/messaging.ts:2171` and `:2652` both check `otherMembersErr` and refuse the send with `degraded_unavailable` rather than skipping the guard. Measured at the base commit of this branch too, not only on my tree: `otherMembersErr` appears six times in `routes/messaging.ts` at `014a25d56`, so the fix the row calls unmerged is merged. The row stays W on the strength of the requirement it actually states — "no subsystem may independently rediscover a blocked relationship" — which is still violated: at least eight modules outside the shared helpers query `blocks` directly, each with its own pairwise logic and its own error handling (`services/interactionPermissions.ts:322`, `compass/CompassTools.ts:310`, `compass/CompassNotificationEngine.ts:411`, `compass/CompassProfileService.ts:104`, `compass/CompassFallbackFeedBuilder.ts:224`, `lib/circleAccessGuard.ts:493`, `services/wall/WallProjectionService.ts:179`, `services/ranking/CreatorActivityScoreService.ts:601`). One shared helper that most callers use is not the same as one shared helper that all callers must use. |

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
| T278 | N | **W** | §22 request origin. All six of §22's origins exist as a closed vocabulary shared by the migration's CHECK and the policy (`domain/telegraph/policies/requestOrigin.ts:54`), the request path records one (`routes/messaging.ts:699`), the list path returns it under the same flag (`:750`, `:789`), and the recipient reads a different SENTENCE for a verified origin than for a claimed one (`features/telegraph/lib/requestOriginLabel.ts:60`). W and not C for two stated reasons: **no database has 2813** and the flag is seeded FALSE, so every live request still carries no origin; and only ONE of the six can ever be verified here — `nearby` and `bump` are unverifiable in principle (proximity at request time is not retained, and reconstructing it would be a location read §15 does not authorize for this purpose), `event` and `buddy` would need another lane's tables, and `profile` is unverifiable and uninteresting. Five of six being claims is the honest state and the wording says so on every one of them. |

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
(`domain/telegraph/policies/shareAuthorizationPolicy.ts:468`). The registration rule alone would have been
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

**2. `messages.subtype` carries a highlight's ID.** `routes/highlights.ts:1395`
writes `subtype: id` — an identifier into the discriminator column a renderer
dispatches on. It can never match a renderer case, and it puts a
highlights-domain id into a messaging-domain vocabulary field, which is the
shape §29's *"No semantic ID substitution across domains"* forbids. Nothing is
visibly broken, because `msg_type: "highlight_reply"` is the real discriminator
there — which is why it has survived. Declared at
`domain/telegraph/policies/shareAuthorizationPolicy.ts:352` so it is a
decision rather than an accident.

**3. `POST /threads/:threadId/messages` accepts any `subtype` the client sends.**
`routes/messaging.ts:2042` takes it straight from the request body; the only
vocabulary constraint anywhere on that handler is that `msgType` collapses to
`system` or `text` (`:2039`). A client can stamp any discriminator it likes onto
a message. It cannot forge the payload's authorization — every card's data comes
from the same client-authored body — so this is a rendering-shape hole rather
than an access-control one, but it is exactly the seam §30A.10's capability
registry exists to close. Recorded at `domain/telegraph/policies/shareAuthorizationPolicy.ts:319`.

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
  roster-error refusal from `routes/messaging.ts:2078` left the matrix suite
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
| T313 | W | W | **Still W, and the reason changed completely.** The bound now EXISTS: migration `migrations/2400_telegraph_history_bound.sql` adds `message_thread_members.visible_from_at` and the flag `telegraph_history_bound_enabled`, and `services/groupChatHistoryBound.ts` is applied at `routes/messaging.ts:1841` and `:1848`. RLS-03 proves both halves at `test/telegraphRlsAuthorizationMatrix.test.ts:222`: with the flag on the pre-membership message is withheld and the bound is applied IN the query so pagination cannot walk past it; with the flag as seeded — FALSE — the whole back history is returned. **Ceiling: no database has 2400 and the flag is seeded off.** BUILT ON BRANCH IS NOT DEPLOYED; this row cannot move from inside the tree. |
| T314 | W | **C** | The fail-open is closed in the tree. `routes/messaging.ts:2078-2082` now REFUSES the send when the roster read fails ("cannot determine whether this is a blocked 1:1 thread") instead of inferring an empty roster and skipping the guard. RLS-04 drives five configurations at `test/telegraphRlsAuthorizationMatrix.test.ts:261` — recipient-blocked, sender-blocked, mutual (the two-row state that used to make the guard raise), blocks-table unreadable, roster unreadable — and all five deny. Shown red by deleting that refusal. |
| T315 | C | C | RLS-05, `test/telegraphRlsAuthorizationMatrix.test.ts:309`. Expiry, status and recipient identity are each refused by `services/safeReturn/SafeReturnPrivacyGuard.ts:142-157` before the handler runs, and exact coordinates cannot leave the API at all — `stripGPS` (`:23`) is proved to delete `latitude`/`longitude` at depth. Two independent artifacts, so neither is a single point of failure. |
| T316 | C | C | RLS-06, `test/telegraphRlsAuthorizationMatrix.test.ts:377`, driving the real predicate `services/passport/OpenToPlansService.ts:168` over the cross-product of five visibility policies, both sources and five viewer relationships: a private window is invisible to every non-self viewer, an INFERRED window is invisible whatever visibility it carries, and an expired one is invisible even to an admitted viewer. |
| T317 | N `∅` | **C** | The unguarded absence is now a refusal. `domain/telegraph/policies/shareAuthorizationPolicy.ts:122` refuses a private source with no derivative grant, a grant from the wrong domain, a grant for the wrong scope, an expired or unparseable-expiry grant, and a "derivative" that names the source's own id — six refusal branches, exercised at `test/telegraphRlsAuthorizationMatrix.test.ts:425`. `scripts/checkTelegraphShareProducers.ts` makes it unavoidable, and its private-by-default rule (`domain/telegraph/policies/shareAuthorizationPolicy.ts:468`) closes the misdeclaration route for exactly the domains this case names. NO producer is `PRIVATE_SOURCE` today — the gate is the guarantee, not a live path, and the row says so. |
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
| T344 | W | W | **Still W, and smaller than it was.** Of the four dropped-error reads the census named, one is FIXED (the block-guard roster read now refuses) and two resolve to a 403 rather than an empty inbox — a refusal is not a plausible empty state. What remains is genuinely this defect: the per-viewer translation read (`routes/messaging.ts:1887`), and the trip, booking and circle context reads in the inbox projection (`:1724`, `:1740`, `:1355`), each of which renders an untranslated message or a thread with no trip context when the table is unreadable. Measured and asserted at `test/telegraphRlsAuthorizationMatrix.test.ts:620` so the count cannot silently reach zero without the contract being reclassified. **Ceiling: the fix is in `routes/messaging.ts`, which §12–§22's lane holds concurrently; this lane measured it rather than editing a contested file.** |
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
| T444 | W | W | Same substrate as T390, from §30A.20's side, and 2400 cites this clause by number. The window is enforced in the QUERY (`routes/messaging.ts:1861`) rather than filtered after the fact, so pagination cannot walk past it — which is the difference between a bound and a display rule. **Ceiling: the flag is seeded FALSE.** |
| T409 | N | **W** | Was "No registry and no contract; each producer hand-rolls a payload." One of §30A.10's six dimensions now has both. `domain/telegraph/policies/shareAuthorizationPolicy.ts:205` is a registry of every shareable message type with its object family and source domain, and `:113` is the AUTHORIZATION contract those families resolve against, made unavoidable by `scripts/checkTelegraphShareProducers.ts`. The other five dimensions — preview, current state, actions, search behaviour, revocation — have nothing, which is why this is one sixth and not more. |
| T429 | N | N | Unchanged, and now precisely bounded. There are no versioned structured-message schemas; what exists is a registry of eighteen unversioned literals plus ten sites that COMPUTE a message type, one of which takes the discriminator straight from the client's request body (`domain/telegraph/policies/shareAuthorizationPolicy.ts:319`). A versioned schema is exactly what would close that, so the registry's finding and this row's absence are the same fact seen twice. |

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

`GET /api/me/saved-messages` exists at `routes/messaging.ts:3118` and reads
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
| The payload | `artifacts/api-server/src/services/telegraph/coordination.ts:451#export const AcknowledgementPayload` |
| The eighth coordination kind | `artifacts/api-server/src/services/telegraph/coordination.ts:610#ACKNOWLEDGEMENT` |
| The projection | `artifacts/api-server/src/services/telegraph/coordination.ts:503#export function projectAcknowledgements` |
| The write, and its four refusals | `artifacts/api-server/src/routes/telegraphCoordination.ts:193#did not ask to be acknowledged` |
| The announcement reader (one answer for every reason a caller must not distinguish) | `artifacts/api-server/src/routes/telegraphCoordination.ts:109#function readAnnouncementRow` |
| The read | `artifacts/api-server/src/routes/telegraphCoordination.ts:431#/threads/:threadId/announcements` |
| The client hook, one fetch per thread | `travel-buddy-standalone/src/features/telegraph/kinds/useAnnouncementAcknowledgement.ts:70#export function useAnnouncementAcknowledgement` |
| The API call | `travel-buddy-standalone/src/features/telegraph/coordination/coordinationApi.ts:195#export async function acknowledgeAnnouncement` |
| The mount that was missing | `travel-buddy-standalone/app/messages/[id].tsx:794#useAnnouncementAcknowledgement({` |
| The producer — an announcement composer on the coordination panel | `travel-buddy-standalone/src/features/telegraph/coordination/CoordinationPanel.tsx:250#telegraph-announcement-open` |
| The renderer refusing to draw a button it cannot honour | `travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:164#telegraph-kind-announcement-ack-unavailable` |
| The same, for ACTION's Confirm | `travel-buddy-standalone/src/features/telegraph/kinds/TypedMessageRenderer.tsx:129#telegraph-kind-action-unconfirmable` |
| `SET_COORDINATION_STATUS` pointed at the route that implements it | `artifacts/api-server/src/domain/telegraph/commands/telegraphCommands.ts:119#SET_COORDINATION_STATUS:` |

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
  (`artifacts/api-server/src/test/telegraphCoordination.test.ts:803#is STRUCTURALLY unable to derive an acknowledgement from a read receipt`),
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
   `artifacts/api-server/src/domain/telegraph/policies/shareAuthorizationPolicy.ts:285#TELEGRAPH_DYNAMIC_SHARE_PRODUCERS`
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
| T79 | "`routes/messaging.ts` returns media_url/thumbnail/type/duration on a deleted message. Four lines." | **Exactly right, and it was exactly four lines.** Confirmed at the serializer and confirmed to be the ONLY leaking surface: search filters in the query (`artifacts/api-server/src/services/telegraphSearch.ts:164#// §21: deleted objects are excluded in the QUERY`), the drawer filters (`artifacts/api-server/src/routes/telegraphKinds.ts:148#.is("deleted_at", null)`), the inbox preview filters, saved messages filters, and both Memory Note paths refuse a tombstone. |
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
| The four lines | `artifacts/api-server/src/routes/messaging.ts:2253#mediaUrl: isDeleted ? null : ((m as any).media_url ?? null),` |
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
`artifacts/api-server/src/test/telegraphRlsAuthorizationMatrix.test.ts:633#it("LDB-05: the divergence is still real — route handlers drop read errors into context", () => {`
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
| The three primary reads, now a refusal | `artifacts/api-server/src/routes/messaging.ts:1742#for (const [label, r] of [` |
| The member-profile batch, now the refusal its own comment had claimed for months | `artifacts/api-server/src/routes/messaging.ts:1772#if (profileErr) {` |
| The message-request list, which returned `sender: null` for everybody | `artifacts/api-server/src/routes/messaging.ts:781#if (profilesErr) {` |
| Trip context: omitted, because `undefined` ("not known") and `null` ("this trip has no city") are different claims | `artifacts/api-server/src/routes/messaging.ts:1983#tripCity: tripCityDegraded ? undefined : tripCity,` |
| The preview says `failed` only when it failed | `artifacts/api-server/src/routes/messaging.ts:1820#let previewTranslationsDegraded = false;` |
| The thread read reports §18's own word for "we did not translate this", instead of inventing a monolingual thread | `artifacts/api-server/src/routes/messaging.ts:2106#status: 'failed' as TranslationStatusValue,` |
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
| Highlight | `artifacts/api-server/src/services/telegraph/shareables.ts:559#const loadHighlight` | Public or owner only. The other three `highlights.visibility` values need a relationship read another surface owns, and approximating it is the backdoor §5.3 forbids — the same reasoning `loadMemory` already states. Plus the rule no other family needs: **it expires.** |
| Stamp | `artifacts/api-server/src/services/telegraph/shareables.ts:602#const loadStamp` | Revoked → gone. Hidden from its owner's own passport → not handed to a third party. Two reads, both bound and checked: an unreadable definition is `unknown`, not an untitled stamp. |
| neighborhood | `artifacts/api-server/src/services/telegraph/shareables.ts:661#const loadNeighborhood` | None, and none invented. `neighborhood_areas` is derived public reference data with no owner and no visibility column. §11 said this family "deliberately has no loader ... rather than pretending"; what it refused to pretend about was an authorization model, and this family genuinely has none to get wrong. |
| route | `artifacts/api-server/src/services/telegraph/shareables.ts:693#const loadRoute` | `route_plan_members`, not the trip. Being on the trip a route was planned for is not being on the route. A draft degrades for everyone but its owner. |
| reservation-safe derivative | `artifacts/api-server/src/services/telegraph/shareables.ts:742#const loadReservation` | Owner or accepted trip member — and the projection carries neither `confirmation_ref`, `raw_text` nor `extraction`. See §15.2. |
| layover plan | `artifacts/api-server/src/services/telegraph/shareables.ts:786#const loadLayoverPlan` | Owner, or an accepted member of the trip the session belongs to. A session with no `trip_id` is private to its traveller, full stop. |
| Media | `artifacts/api-server/src/services/telegraph/shareables.ts:841#const loadMedia` | `visibility: 'inherit'` — the column's DEFAULT — degrades to `private`. See §15.2. |
| Buddy service | `artifacts/api-server/src/services/telegraph/shareables.ts:891#const loadBuddyService` | `approved` AND `is_active`, or ownership. This one is a REPAIR, not an addition. See §15.3. |

The three vocabulary types are `artifacts/api-server/src/services/telegraph/vocabulary.ts:52#"RESERVATION",`,
`:53#"LAYOVER_PLAN",` and `:77#"MEDIA",`. The registry is
`artifacts/api-server/src/services/telegraph/shareables.ts:924#const LOADERS` and
now answers twenty-two object types where it answered fifteen
(`:950#SHAREABLE_OBJECT_TYPES`). Forty-eight assertions:
`artifacts/api-server/src/test/telegraphShareFamilies.test.ts:271#it("Services:`
and the rest of that file.

**One thing was made checkable rather than left to the `default:` arm.** Three
of the new families have no client screen that takes their id — there is no
`app/highlight/`, no `app/neighborhood/` and no reservation route in
`travel-buddy-standalone/app/`, which was read rather than assumed. Their deep
link is the app root, and that is now a DECLARED absence
(`artifacts/api-server/src/services/telegraph/shareables.ts:177#export const FAMILIES_WITH_NO_CLIENT_SCREEN: readonly TelegraphObjectType[] = [`)
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
| T290 | W | **C** | §24 `ConversationProjection` — "renderable ordered thread WITH CURRENT PERMISSIONS". §12's restatement left exactly one gap: "it still carries no permissions block, which is the half §24 names explicitly". `GET /threads/:threadId/messages` now answers one (`artifacts/api-server/src/routes/messaging.ts:2308#permissions:`), carrying §14.1's ten capabilities, their per-capability reasons, which of the eight inputs were read, and `degraded` when one of them could not be. The block is ASKED of `resolveConversationCapabilities` (`artifacts/api-server/src/routes/messaging.ts:2300#const resolvedCapabilities = await resolveConversationCapabilities(sc, {`) rather than re-derived, and the test compares it field-by-field against that resolver run directly on the same fixture (`artifacts/api-server/src/test/telegraphProjectionPermissions.test.ts:213#it("the projection's block EQUALS resolveConversationCapabilities on the same fixture", async () => {`) — a second implementation of §14.1 would pass a "has ten keys" test and fail that one, which is the failure mode being guarded. It gates nothing: `CAPABILITY_ENFORCEMENT_SITES` still names where each refusal happens. `PRJ-02`'s note is corrected in the same pass (`artifacts/api-server/src/domain/telegraph/projections/projectionRegistry.ts:58#id: "PRJ-02",`), which had said the block "does not exist" — stale since T207 went C. **Why this is C and not W on history bounding: T290's requirement is the projection; the §14.3 bound is T211's, is flag-gated, and §12's own restatement recorded it as gained. PRJ-02 stays `partial` for that reason and this row does not.** |

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
     (`artifacts/api-server/src/services/messageTranslation.ts:130#detectionSource = senderPreferredLanguage ? 'sender_preference' : 'default';`).
     So a profiles outage does not merely degrade — it writes a durable,
     queryable assertion that the sender's stated preference was English, when
     no preference was read. The distinguishing mechanism ALREADY EXISTS one
     layer down (`'default'` is the other value); the route is feeding it a lie.
     `routes/groupChat.ts:328` is a fifth instance of the same line.
   - **An unreadable `profiles` becomes a confident 404.** "Circle owner not
     found" is produced by a read whose error was discarded
     (`artifacts/api-server/src/routes/messaging.ts:3275#const { data: ownerProfile } = await sc`).
   - **A mention notification names "@someone"** when the tagger's profile read
     fails — indistinguishable from a tagger who has no handle
     (`artifacts/api-server/src/routes/messaging.ts:2704#const { data: taggerProfile } = await sc`).
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
