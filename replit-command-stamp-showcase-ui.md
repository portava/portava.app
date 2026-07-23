# REPLIT AGENT COMMAND — Stamp Showcase + Admire UI (Stamp Wave 2)

## Context — read first

The backend and client services for this feature are ALREADY BUILT and tested.
Do NOT create or modify any backend code, migrations, or API routes. Your job
is mobile UI in `artifacts/travel-buddy` only.

Ready-made client services (fail-soft — they return `null` when the feature
flag is off server-side, and your UI must simply hide itself in that case):

- `src/services/stampShowcase.ts` — `getMyShowcase()`, `saveShowcase(userStampIds)`,
  `getPublicShowcase(username)`, `MAX_SHOWCASE` (8). Items carry
  `{ userStampId, rank, city, country, earnedAt, definition: { name, rarity, artworkUrl, … } }`.
- `src/services/stampAdmire.ts` — `admireStamp(id)`, `unadmireStamp(id)`,
  `getAdmirers(id)` → `{ count, admiredByMe, admirers[] } | null`.

House rules (same as the Trip Brain wave): follow existing component patterns,
respect reduced-motion, add jest-expo component tests for every new component,
no new dependencies, `pnpm --filter travel-buddy exec tsc --noEmit` must stay clean.

## Task 1 — Showcase section on the OWN passport (Stamps tab)

In the stamps tab (`StampsTab` — it currently auto-features the most recent
stamp), add a "Showcase" section at the top:

- On mount call `getMyShowcase()`. `null` → render nothing (flag off).
- Show the curated stamps as a horizontal row (up to 8) using the existing
  stamp artwork components (`StampArtwork` family) at card size, rarity badge
  visible, tap → existing stamp detail modal.
- Empty state (flag on, no items): a subtle "Feature your favorite stamps"
  card that opens the editor.
- "Edit" affordance → curation sheet:
  - Lists the user's own stamps (reuse the existing stamps list data source).
  - Select up to `MAX_SHOWCASE`; selected items can be reordered by drag —
    reuse the existing passport reorder-sheet pattern (the same drag UI used
    for passport section/tab reordering).
  - Save → `saveShowcase(orderedIds)`; optimistic update, revert on `false`.

## Task 2 — Showcase on the PUBLIC passport page

`app/passport/[username].tsx` currently renders NO stamps at all. Add a
"Featured stamps" section:

- `getPublicShowcase(username)`. `null` OR `[]` → render nothing.
- Same horizontal row presentation as Task 1, read-only, tap → stamp detail
  (public variant — no owner controls).

## Task 3 — Admire on stamp detail surfaces

On BOTH stamp detail surfaces (`StampDetailModal` and `app/stamp/[stampId]` —
they share internals; extend the shared part):

- On mount call `getAdmirers(userStampId)`. `null` → hide everything admire-related.
- Viewing someone ELSE's stamp: show an admire button (sparkle/heart per the
  app's icon set) with the count. Tap toggles `admireStamp`/`unadmireStamp`
  optimistically (flip `admiredByMe` + count; revert on failure). Respect
  reduced-motion for any animation.
- Viewing OWN stamp: show the count only (no button) when count > 0.
- Tapping the count opens an admirers sheet: avatar + display name + username
  rows (data is already in `admirers[]`), tap row → that user's profile.

## Explicitly OUT of scope

Backend/API/migrations; push notification handling (server already emits
`passport.stamp_admired` in-app notifications); any change to stamp earning,
generation, or artwork rendering; the admin app.

## Acceptance

- Flag off (services return null): zero visual change anywhere.
- Showcase: curate → reorder → save → survives reload; public page shows only
  what the owner made public (server filters; UI must not re-filter).
- Admire: toggle works optimistically; self-admire button never shown.
- Component tests for: showcase row, curation sheet save/reorder, public
  section hidden-when-empty, admire toggle, admirers sheet.
- `pnpm --filter travel-buddy exec tsc --noEmit` clean; test suite green.
