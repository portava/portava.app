# show_profile_picture_publicly — sweep results and follow-up

**Severity: medium-high per instance (see below). Confidentiality gap, not a build problem.**
Found 2026-08-18 while fixing the passport-cluster leak below.

**STATUS as of 2026-08-18: PAUSED, mid-sweep, by owner instruction — not a stopping
point chosen for technical reasons.** The passport cluster (§1a) is merged to
`origin/main`. `discoverySearch.ts` (§1b) is merged to `origin/main`. `mapTravelers.ts`
(§1c) is committed on branch `claude/avatar-privacy-sweep-20260818` and is
**NOT merged** — the owner changed policy mid-sweep to "nothing merges without an
explicit handback" and separately reprioritized: the migration-tree reconciliation
work is now P0, and this sweep is not being continued past mapTravelers.ts for now.
**Seven of the nine §2 instances remain untouched**: `og.ts`, `pulse.ts`,
`featured.ts`, `hashtags.ts`, `tags.ts`, `discovery.ts`, `stampAdmire.ts` — plus the
still-unconfirmed `mediaFeed.ts`. Whoever resumes this: start from §2, the per-route
gating models there are still accurate and nothing about them changed in this session.

---

## 0. Background

`profiles.show_profile_picture_publicly` (added by
`artifacts/api-server/src/migrations/20260808_header_image_privacy.sql`, default `true`)
lets a user hide their avatar from the public. Its promise, per the privacy-screen copy
(`travel-buddy-standalone/app/profile/edit/privacy.tsx:256`): *"when off, only followers
and friends can see your profile photo."*

The column has flip-flopped in and out of `mediaAccess.ts` and `passport.ts` three times
in git history (`1f3aa3f3a` → reverted → `f054ca05c` restored → `237d62c20` reverted again
with a since-false "column doesn't exist in the live DB" justification) because earlier
passes needed to ship before the migration landed. The migration is now live in
production; this pass restored the original correct logic in both files plus fixed two
more instances discovered in the same file (`passport.ts`'s `/profile` and
`/og-image.png` routes, which never went through the gate at all). See commit for the
passport-cluster fix and its mutation-proof.

## 1. Fixed

### 1a. Passport cluster — merged to origin/main

- `artifacts/api-server/src/lib/mediaAccess.ts` — avatar BYTES gate (`avatars/` storage
  path prefix only). Restored verbatim from `1f3aa3f3a`/`f054ca05c`.
- `artifacts/api-server/src/routes/passport.ts` `GET /users/:username/passport` — the
  JSON URL gate in `lib/privacy/profileSerializers.ts` was already correct; the column
  just wasn't in `PUBLIC_PROFILE_COLUMNS`/`_FALLBACK`. Fixed by adding it back.
- `artifacts/api-server/src/routes/passport.ts` `GET /users/:username/profile` — never
  went through the serializer at all; returned `avatarUrl` unconditionally. Added the
  column to the select and a `showAvatar` gate mirroring the serializer's
  owner/followers_only bypass.
- `artifacts/api-server/src/routes/passport.ts` `GET /users/:username/og-image.png` —
  same missing gate, but the most severe of the three: this route's own comment states
  requests "come from crawlers — always unauthenticated." It served the avatar of a
  user who'd switched the setting off to literally anything that fetches a link
  preview — Slack unfurls, iMessage previews, share bots — no auth wall to hide behind.

All four verified with a mutation test: reverting the column out of each select fails
exactly the test written for that route, not a nearby one.

### 1b. `routes/discoverySearch.ts` (`searchTravelers`) — merged to origin/main

Fixing the column alone would have been wrong. The route's existing gate — `isPrivate =
is_private && !isFollowing` — governs whether the *account* is private, not the photo
flag; a public profile with the flag off fell straight through. But there was a SECOND
defect underneath: the privacy copy promises "followers **and friends**", and this route
only ever recognized follows — there was no friendship check anywhere in it. Fixing just
the flag would have produced a gate that was correct about privacy and wrong about who
counts as an insider, denying an accepted friend a photo they're entitled to see. Fixed
by adding a `friendSet` alongside the existing `followingSet`, queried from
`user_friendships`, which stores the NORMALIZED `(min, max)` UUID pair rather than
requester/acceptor — both query directions are required, and the two tests covering each
direction are not redundant with each other. Mutation-proof: 1 of 55 fails.

### 1c. `lib/mapTravelers.ts` (discovery live map) — committed, NOT merged

On branch `claude/avatar-privacy-sweep-20260818` only. Architecturally the hardest of
the three fixed so far: this module's candidate list is a **shared, viewer-independent
cache** (20s TTL per rounded viewport, so every client polling the same area shares one
DB round-trip). Follow/friend status is inherently viewer-specific, so it cannot be
baked into `avatarUrl` at cache-build time — doing so would leak one viewer's follow
graph into every other viewer's response for the same cached candidates. Fixed by
carrying the raw flag (`showProfilePicturePublicly`) on an internal `CachedTravelerRow`
type that never leaves the module, and resolving the follow/friend check — batched,
same normalized-pair handling as discoverySearch — per request, AFTER the cache, in the
same place self/block filtering already happens. The final response is always a freshly
built `MapTravelerPayload` per row (never the cached object by reference), so the
internal flag can't leak into the JSON response; a test asserts that directly. A second
test proves the cache-sharing property specifically: one viewer with a follow
relationship populates the cache, a second unconnected viewer polling the same viewport
within the TTL still gets `avatarUrl: null`. Mutation-proof: 2 of 21 fail (the two tests
that depend on the flag actually being read).

## 2. NOT fixed — confirmed instances outside §1 (untouched this session)

Each of these has a **different** existing gating model, which is exactly why they
weren't folded into a single sweep — a uniform patch across nine different privacy
models is how four of them end up wrong while the diff still looks consistent. Two
routes in this list (`discoverySearch.ts`, `mapTravelers.ts`) have since been fixed —
see §1b/§1c — and are left here struck through rather than deleted, so the numbering and
original analysis stay intact for reference. The other seven, plus the one unconfirmed
instance, are exactly as they were when first found; nothing here has changed.

1. **`routes/og.ts:257-280,485`** (`resolveEntity("profile")` → `resolveOgImageBytes`).
   Builds `imageRef` straight from `avatar_url` and serves it as real image bytes for a
   link-preview card. Existing gate: none — `resolveProfileVisibility` decides
   full/blocked/etc. but nothing downstream checks the photo flag. Viewer: explicitly an
   anonymous crawler (no `viewerId` at all), same severity class as the og-image.png fix
   in §1a.

2. ~~`routes/discoverySearch.ts:272,349` (`searchTravelers`)~~ — **FIXED, see §1b.**

3. ~~`lib/mapTravelers.ts:207,296` (discovery live map)~~ — **FIXED, see §1c.**

4. **`routes/pulse.ts:157,351`** (main public post feed, `visibility='public'`, no
   follow filter). Existing gate: none — this is a fully public feed by design; the
   author's avatar is joined and returned unconditionally to any authenticated viewer.
   The flag has never been wired into this join.

5. **`routes/featured.ts:40,115,195,258,321`** (curated "Featured"/Portava's-picks feed).
   Same shape as pulse.ts — no existing gate, unconditional `avatarUrl:
   profile.avatar_url`, viewer is any authenticated user browsing Featured (not
   necessarily a follower of the featured creator).

6. **`routes/hashtags.ts:579,603,615,625`** (hashtag feed — both the `posts` tab and the
   `people` tab). Same shape — no existing gate on either tab.

7. **`routes/tags.ts:237,329`** (@-mention / tag autocomplete search). Existing gate:
   filters by `tag_permission` — an unrelated setting governing who can be *tagged*, not
   who can *see the tagger's avatar while typing an @-mention*. The searcher need not be
   connected to the suggested user at all.

8. **`routes/discovery.ts:2041,2105`** (community "hidden gems" discovery-by-city feed).
   Existing gate: none on the `submitted_by` profile join — any authenticated viewer of
   that city's feed sees the submitter's avatar.

9. **`routes/stampAdmire.ts:174,189`** (list of users who admired a stamp). Existing
   gate: `canSee(stamp, ...)` — governs whether the viewer can see the *stamp*, not
   whether they're connected to each *admirer* listed underneath it. A public stamp's
   admirer list leaks every admirer's avatar to any viewer who can see the stamp.

Before starting any of the remaining seven, check whether it has the same shape as §1b
or §1c did — a second defect (missing friendship check, a shared cache, something else)
hiding under the missing column. That pattern has now shown up in 2 of 3 routes fixed
past the passport cluster; treat it as the default expectation, not a surprise.

**Likely but unconfirmed** (ran out of investigation budget, not folded into the
confirmed nine above): `routes/mediaFeed.ts:150,402` — appears to share the same
`PROFILE_COLUMNS`/`GEM_PROFILE_COLUMNS` shape as `pulse.ts`/`featured.ts`, but the
response-construction line where `avatarUrl` actually gets assigned wasn't traced to
confirm it's unconditional. Check this first if resuming — it may turn out to be a
tenth confirmed instance or may already be gated by something not yet found.

## 3. Deliberately ruled OUT — checked, not applicable

The toggle governs visibility to a genuinely public/unconnected viewer. These surfaces
are relationship-scoped by construction — the viewer already has some other
access relationship to the owner — so the toggle isn't what governs them. Recorded here
so the next person doesn't have to re-investigate and possibly reach a different
conclusion:

- `routes/groupChat.ts`, `routes/circle.ts`, `routes/closeFriends.ts` — viewer is a
  fellow member of the same chat/circle/close-friends list.
- `routes/calls.ts`, `lib/calls/callSignaling.ts` — viewer is on the same call.
- `services/tripCrew/TripCrewLocationService.ts`, `routes/profileTabs.ts` — viewer is a
  fellow trip member / circle member.
- `routes/wellKnownShare.ts` — delegates its `imageUrl` to the already-fixed
  `passport.ts` `og-image.png` route; no independent leak.

## 4. Suggested approach for the remaining seven (+1 unconfirmed)

Given each route has its own gating model, treat this as seven (or eight) small,
independent fixes rather than one sweep — one commit per route, not merged until
reviewed, is the pattern §1b and §1c already followed. Each needs: the column added
to its profile select, a check against `show_profile_picture_publicly !== false` sited
correctly relative to the route's *existing* connection check (don't just bolt it onto
the wrong boolean the way `discoverySearch.ts`'s `isPrivate` would have invited), a test
for flag-off/stranger, flag-on, and (where the route has an owner-view path)
owner-always, and the same mutation-proof discipline used in every fix so far —
reverting the column from the select must fail a test, not just look right. And per §2's
closing note: check first whether the route has a second defect hiding under the missing
column (a missing friendship check, a shared/cached candidate list, something else
specific to that route's architecture) before assuming the fix is just "add the column."
