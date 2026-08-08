# Tagging — display directions

**Scoping only. Three directions, deliberately not narrowed to one** — the
owner asked for options, and picking is a design decision.

The brief is specific: the *display* of "someone is tagged" should be
distinctive to Portava rather than a copy of Instagram or Facebook. That is
what these directions vary. The consent model, the write path and the
degradation behaviour are held constant across all three.

Date: 2026-08-08. Tree: `travel-buddy-standalone`, branch `bughunt-20260805`.

---

## 1. What tagging infrastructure exists today

**Today's tagging is the Instagram/Facebook pattern.** `RichText.tsx` renders
user-generated text with tappable `@mention` and `#hashtag` spans, resolved
from the `tags` and `hashtag_usage` tables. **Tagging is a text annotation** —
a span inside a caption, nothing more.

### The `tags` table, as it exists live

```
tags: id, source_type, source_id, tagger_id, tagged_user_id,
      status, suppressed, suppressed_at, created_at
```

- `source_type` is `'post' | 'comment' | 'message'` (migration 0043 line 33)
- `tagged_user_id` is `NOT NULL REFERENCES profiles(id)`
- unique on `(source_type, source_id, tagged_user_id)`

### What already works and should survive every direction

- **Consent model** — `TagPermission = 'anyone' | 'interacted' | 'friends_only'
  | 'nobody'`, a real Postgres enum (`tag_permission`), enforced server-side in
  `interactionPermissions.ts`.
- **Approval state** — `tags.status`, added by migration 0064:
  `'approved'` (immediate) | `'pending'` (awaiting target approval) |
  `'rejected'`, defaulting to `'approved'`. **There is no `CHECK` constraint on
  it** — the vocabulary is a convention in the migration comment and the
  application, not a database guarantee. *(An earlier draft listed this
  vocabulary as unknown. It is now verified — and it matters, because it means
  Direction B's acceptance state largely already exists.)*
- **Self-removal** — `removeSelfTag()` plus the `suppressed` soft-delete
  (migration 0046), with partial indexes for both directions.
- **Safe degradation** — blocked, deleted or private tags render as plain text:
  no link, no press. Good behaviour; every direction below inherits it.

### Correction: the data model is *not* richer than the display

An earlier draft of this document claimed the schema already supports five
entity types and that the display throws that structure away. **That is wrong,
and the error is worth stating precisely because two directions below depend on
it.**

`TagSuggestionType = 'user' | 'trip' | 'circle' | 'place' | 'event'`
(`src/services/tagging.ts:90`) is the type of the **autocomplete picker**. The
persistence path does not match it:

- `TaggingService.processMentions()` resolves typed handles against `profiles`
  and nothing else.
- `enrichSpans.ts:173` reads back under a `── User-mention tags ──` heading,
  selecting `tagged_user_id` only.
- `tags` has no `entity_type`, no polymorphic target — only
  `tagged_user_id → profiles(id)`.

**Only user mentions become `tags` rows.** The picker may offer trips, circles,
places and events, but nothing persists them as tags. Any direction that wants
to display "tagged at this place, on this trip" must **derive** that context by
joining through `source_id` to the post, or add columns. It cannot read it off
the tag.

### Latent bug in the tag write path — verified

`TaggingService.ts:204–210` rate-limits tagging at 20 tags/author/hour:

```ts
// NOTE: schema uses tagged_at (not created_at) — see migration 0044_tags_hashtags.sql
const { count: hourCount } = await db
  .from('tags').select('id', { count: 'exact', head: true })
  .eq('tagger_id', authorId)
  .gte('tagged_at', oneHourAgo);

if ((hourCount ?? 0) >= MAX_TAGS_PER_HOUR) { /* reject */ }
```

**`tags.tagged_at` does not exist in the live database.** This is not an
inference — the repo's own audit scripts say so:

- `scripts/auditMigrationsVsLive.ts:114` — `"column:tags.tagged_at", // does not exist live`
- `scripts/checkMissingLiveColumns.ts:88` — `"tags.tagged_at", // does not exist live`

and `database.types.ts`, generated from live, lists `created_at` on `tags` and
no `tagged_at`.

The cause is two divergent migration trees: `migrations/0043_tags_hashtags.sql`
creates `tags` with `created_at`, while
`artifacts/api-server/src/migrations/0044_tags_hashtags.sql` creates it with
`tagged_at`. `migrations/0044_tags_hashtags_supplement.sql` exists specifically
to `ALTER TABLE tags ADD COLUMN ... tagged_at` — **and was never applied live.**

**Consequence:** the filter references a missing column, so the query errors.
The destructure takes only `count` and discards `error`, so `hourCount` is
nullish, `(hourCount ?? 0)` is `0`, `0 >= 20` is false, and **the tag rate
limit never fires.** It fails open, silently.

This is squarely the "declared but never executed" class — the constant, the
comment and the check all read as working. It is **out of scope for this
document to fix** (write-restricted session, and the fix is a migration or a
one-word column change, not a design decision), but every direction below
inherits this write path, and a tagging feature that increases tagging volume
inherits an unenforced spam limit. **Flagged for the owner as decision-ready.**

### One useful precedent

`rent_buddy_tag_consents` (`booking_id`, `post_id`, `requester_id`, `target_id`,
`consent_status`, `decline_reason`, `resolved_at`) is an existing, working
per-tag consent state machine with an explicit decline reason. Direction B
needs something close to this shape, and it need not be invented from scratch.

---

## 2. Direction A — Companion strip ("who you were with")

**The idea:** tags stop being words in a caption and become a *presence
attribution* under the media — closer to a film credit than a mention.

```
┌──────────────────────────────────────────┐
│                                          │
│              [ photo/video ]             │
│                                          │
├──────────────────────────────────────────┤
│  ◍◍◍  with Ana, Marco +2                 │
│  Sunset Point · Lisbon · day 4           │
└──────────────────────────────────────────┘
   ^ overlapping avatars, tap → companion sheet
```

- Overlapping avatar cluster, then names, then a place/trip line.
- Caption text is left alone — no blue spans in prose at all.
- Tapping the cluster opens a sheet listing companions **with shared context**:
  "you and Ana were both at Sunset Point on 12 May".

**Why it is Portava and not IG:** Instagram's tag answers *who is in this
photo*. This answers *who you travelled with* — the thing Portava's graph
actually knows, and the thing that seeds Telegraph conversations and future
meetups.

**Data model:** no new tables required, but **more read-side work than the
earlier draft claimed** (see §1's correction). `tags` gives the people;
place and trip must be derived by joining `source_id` → `posts` →
`post_media.canonical_place_id` and the post's trip. The "day 4" line needs the
trip's `start_date` differenced against the post date.

- **Cheapest version:** avatars + names only, no context line. Genuinely
  read-side only.
- **Full version:** denormalise `place_id`/`trip_id` onto `tags` to avoid a
  three-table join per post in a feed. That is a migration.

**Risk:** on a post with no place or trip context the strip degrades to a plain
avatar row — which is Instagram with rounder corners. How often that happens is
an open question this document cannot answer without querying production (§5).

---

## 3. Direction B — Passport co-stamp (tag as a shared artefact)

**The idea:** being tagged is not a label on someone else's content. It mints a
**shared entry on both passports**. The tag's primary display surface is the
passport, not the post.

```
POST                          PASSPORT (both users)
┌────────────────────┐        ┌────────────────────────────┐
│   [ photo ]        │        │  ✦ SUNSET POINT            │
│                    │        │    Lisbon · 12 May         │
│  ⊕ co-stamped      │  ───►  │    ◍◍ shared with Ana      │
│    with Ana        │        │    "co-signed"             │
└────────────────────┘        └────────────────────────────┘
```

- On the post: a small co-stamp mark, not a name list.
- On the passport: the stamp carries both faces and reads as co-signed.
- A tag you accept becomes **part of your own travel record** — an asset, not an
  obligation to untag.

**Why it is Portava and not IG:** it inverts the incentive. On Instagram a tag
is done *to* you and the primary affordance is removal. Here it is something you
*collect*. Nobody else can copy this, because nobody else has the passport.

**Data model:** the largest of the three, but **smaller than the earlier draft
assumed.**

- **Acceptance state already exists.** `tags.status` is
  `approved | pending | rejected` (§1). Co-stamps can gate on
  `status = 'approved'` with no new column. Adding a `CHECK` constraint would be
  wise before depending on it.
- **Stamp issuance already has the right shape.** `user_stamps` carries
  `source_type` and `source_id` — the existing generic link from a stamp to
  whatever earned it — plus `earned_at`, `is_revoked`, `revoked_at`,
  `revoked_reason` and `visibility`. `stamp_award_events` has an
  `idempotency_key`, which matters: a co-stamp must not double-issue.
- **Genuinely new:** rules for what a co-stamp means when one party later
  suppresses the tag, blocks the other, or is deleted. `is_revoked` and
  `revoked_reason` exist to express the outcome; the *policy* does not.

**Risk:** highest complexity, and it entangles tagging with the stamp economy —
a bug here devalues stamps, which are a core currency. The revocation policy is
the sharp edge: `suppressed` is a soft-delete on the tag, but a stamp already
issued and displayed on a passport is a harder thing to withdraw quietly.

---

## 4. Direction C — Presence on the place, not the post

**The idea:** the tag's home is the **place**, not the content. Tagging says
"we were here together", and the display surfaces on the place page and map.

```
PLACE PAGE — Sunset Point
┌────────────────────────────────────┐
│  Sunset Point · Lisbon             │
│  ──────────────────────────────────│
│  ◍◍◍◍  11 travellers · 3 together  │
│  ┌──────────────────────────────┐  │
│  │ ◍◍ Ana & Marco — 12 May      │  │
│  │ ◍◍◍ you, Sam, Lea — 4 Mar    │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘
```

- The post shows only a subtle "+2" presence marker.
- The place page shows **groups over time** — who came here together.
- On the map, a place with co-presence renders differently from one with only
  solo visits.

**Why it is Portava and not IG:** it makes tagging a *contribution to a place's
history* rather than a claim on a person. It also feeds the ranking model
directly — co-presence is a combined social-plus-location signal, and
`docs/algorithm/signal-audit.md` §2 identifies Social Connection (15%) and
Location/Trip Relevance (20%) as two of the seven score components.

**Data model:** medium. Needs a reliable `place_id` on the tag path — today
that is derived through the source post's canonical place
(`post_media.canonical_place_id` exists). A grouping query ("tags sharing a
place within a time window") is new but read-side only. **No new user input.**

**Risk: this is the one with a real privacy surface, and it is not a small
one.** `mediaProcessing.ts` strips EXIF GPS deliberately and `rankLog` strips
raw coordinates before insert — the codebase has a consistent posture of *not*
publishing precise location. This direction publishes **co-presence**: who was
somewhere, with whom, when. That is more sensitive than either thing already
being stripped, and it is inferable about a person by someone *else's* tagging
action.

Existing machinery that would need to be respected rather than bypassed:
`user_location_privacy`, `user_location_preferences`,
`passport_visibility_preferences`, `trips.precise_location_visible`, and
`pulse_geo_tags.location_visibility` (which already models per-tag location
visibility, and has a `hotel_blur_applied` flag — evidence this problem has been
thought about before). **This direction needs its own privacy review before any
build.**

---

## 5. Comparison

| | A — Companion strip | B — Passport co-stamp | C — Place presence |
|---|---|---|---|
| Distinctiveness | Medium | **Highest** | High |
| Data model work | **Lowest** (read-side; migration only if denormalised) | Medium (status + issuance exist; policy does not) | Medium |
| Privacy exposure | Low | Low | **Highest** |
| Feeds ranking signal | Some | Some | **Most** |
| Reversible if wrong | **Easily** | Hard (stamps issued) | Moderate |
| Degrades badly when… | post has no place/trip | tag later suppressed | user has location locked down |

**They are not mutually exclusive.** A is a display change, C is a surface
addition, B is a mechanic. They could ship in any order, or together — the
sequencing is itself a decision this document does not make.

---

## 6. Decisions needed

Recorded rather than blocked on, per instruction.

1. **Which direction, or which combination.**
2. **The `tagged_at` rate-limit bug (§1).** Independent of direction, and it
   gets worse if tagging becomes more prominent. Fix is a migration or a
   one-word column change — needs an owner call on which tree is canonical.
3. **For A:** cheap version (avatars only, read-side) or full version
   (context line, denormalised `place_id`/`trip_id`)?
4. **For B:** are co-stamps opt-in or automatic? Recommend opt-in — automatic
   means tagging writes to another user's passport.
5. **For B:** what happens to an issued co-stamp when the tag is later
   suppressed or a block appears? `is_revoked`/`revoked_reason` exist; the
   policy does not.
6. **For C:** is co-presence public, followers-only, or opt-in per user? Needs a
   privacy review before any build.
7. **Do inline `@mention` spans survive?** Removed entirely in favour of the new
   surface, or retained for prose alongside it? A and C both assume prose
   mentions could go away; that is not obviously right for comments and messages.
8. **Does the picker's five-type promise get honoured?** The autocomplete offers
   trips, circles, places and events; only users persist (§1). Either the picker
   is narrowed to users, or `tags` gains a polymorphic target. Today it silently
   offers something it does not store.

---

## 7. Verification note

- Column lists come from `artifacts/api-server/src/lib/database.types.ts`
  (generated from live), cross-checked against the migration files — which
  disagree with each other for `tags`, and that disagreement is the §1 bug.
- `tags.status` vocabulary was read from `migrations/0064_tags_approval.sql`
  directly; the absence of a `CHECK` on it was confirmed by grepping every
  `.sql` in the repo for a constraint on that column.
- The user-only persistence claim was confirmed at **both** ends — the write
  (`TaggingService.processMentions` resolving handles against `profiles`) and
  the read (`enrichSpans.ts:173` selecting `tagged_user_id`) — not from the
  presence of `TagSuggestionType`, which is what produced the error corrected
  in §1.
- The `tagged_at` finding rests on the repo's own two audit scripts naming the
  column as absent live, plus its absence from the generated types.

**Not verified — needs a query against production, which this session cannot
run:**

- How many posts carry a resolvable place *and* trip. This decides whether
  Direction A's context line is the common case or the rare one, and therefore
  whether A is distinctive or just a nicer avatar row (§2).
- Current tag volume per author per hour — i.e. whether the unenforced rate
  limit (§1) is presently being exceeded in practice, or is latent.
- Whether `tags.status` has any rows that are not `'approved'`. With no `CHECK`
  and a default of `'approved'`, the approval path may never have been
  exercised — which would make Direction B's reuse of it less proven than §3
  assumes.

---

## 8. Production evidence (2026-08-08)

Read-only queries via the Supabase Management API, resolving §7's unverified
items. **No writes, no schema changes.**

### 8a. Finding 16 was latent, not exploited

```sql
select count(*), count(distinct tagger_id), min(created_at), max(created_at) from tags;
→ total_tags: 0 | distinct_taggers: 0 | earliest: null | latest: null
```

**The `tags` table is empty. Zero rows, ever.**

So the unenforced 20-tags/hour limit (§1, finding 16) was **never exercised in
production**. No abuse occurred because no tagging occurred. The control was
broken, but the exposure was nil — the bug was latent, not live. That is the
answer to §7's open question, and it downgrades the *urgency* of finding 16
without changing the fact that the control did not work.

The query used `created_at`, the column that actually exists live — which is
itself the demonstration that finding 16's diagnosis was correct.

### 8b. `tags.status` has never been exercised

```sql
select status, suppressed, count(*) from tags group by status, suppressed;
→ (no rows)
```

§7 flagged the risk that Direction B's reuse of `status` was less proven than
§3 assumed. **Confirmed: it is entirely unproven.** With zero rows, no tag has
ever been `pending` or `rejected`, and the approval path has never run. There
is also no `CHECK` constraint on the column (§1). Direction B should treat the
approval workflow as **untested code**, not as working infrastructure.

### 8c. Direction A's context line — available on ~15% of posts

| Measure | Count | of 138 posts |
|---|---|---|
| `trip_id` set | 20 | 14.5% |
| `location_place_id` set | 23 | 16.7% |
| `canonical_place_id` set | **0** | 0% |
| `venue_id` set | **0** | 0% |
| **trip AND some place** | **20** | **14.5%** |

§2's risk was that Direction A degrades to "IG with rounder corners" when a
post has no place or trip. **On this corpus that is the majority case: ~85% of
posts would show the bare avatar row.**

Note `canonical_place_id` is null on every post *and* every `post_media` row —
the column §2 proposed deriving place from is entirely unpopulated. The place
data that does exist is in `location_place_id`. **Any Direction A build should
target `location_place_id`, not `canonical_place_id`.**

### 8d. Decision-ready — not acted on

1. **Direction A's premise is weaker than §2 assumed** (8c). Either accept that
   the context line is a minority affordance, or treat populating place/trip on
   posts as a prerequisite. That is a product call.
2. **`canonical_place_id` is dead everywhere it appears** — posts and
   post_media both 100% null, while `location_place_id` carries the real data.
   Whether that column is abandoned or merely not backfilled is unknown, and it
   is referenced across the codebase. Flagged, not investigated.
3. **Finding 16's fix remains correct and remains worth having** (8a) — an
   abuse control that has never been under load is still an abuse control.
