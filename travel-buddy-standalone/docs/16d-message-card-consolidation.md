# 16d — Can `PostCardMessage` / `DiscoveryCardMessage` become thin wrappers over `SharedEntityCard`?

Status: **report only. No migration performed.**

## Verdict

**Not as thin wrappers.** `PostCardMessage` can become a *moderately* thin
wrapper if you accept a visual change and add one adapter.
`DiscoveryCardMessage` cannot without changing behaviour users would notice.

The blocker is not styling. It is that `SharedEntityCard` takes a
`ShareableEntity` — a normalized, in-memory value produced by
`shareAdapters.ts` — while the two message cards take a **persisted JSON wire
format** off a Telegraph message row. Those are different contracts with
different compatibility obligations, and the second one has rows already in the
database.

## What each component actually is

| | `PostCardMessage` | `DiscoveryCardMessage` | `SharedEntityCard` |
|---|---|---|---|
| Input | `{ body: string, mine: boolean }` — JSON parsed at render | same | `entity: ShareableEntity` |
| Source of input | `post_card` message body, written by `ShareSheet` | `discovery_card` message body, written by `DiscoveryShareSheet` | adapters, at call time |
| Fields rendered | 8 | 7 | 3 (+1 optional `meta`) |
| Actions | 1 (View Post) | 3 (View / Add to Plan / Save) | 0 — caller supplies `footer` |
| Owns modal state | no | **yes** (`TripWishlistPicker`) | no |
| Performs writes | no | **yes** (`toggleSave`) | no |
| Parse-failure state | "Shared post" | "Discovery card" | none — assumes a valid entity |

## What breaks

**1. Field loss — the preview renders three lines, the cards render seven or eight.**
`ShareEntityPreview` is deliberately fixed-shape: image, title, subtitle, and
one optional `meta` line. `PostCardMessage` shows author name, handle, avatar,
thumbnail, snippet, location, stamp count, comment count, and the sender's
caption. You cannot express that in three lines without either dropping fields
or overloading `subtitle`/`meta` with concatenated strings — which is exactly
the per-surface special-casing `ShareEntityPreview`'s docblock says it exists to
prevent. Widening the preview to serve chat bubbles would push chat concerns
into the shared component and degrade it for the share sheet.

**2. The sender's caption has nowhere to live.**
`payload.caption` is the note the *sender* attached when sharing. It is a
property of the message, not of the entity, and `ShareableEntity` correctly has
no field for it. Anything you do here — a fourth preview line, a `meta`
overload — models it wrongly.

**3. Routing changes for discovery.**
`DiscoveryCardMessage` pushes `/(tabs)/discovery?placeId=<id>`. `appRouteFor`
for a `place` entity returns `/place/<id>` (`shareAdapters.ts:487-506`). Those
are different screens. `SharedEntityCard` routes via `appRouteFor` by design —
its docblock states a card and the link inside it must never land in different
places — so a wrapper would either change where users land or have to pass
`onPress` to override, at which point it is not really adopting the shared
routing.

**4. Three actions and a modal do not fit the footer.**
`SharedEntityCard`'s `footer` is a single row with one `minHeight`. It can hold
three buttons visually, but `DiscoveryCardMessage` also owns `TripWishlistPicker`
modal state and performs a real `toggleSave` write with success/failure alerts.
That state has to live in the wrapper, and the wrapper then renders a `Modal` as
a sibling of a card whose entire body is a `Pressable`. Workable, but it is not
a thin wrapper — it is the same component with a different card frame.

**5. Visual regression in Telegraph.**
The message cards use Telegraph tokens (`TG.surfaceRaised`, `TG.recvBorder`),
`maxWidth: 280`, an asymmetric bubble tail (`borderBottomLeftRadius: 4`, flipped
for `mine`), a brand header badge ("POST" / "DISCOVERY"), and a per-category
accent chip. `SharedEntityCard` uses `color.paperRaised` / `color.haze`, uniform
`radius.md`, no tail, no brand header. `mine` also differs: the message cards
invert to `color.signal`, `SharedEntityCard` to `color.deep`. Migrating changes
how every shared card in every chat thread looks. That is a design decision, not
a refactor.

**6. Nested pressables and the accessibility contract.**
`SharedEntityCard` wraps its whole body — including `footer` — in a `Pressable`
with `accessibilityRole="button"` and an "Opens this post" hint. Both message
cards already contain their own interactive children (`UserIdentityLink` on the
author row, the action buttons). Nesting buttons inside a button gives screen
readers an ambiguous tree and gives the outer card a hint that is wrong for
taps that land on an action.

**7. No parse-failure path.**
Both message cards degrade to a labelled placeholder when the JSON is malformed
or missing its id — real defensive handling for a persisted format that has
changed over time. `SharedEntityCard` has no equivalent because it never sees
untrusted input. The wrapper must keep that branch and return early *before*
constructing an entity, so the "wrapper" starts with a guard clause the shared
component knows nothing about.

**8. An adapter is required, and it is a compatibility surface.**
`PostCardPayload` → `ShareableEntity` needs `entityType: 'postcard'` plus
`metadata.postId` (that is what `appRouteFor` reads for postcards —
`shareAdapters.ts:522-525`), `imageUrl` from `thumbnail`, `creator` from the
three author fields, `location` from `city`/`country`. That adapter must stay
tolerant of every historical `post_card` body already in the database, because
old messages re-render with new code.

## What is genuinely shareable today

Worth doing independently of any migration:

- **`Avatar`** — both cards hand-roll an avatar with a bare `<Image>` and an
  icon fallback. `Avatar` (16c) already does this. See the media diagnosis: both
  of those bare `<Image>` sites are also blank-box bugs.
- **`appRouteFor`** — `PostCardMessage`'s hand-built
  `` `/post/${encodeURIComponent(id)}` `` duplicates `APP_ROUTES.post`. Route
  construction should not be hand-rolled anywhere.
- The **thumbnail** in both cards should go through `DisplayMediaImage`.

## Recommendation

Do not migrate. Take the three shared primitives above — they are pure wins with
no behavioural or visual risk, and two of them are blank-box bug fixes we need
anyway.

If consolidation is wanted later, the honest framing is not "make them wrappers"
but "decide whether a Telegraph card and a share-sheet preview are the same
component". Right now they are not: one is a chat bubble with brand chrome,
multiple actions and a persisted wire format; the other is a fixed three-line
preview of a normalized entity. `SharedEntityCard`'s own docblock already says
this — it explicitly scopes itself out of replacing them.
