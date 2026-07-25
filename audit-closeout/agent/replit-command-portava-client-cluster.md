# REPLIT AGENT COMMAND — Portava client cluster (audit CL-* + API-02 + SEC-01 UI)

From the Portava master audit (2026-07-24). These are all **client-only** fixes in
`artifacts/travel-buddy` — no api-server, migrations, or SQL. The server-side audit
repairs (API-01 Rent-a-Buddy routing, SEC-01 private-profile visibility, SEC-04/05
event authz, API-03 `/events/following`) are already applied on the server, so the
matching client work below can now light up. Verify each finding against the current
client code before changing it (the client has moved since the audit) and report any
that no longer reproduce.

## P1 — broken navigation / dead endpoints
1. **API-02 — event "Share" calls a nonexistent endpoint.** `src/services/events.ts`
   posts to `/events/:id/share`, but the server route is `POST /events/:id/share-link`
   (returns `{ shareUrl }`). Fix the client path + map the response. Verify Share now
   returns a working link.
2. **CL-01 — Compass settings link dead-ends.** `components/compass/CompassPicksSection.tsx`
   (~line 186) navigates to `/compass-settings`, which doesn't exist; the real route is
   `/compass-preferences`. Fix the target.
3. **CL-02 — `/events` route collision.** Two screens resolve to `/events`
   (`app/(tabs)/events.tsx` and `app/events/index.tsx`) with divergent content →
   nondeterministic destination. Merge them or move one to a distinct path, and point
   all inbound links at the survivor.
4. **CL-03 — `/messages` duplicate route.** Two inbox wrappers
   (`app/(tabs)/messages.tsx`, `app/messages/index.tsx`). Collapse to one.

## P2 — reachability, tappable identities, states
5. **CL-04 — post edit unreachable.** `app/post/edit/[id].tsx` exists but no owned-post
   surface links to it. Add an "Edit" affordance on the post detail/overflow menu for
   the author.
6. **CL-05 — user identities not tappable.** Wherever a user's name/avatar appears it
   should deep-link to their profile (`/u/[username]`), subject to privacy/blocking.
   Known gaps: event attendees (`app/event/[id].tsx`), DM thread header
   (`app/messages/[id].tsx`), trip inviters (`app/(tabs)/trips.tsx`), review authors.
   Add the standard profile-link wrapper to each.
6b. **SEC-01 UI (paired with the shipped server fix) — private-profile follow becomes a
   request.** The server now requires an accepted friendship (not a raw follow) to view
   a private profile. On a **private** target, the follow button should present as
   **"Request"** and go through the existing friend-request flow (`friend_requests`),
   and surface `is_friend` / pending state from the passport `viewer` object. On public
   targets, follow stays as-is.
7. **CL-06 — map place pins are a no-op.** `app/map/index.tsx` (~line 618) passes
   `onSelectPlace={() => {}}`. Wire pin taps to the place preview / detail
   (`/place/:id`) using the canonical place envelope.
8. **CL-11 — missing loading/empty/error states.** Add deliberate states to: discovery
   buddy strip, map places, Rent-a-Buddy "Available Now", and the deleted-event body.

## P2 — feature-flag gating (prevents dead entry points)
9. **FL-08 — gate client entry points on server flags.** Today only ~2 flags are read
   client-side, so server-gated features render entry points that dead-end. Fetch the
   feature-flag set on launch and hide/disable entry points whose backend flag is off
   (e.g. map search, stamp showcase/admire, external-places UI). Fail-soft: unknown
   flag → treat as off for gating, but never crash.

## P3 — cleanup
10. **CL-07/08/09 — remove dead/orphaned screens** with no inbound route: `create-tab`,
    `language-picker`, `report-history`, `saved-profiles`, `circle-chat`, `memory/create`,
    `gems/admin`, the dead `admin/*` pages, and the duplicate `buddy-dashboard/*` variants.
    Confirm each is truly unreferenced before deleting.

## Separate, already-speced
- **SEC-02 media hydration** — see `replit-command-portava-media-hydration.md`. That one
  gates the private-bucket cutover and should be done first among the media work.

## Acceptance
Every button reaches a real destination; every user identity is tappable (privacy
permitting); private-profile follow is a request; map pins open place details; no
screen advertises a feature whose backend flag is off; no orphaned routes remain.
Report anything that didn't reproduce or that you changed differently, with the reason.
