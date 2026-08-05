# Claude Code — Portava QA Round 2

You are working in a Replit workspace on Portava: an Expo/React Native client and an
Express/Supabase API server.

```
~/workspace/artifacts/travel-buddy   the client
~/workspace/artifacts/api-server     the server
~/workspace/qa2fix-r2                this bundle  ← use this one
~/workspace/qa2fix                   the SUPERSEDED first bundle, if still present
```

## Rule zero: never run a build from `~/workspace`

Always `cd` into `artifacts/travel-buddy` or `artifacts/api-server` first. The root
`tsconfig.json` extends `expo/tsconfig.base` and sweeps client `.tsx` files into the server
program; running `tsc` from the root emits ~1185 fake `TS1382` / `TS17008` / `TS1109`
errors that have nothing to do with the code. The root has no `tsx` package and no `test`
script either. If you see a four-digit error count, you are in the wrong directory.

## Rule one: verify before you change

Every claim in this document was checked against the real files, but the repo moves. Before
you edit anything, open the file and confirm the code still looks the way this document
says. If it doesn't, say so instead of patching blind. If an investigation below turns up
nothing, **report that it turned up nothing** — a clean "I could not reproduce this, here
is what I ruled out" is a good result. Do not invent a plausible-sounding root cause.

---

# Part 1 — Apply the fixes (mechanical, ~2 minutes)

This is **revision 2** of the bundle. Revision 1 was dry-run against this tree and 5 of its
52 patches missed, because the tree had moved ahead of the snapshot they were written
against. Nothing was written (`--dry-run` writes nothing). Four of those five turned out to
be **already fixed here** and one would have broken the build; they have been dropped or
rewritten.

**Directory matters.** This bundle lives in `qa2fix-r2/`. If `qa2fix/` also exists it is
revision 1 — superseded, and its `apply.py` would reintroduce the build-breaking `bug7j`.
Every command below says `qa2fix-r2`. Do not substitute.

```bash
cd ~/workspace
python3 qa2fix-r2/apply.py --dry-run
```

Expect `48 applied · 0 missed`, or `47 applied · 1 already present` if the standalone
bug-14 layover script from the previous bundle was already run — both are fine. Any `MISS`
means the file drifted again: **stop, and report which patch and what the surrounding code
actually looks like.** Do not re-anchor a patch yourself unless you have read the file and
can say why the new anchor is correct. The script distinguishes "anchor not found" from
"anchor is ambiguous (N matches)".

```bash
python3 qa2fix-r2/apply.py
cd ~/workspace/artifacts/travel-buddy && npx tsc -p tsconfig.json --noEmit
cd ~/workspace/artifacts/api-server   && npx tsc -p tsconfig.json --noEmit
```

Both should be silent. **The client typecheck is load-bearing this round**, not a
formality: three of these patches (`bug11b*` on `src/components/ui/VideoThumbnail.tsx`,
`bug11c` on `src/components/PulseFeedCard.tsx`, `minorD2` on
`src/components/EventDiscoveryCard.tsx`) were written against dumps of these files rather
than a compilable copy, so this is their first real compile. If any of them fails, the
failure is mine — report the error verbatim rather than working around it.

Then the server tests for the touched routes:

```bash
cd ~/workspace/artifacts/api-server
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test --test-force-exit \
  src/test/events.test.ts src/test/events-extension.test.ts \
  src/test/eventCategoryContext.test.ts src/test/eventPostsDiscovery.test.ts \
  src/test/airport.test.ts
```

Expect 293 pass, 0 fail. `apply.py` is idempotent — re-running it is safe and reports
`already present` rather than double-patching.

### Things this bundle deliberately does NOT touch — do not "fix" them

These were patched in revision 1 and removed in revision 2 because the code is already
correct. If you spot them and think they look unfinished, they aren't:

- `app/event/[id].tsx` — `formatEventLocationLine` (line ~83) and `openMap()` already
  handle the city-duplication case, and there's a test at
  `app/event/__tests__/EventDetail.locationDedup.component.test.tsx`.
- `src/components/EventDiscoveryCard.tsx` — `formatEventLocation` (line ~36) is a **local**
  const delegating to the shared `formatLocationLabel`. Do not add an
  `import { formatEventLocation }` — that's a duplicate-identifier build error.
- `src/components/EventDiscoveryCard.tsx` line ~94 already derives `displayState` from the
  shared `effectiveEventState()` helper. Don't inline date logic into the component.
- `src/components/ui/VideoThumbnail.tsx` lines ~46-53 — the `Container = onPress ?
  Pressable : View` split is deliberate. A nested `Pressable` claims the touch responder
  and breaks tap-to-open / double-tap-to-stamp on the feed card. Don't add an `onPress` to
  the `<VideoThumbnail>` in `PulseFeedCard`; the card root already has one (line ~391).

---

# Part 2 — Investigations (the actual work)

These are the items that do **not** have a proven root cause. Each one lists what has
already been ruled out so you don't repeat it. Work them in this order.

## Bug 1 (P0) — trip plan items are invisible after being added

The user adds an item via "Add Plan" or Discovery's "Add to Trip Plan". The item saves.
The Trip Plan section then shows **neither the item nor an empty state** — it's blank.

**Already ruled out, do not re-check:**

- Storage. Both write paths hit `trip_plan_items`; `GET /api/trips/:tripId/plan` reads the
  same table.
- `TripPlanSection.tsx:110` (`if (buckets.length <= 1) return null`). This was named as the
  cause in an earlier triage and **it is wrong**. That line is inside `DayChipBar`, which
  starts at line 102 of the same file — it hides the day-chip strip, not the items.
- `buildBuckets` (line 57) — it handles the `'__unscheduled__'` bucket correctly at line 93.
- Conditional mounting. `TripPlanSection` is rendered unconditionally at
  `app/trip/[id].tsx:446`.
- The empty state exists: line 583, `{!loading && !accessDenied && items.length === 0 && ...}`.
- `TimelineView` renders "No items for this filter." rather than nothing.
- Server route and RLS both look correct.

**The two candidates left**, both in `src/components/TripPlanSection.tsx`:

1. **`accessDenied` is being set.** Line 581 renders `PlanLockedView` / `PendingInviteView`
   when it's true. `load()` (line 291) sets it from a *string match* on the error message —
   `msg.includes('403') || msg.includes('401') || 'forbidden' || 'unauthorized'`. That's
   fragile: any error whose text happens to contain "401" trips it. Check what
   `fetchTripPlan` actually throws when the request fails.
2. **`loading` never goes false.** If the fetch hangs, every render branch is gated on
   `!loading` and the section is genuinely blank — which matches the report exactly.

Instrument `load()` — log the caught error, `accessDenied`, `loading`, and
`items.length` — reproduce it once, and let the log say which one it is. Do not guess.

## Bug 4 — trips list shows "Dates TBD"/blank, detail page is correct

**Already ruled out:**

- `api-server/src/routes/trips.ts:509` — named in an earlier triage, **wrong**: that line is
  inside `GET /me/trip-invites/pending`.
- The privacy-flag hypothesis — **wrong**. `showExactDates` / `showDestinationCity` are
  mapped in `src/services/trips.ts:104-105` and then read by **nothing**. The only other
  occurrences in the client are test fixtures. There is no privacy conditional.
- The list doesn't call the API server at all. `listMyTrips()` (`src/services/trips.ts`)
  goes straight to Supabase: `supabase.from('trips').select('*')` under RLS.

**Leading candidate:** the AsyncStorage snapshot cache. `app/(tabs)/trips.tsx:249`:

```ts
const displayTrips = tripsLoadedOnce ? realTrips : (tripsSnapshot ?? realTrips);
```

Until the first live load completes, the list renders a **stale cached copy**. A trip
created after that snapshot was written shows with whatever the snapshot had — which is how
you get "Dates TBD" on the list and correct dates on the detail page. Verify by clearing
the `trips` snapshot key and reloading. If the dates come back correct, the fix is to merge
fresh rows into the snapshot rather than render the snapshot wholesale, or to shorten the
window where the snapshot wins.

Note the render sites: `app/(tabs)/trips.tsx:86` is the **invite** card's `'Dates TBD'`,
line 434 is the **trip** card's. Make sure you're looking at the one the user saw.

## Bugs 12 and 13 — need the database, not the code

Run `qa2fix-r2/diagnostics.sql` in the Supabase SQL editor first. It is read-only except for
two clearly-commented cleanup deletes.

- **Bug 12 (duplicate share delivery):** the SQL tells you whether there are genuinely two
  `messages` rows (a real double-insert → the share endpoint needs an idempotency key) or
  one row rendered twice (a client bug). Don't fix before you know which.
- **Bug 13 (same caption + video under two authors):** already verified that the `/posts`
  feed is a straight `select` from `posts` with no author-swapping join, so this is almost
  certainly **seed-data duplication**, not a feed bug. The SQL finds the duplicate content
  across authors.

## Minor — product decisions, not defects

Don't guess at these; they need a call from Draie. Write up the options rather than picking one.

- **Dossier verification rows** (Basic / Trusted / Host / Buddy, plus the ID and Selfie
  rows) are status-only. Either wire them to start verification, or style them so they
  visibly aren't buttons. Which one is a product call.
- **Readiness checklist rows** (Plan / Stay / Transport / Budget / Entry) aren't tappable.
  Wiring them means scroll-to-section, and there is no anchor system for that yet.
- **Re-tapping the active Pulse tab should scroll to top.** There is no scroll-to-top
  convention anywhere in this codebase — `grep -rn "scrollToTop\|scrollToOffset\|useScrollToTop" src app`
  returns nothing. This is "design a convention", not "fix a bug".

## Cleanup — duplicate location formatter (low priority, do it last)

There are now two utilities doing the same job:

- `src/lib/location/formatEventLocation.ts` (added by this bundle; imported by the event
  wizard, `EventComposerSheet`, and the event-invite screen) — token-based city dedupe.
- the existing shared `formatLocationLabel` util, which `EventDiscoveryCard.tsx:36` wraps.
- plus `formatEventLocationLine` local to `app/event/[id].tsx:83`.

Three implementations of "name, city without repeating the city". Consolidating them is
worth doing, but it is a refactor with test implications, not a bug fix — check the
behaviour of all three on the same inputs first (they may not agree on substring vs token
matching), pick one, and say which cases changed. Don't do this in the same commit as the
fixes above.

## Minor — closed, do not work on

**Pulse `⋯` overflow with a single item.** No overflow menu exists in the Pulse tab.
`src/components/PulseHeader.tsx:142-153` already renders Filters as a direct icon button.
The report doesn't match the code. If Draie can screenshot it, reopen it.

---

# Part 3 — What to report back

For each investigation: what you ran, what you observed, the root cause **or** an explicit
"not reproduced" with the list of what you ruled out, and the diff if you changed anything.
Don't summarise the mechanical patches in Part 1 — Draie already has that list.
