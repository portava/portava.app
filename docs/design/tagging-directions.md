# Tagging — display directions

**Scoping only. Three directions, deliberately not narrowed to one** — the
owner asked for options, and picking is a design decision.

Date: 2026-08-08.

---

## 1. What exists today

**Today's tagging is the Instagram/Facebook pattern.** `RichText.tsx` renders
user-generated text with tappable `@mention` and `#hashtag` spans, resolved
from the `tags` and `hashtag_usage` tables. Tagging *is* a text annotation.

```
tags: id, tagger_id, tagged_user_id, source_type, source_id,
      status, suppressed, suppressed_at, created_at
```

Supporting pieces that already work and should be preserved by any direction:

- **Consent model** — `TagPermission = 'anyone' | 'interacted' | 'friends_only'
  | 'nobody'`, enforced server-side in `interactionPermissions.ts` via
  `who_can_tag`.
- **Self-removal** — `removeSelfTag()` + `suppressed` soft-delete
  (migration 0046), with partial indexes for both directions.
- **Safe degradation** — blocked/deleted/private tags render as plain text, no
  link, no press. This is good behaviour and every direction below inherits it.
- **Entity breadth** — `TagSuggestionType` already covers
  `user | trip | circle | place | event`. **The data model is already richer
  than the display.** Today all five collapse into the same inline blue span.

That last point is the opening. Portava already knows a tag is *"this person,
at this place, on this trip"* and throws that structure away at render time.

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

- Overlapping avatar cluster, then names, then the place/trip line.
- Caption text is left alone — no blue spans in prose at all.
- Tapping the cluster opens a sheet listing companions **with the shared
  context**: "you and Ana were both at Sunset Point on 12 May".

**Why it is Portava and not IG:** Instagram's tag answers *who is in this
photo*. This answers *who you travelled with*, which is the thing Portava's
graph actually knows and the thing that seeds Telegraph conversations and
future meetups.

**Data model:** none new required. `tags` already has `tagged_user_id` and a
`source_type`/`source_id` that resolves to a post which resolves to a place and
trip. Needs a **read-side join** (tag → source → place/trip) and a display
component. Optionally denormalise `place_id`/`trip_id` onto `tags` for query
cost — that would be a schema change.

**Risk:** if a post has no place or trip context the strip degrades to a plain
avatar row, which is just IG with rounder corners.

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
- A tag you accept becomes **part of your own travel record** — an asset, not
  an obligation to untag.

**Why it is Portava and not IG:** it inverts the incentive. On Instagram a tag
is something done *to* you and the primary UI affordance is removal. Here it is
something you *collect*, which is the passport/stamp mechanic the product
already has. Nobody else can copy this because nobody else has the passport.

**Data model:** the largest of the three.
- Tags need an **acceptance state** — the existing `status` column may already
  serve, but its current vocabulary needs checking before relying on it.
- A link from an accepted tag to stamp issuance, reusing the existing stamp
  catalogue and issuance path.
- Rules for what a co-stamp means if one party later removes the tag or blocks.
- Almost certainly a schema change.

**Risk:** highest complexity, and it entangles tagging with the stamp
economy — a bug here devalues stamps, which are a core currency. Also needs a
decision on whether co-stamps are auto-granted or opt-in (recommend opt-in;
auto-granting makes tagging a way to write to someone else's passport).

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
history* rather than a claim on a person. It also feeds Compass directly:
co-presence at a place is a strong, explicit social-plus-location signal, and
`docs/feed-algorithm-signal-audit.md` §2 flags Social Connection and
Location Relevance as two of the seven score components.

**Data model:** medium. Needs a reliable `place_id` on the tag path — today
that is derived through the source post's canonical place
(`post_media.canonical_place_id` exists). A grouping query ("tags sharing a
place and a time window") is new but read-side only. **No new user input.**

**Risk:** a location-privacy surface. `mediaProcessing.ts` strips EXIF GPS
deliberately, and `rankLog` strips raw coordinates before insert — this
direction publishes *co-presence*, which is more sensitive than either, and
would need its own privacy review and probably its own visibility control.

---

## 5. Comparison

| | A — Companion strip | B — Passport co-stamp | C — Place presence |
|---|---|---|---|
| Distinctiveness | Medium | **Highest** | High |
| Data model work | **Lowest** (read-side only) | Highest (schema + stamps) | Medium |
| Privacy exposure | Low | Low | **Highest** |
| Feeds ranking signal | Some | Some | **Most** |
| Reversible if wrong | **Easily** | Hard (stamps issued) | Moderate |

They are **not mutually exclusive.** A is a display change; C is a surface
addition; B is a mechanic. A plausible sequence is A first (cheap, reversible,
immediately non-IG), then C, then B once the stamp implications are decided —
but that sequencing is itself a decision I am not making.

## 6. Decisions needed

1. Which direction, or which combination.
2. For B: are co-stamps opt-in or automatic? (Recommend opt-in — automatic
   means tagging writes to another user's passport.)
3. For C: is co-presence public, followers-only, or opt-in per user? This
   needs a privacy review before any build.
4. Does the existing `TagPermission` consent model carry over unchanged? It
   should, and every direction above assumes it does.
5. What happens to inline `@mention` spans — removed entirely, or retained for
   prose alongside the new surface?
