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
| BUILT-AND-CORRECT | **98** |
| BUILT-BUT-WRONG | **172** |
| NOT-BUILT | **178** |
| CANNOT-VERIFY | **3** |
| **CONSTRUCTED%** = (98+172)/451 | **59.9 %** |
| **CORRECT%** (raw) = 98/451 | **21.7 %** |
| **CORRECT% (spec-attributable)** = 0/451 | **0.0 %** |
| CANNOT-VERIFY share | 3 / 451 = 0.7 % |

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
`services/media/MediaProjectionService.ts:795`) were opened and confirmed to be
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
| T30 | Blocking is absolute and removes both parties from each other's proximity surfaces | W | Blocking is genuinely absolute in delivery and discovery: `routes/blocks.ts:60-78` tears down follows, friend requests, friendships and pending message requests and writes an interaction cooldown; `compass/CompassTools.ts:1158` filters hidden users out of every social tool; five block-exclusion suites exist (`test/blockExclusion.test.ts`, `memoriesBlockFailClosed.test.ts`, `compass-ui-blocks.test.ts`, `discoveryBlockedSubmitter.test.ts`, `rentABuddySearchBlocks.test.ts`). Two divergences: the proximity half is vacuous, and blocking deliberately **does not close an existing thread** — it is re-checked per send instead (`routes/messaging.ts:1777-1791`), which is defensible but is not "absolute" at the object level. |
| T31 | Privacy zones can suppress discovery around home, lodging or user-defined sensitive places | W | The capability exists and is well built — `lib/protectedLocations.ts:13-27`, a server-side last gate, fail-closed on unparseable geometry — but it belongs to the Map programme, its policy table ships empty by design, and **nothing in Telegraph consults it**. |
| T32 | Who's Around: focused surface for people, open plans and events actionable right now | W | `get_whos_around` is real and privacy-correct (`compass/CompassTools.ts:178`, impl `:767-782`; approximate-only, opt-in-only, `contextsChecked === 0` answers honestly). But it is a **Compass LLM tool, not a surface**, it returns people only — no open plans, no events — and it is scoped to the caller's circles and trips. |
| T33 | Existing social graph separated from discoverable strangers | W | The separation exists in one direction: `toolWhosAround` gates on `sharesSocialContext` (`CompassTools.ts:822`) so only the graph is returned, and stranger contact runs entirely through `message_requests`. The *discoverable strangers* half has no implementation, so there is nothing to separate from. |
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
| T219 | Block cascade across direct delivery, location, presence, Nearby, Bump discovery, shared-memory resurfacing, Crew suggestions and Compass retrieval | W | Five of eight have real enforcement: delivery (`routes/messaging.ts:1786-1790`), Compass (`compass/CompassTools.ts:1158` `refreshHiddenUsers`), discovery (`test/discoverySearchBlockedSubmitter.test.ts`), memories (`test/memoriesBlockFailClosed.test.ts`), Buddy search (`test/rentABuddySearchBlocks.test.ts`). Nearby, Bump and Crew suggestions have no referent; shared-memory resurfacing is covered. |
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
| T252 | Compass sees only data authorized to the conversational context | C | Three gates, all fail-closed. `services/telegraphChatSuggestions.ts:18,81` — `TelegraphChatPrivacyVerdict` decides what context is safe *before* any suggestion is built; `:152-163` reads the per-surface opt-out (`show_telegraph_dm` / `_trip` / `_circle`) and returns `reason:'telegraph_disabled'` when off; `routes/telegraphChat.ts:17-21` states thread membership is verified on every call, trip/circle context is used only for confirmed members, and no GPS or live location is ever returned. |
| T253 | Compass cannot reveal one participant's private Memory/preferences to another, impersonate participants, or silently create canonical plans from uncertain prose | C | All three, separately enforced. Cross-participant leakage: the privacy verdict above plus `compass/CompassTools.ts:231` — *"never mention a person a tool did not return … NEVER guess, infer, triangulate"*. Impersonation: suggestions render as a labelled tray (`components/TelegraphSuggestionTray.tsx`), never as a participant's message. Silent creation: `requires_confirmation: true` as a literal type (T101). |

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
| T275 | Private semantic indexes filter access **before** retrieval, not after | N `∅` | Unguarded absence: no semantic index over conversations exists. (Compass's own tools do gate before retrieval — `compass/CompassTools.ts:822` `sharesSocialContext`, `:833` trust floor — but they index no message content.) |
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
| T368 | Blocked relationships never reappear through Nearby, Compass, Bump or shared-memory suggestions | W | Compass and shared-memory are genuinely enforced (`compass/CompassTools.ts:1158` `refreshHiddenUsers` on every social tool; `test/memoriesBlockFailClosed.test.ts`). Nearby and Bump have no referent. And the guarantee is not absolute while the send path can skip its block guard on a read error (T220). |
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
| T379 | **§30A.1** Canonical `TelegraphRelationship` model so eligibility, calling, Nearby, location, invitations and temporary connections do not independently infer relationship state | W | **The anti-pattern is exactly what exists.** Relationship is independently inferred by at least four resolvers with different vocabularies: `lib/messagingPermissions.ts:38-45` (friend / follower / following / trip / circle), `services/interactionPermissions.ts:597-632`, `lib/calls/callPermissionEngine.ts` via `whoCanCall` (`test/callHardening.test.ts:31` `'people_i_message'`), and `compass/CompassTools.ts:822` `sharesSocialContext`. Each is correct; none is canonical. |
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
| T418 | **§30A.13** Private policy signals — request acceptance, spam reports, block rate, burst, duplicate-message, malicious-link — constrain abuse and are **never** exposed as a public messaging score | W | The privacy clause is fully honoured: `trust_profiles.overall_score` is consulted as a floor and never returned to any caller (`compass/CompassTools.ts:826-834`, with a uniform "not available" answer that never confirms why), and restrictions are resolved server-side (`services/trust/TrustRestrictionService`). Of the six named signals only reports and restriction state feed it — no burst detection (T279), no duplicate-message signal (T231), no malicious-link signal (T281). |
| T419 | New accounts receive gradual outreach capabilities; Nearby must never become mass-DM infrastructure | W | The gradual half is real for the *request* step, where account state and trust restrictions gate eligibility with a fail-closed degraded path (`routes/messaging.ts:430-560`, six tests at `test/messaging.test.ts:519-631`). Sends themselves are unrestricted (T279), and the Nearby clause is vacuous. |
| T420 | Proximity defenses: coarse distance buckets, update throttling, privacy-zone suppression, purpose-bound access, no historical proximity endpoint | W | One of five, and it is real: **no historical proximity endpoint exists**, and `trip_crew_location_sessions` structurally cannot become one — it keeps a single `last_location_snapshot_id` (`baseline:10519`), not a trail. The other four have no referent in Telegraph. |
| T421 | BLOCK overrides Nearby in both directions; Unavailable/Invisible promptly revokes Nearby, Discovery and Compass availability projections | W | Bidirectionality is real and checked both ways (`routes/blocks.ts:275-276`), fail-closed (`lib/blockGuard.ts`), and Compass re-derives hidden users on every request rather than caching (`compass/CompassTools.ts:1158` `refreshHiddenUsers`) — which is the "promptly" the rule asks for. Nearby and Invisible have no referent (T29). |
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
   `services/media/MediaProjectionService.ts:795`) were opened and confirmed to be
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
