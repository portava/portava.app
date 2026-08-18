# show_profile_picture_publicly — sweep results and follow-up

**Severity: medium-high per instance (see below). Confidentiality gap, not a build problem.**
Found 2026-08-18 while fixing the passport-cluster leak below. **Passport cluster fixed
in this pass; the 9 items in §2 are NOT fixed — tracked here so the next pass doesn't
have to re-derive the gating model for each route.**

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

## 1. Fixed in this pass (passport cluster)

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
exactly the test written for that route, not a nearby one (see the commit).

## 2. NOT fixed — confirmed instances outside the passport cluster

Each of these has a **different** existing gating model, which is exactly why they
weren't folded into the passport-cluster fix — a uniform patch across nine different
privacy models is how four of them end up wrong while the diff still looks consistent.
Whoever picks this up needs to understand each route's existing gate before touching it,
not just add the column to the select.

1. **`routes/og.ts:257-280,485`** (`resolveEntity("profile")` → `resolveOgImageBytes`).
   Builds `imageRef` straight from `avatar_url` and serves it as real image bytes for a
   link-preview card. Existing gate: none — `resolveProfileVisibility` decides
   full/blocked/etc. but nothing downstream checks the photo flag. Viewer: explicitly an
   anonymous crawler (no `viewerId` at all), same severity class as the og-image.png fix
   above.

2. **`routes/discoverySearch.ts:272,349`** (`searchTravelers`). Existing gate:
   `isPrivate = p.is_private && !isFollowing` — only hides the avatar for a **private**
   profile the searcher doesn't follow. A `is_private=false` (public) profile with the
   photo flag off is not covered by this condition at all; `avatarUrl` falls straight
   through to `p.avatar_url`. Fix has to add a second, independent check, not extend the
   existing boolean.

3. **`lib/mapTravelers.ts:207,296`** (discovery live map). Existing gate: query excludes
   rows where `is_private=true`. No reference to the photo flag anywhere in the query or
   the row mapping. Any authenticated user browsing the map sees the avatar of any
   public, location-opted-in nearby user regardless of the flag.

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

## 4. Suggested approach for §2

Given each route has its own gating model, treat this as nine (or ten) small,
independent fixes rather than one sweep — pipeline them if using a workflow, but review
each diff against its route's *existing* gate individually. Each needs: the column added
to its profile select, a check against `show_profile_picture_publicly !== false` sited
correctly relative to the route's *existing* connection check (don't just bolt it onto
the wrong boolean the way `discoverySearch.ts`'s `isPrivate` would invite), a test for
flag-off/stranger, flag-on, and (where the route has an owner-view path) owner-always,
and the same mutation-proof discipline used in the passport-cluster commit — reverting
the column from the select must fail a test, not just look right.
