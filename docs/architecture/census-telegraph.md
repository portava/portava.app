# Portava Telegraph — Requirement Census (v1 and v1.1)

| Field | Value |
| --- | --- |
| **Specs** | `docs/specs/Portava_Telegraph_Design_Architecture_Developer_Spec_v1.txt` (30 sections) and `..._v1_1.txt` (32 headings). The `.docx` originals are authoritative and were extracted and compared; see §2. |
| **Tree censused** | `claude/portava-continuation-uqta94`, working tree at `ebe72b34`. Censused state is **main** — open PRs #460 and #472 are read but never scored into a bucket; see §8. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a file:line that was opened and read. Matches `census-sensing.md` and `census-wall.md`. |
| **Database** | Not queried. Storage facts are the ones supplied as ground truth. |
| **Prior census** | **None. Telegraph has never been censused.** There is no earlier number to agree or disagree with; this is the first. |

Backend paths are relative to `artifacts/api-server/src/` unless prefixed
`travel-buddy-standalone/`, `docs/` or `pr/472:`.

---

## 1. Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements) — v1.1** | **451** |
| — of which shared with v1 | 378 |
| — of which v1.1-only (§30 Addendum + §31) | 73 |
| BUILT-AND-CORRECT | **96** |
| BUILT-BUT-WRONG | **93** |
| NOT-BUILT | **250** |
| CANNOT-VERIFY | **12** |
| **CONSTRUCTED%** = (96+93)/451 | **41.9 %** |
| **CORRECT%** (raw) = 96/451 | **21.3 %** |
| **CORRECT% (spec-attributable)** = 0/451 | **0.0 %** |
| CANNOT-VERIFY share | 12 / 451 = 2.7 % |

Scored against **v1 alone** (378 requirements), the numbers are very slightly
better, because the v1.1 addendum is almost entirely unbuilt:

| Measure | v1 (378) | v1.1-only (73) | v1.1 total (451) |
| --- | --- | --- | --- |
| BUILT-AND-CORRECT | 89 | 7 | 96 |
| BUILT-BUT-WRONG | 82 | 11 | 93 |
| NOT-BUILT | 196 | 54 | 250 |
| CANNOT-VERIFY | 11 | 1 | 12 |
| CONSTRUCTED% | 45.2 % | 24.7 % | 41.9 % |
| CORRECT% | 23.5 % | 9.6 % | 21.3 % |

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

Migration `2325_telegraph_unsend_before_seen.sql:8-10` asserts:

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
  terms from message prose"* and again in §23. Counted **once**, at T340.
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
- **Duplicates are merged to a single id.** §7.4's unsend rule and §27.1's
  *"any eligible recipient seen → unseen-unsend impossible"* are the same
  assertion (T94/T291 — the §27 instance is scored as a *test-existence*
  requirement, which is a different question, so both are kept and the
  distinction is stated in the row).

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

**Thirty-one** NOT-BUILT verdicts are unguarded absences rather than missing
machinery; they are marked `∅` in the table. A reader who credits vacuous
satisfaction should move all thirty-one to BUILT-AND-CORRECT, which gives
CORRECT% = 127/451 = **28.2 %** and CONSTRUCTED% = 220/451 = **48.8 %**. This
census does not credit them.

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
| `travel-buddy-standalone/.../fieldPolicy.ts:1` | *"Mirrors PGIIA spec §6"* | Global Input Intelligence |
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
in §2. If it merges, spec-attributable CORRECT% becomes 5/451 = 1.1 % (T92, T93,
T94, T96, T97). It is applied to `portava-ci` only; `messages.unsent_at` does
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

