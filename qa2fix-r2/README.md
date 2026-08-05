# Portava — QA Round 2 fix bundle (Aug 5) — **revision 2**

This replaces both the earlier `qa-round2` triage bundle and the first version of this
one. Revision 2 exists because your dry-run rejected 5 patches. Read the next section
before anything else.

---

## What the 5 misses actually meant

Your dry-run reported `46 applied · 1 already present · 5 missed`. **Your tree is ahead of
mine, not behind it.** I built the first bundle against a snapshot of the repo that has
since moved. Nothing was written — `--dry-run` touches no files — so there is no mess to
clean up.

I asked for targeted dumps of the five files rather than guessing, and here is what came
back. Three of the five were **already fixed in your tree**, one of them better than my
version. Two of my patches would have **broken the build or caused a regression** if the
anchors had happened to match.

**bug 7f / 7g (event detail location dedupe) — already fixed.** `app/event/[id].tsx` has
its own `formatEventLocationLine` at line 83 with the same dedupe intent, plus a component
test at `app/event/__tests__/EventDetail.locationDedup.component.test.tsx`. And `openMap()`
passes `name: locationName ?? 'Event location'` with no city concatenation, so the maps
deep-link never had the duplication either. **Dropped**, along with **bug 7e** (its import,
now unused).

**bug 7j would have broken the build.** `EventDiscoveryCard.tsx` already declares
`const formatEventLocation` locally at line 36, delegating to the shared
`formatLocationLabel` util. My patch added `import { formatEventLocation }` of the same
name — a duplicate-identifier error. It reported `OK` in your dry-run because the *import
anchor* matched; the collision is two lines further down where the patcher doesn't look.
**Dropped**, with **bug 7k** (already applied on your side).

**minor D — already fixed, and better than mine.** Line 94 calls a shared
`effectiveEventState(event.state, event.startsAt, event.endsAt)` helper
(`src/lib/eventRoleActions.ts:50`) and derives `stateColor` / `stateLabel` from the result;
`STATE_COLOR` and `STATE_LABEL` both carry a `completed` key. My patch was going to inline
the same logic into the component. **Dropped.** Only the RSVP half was genuinely missing,
so `minorD2` is **rewritten** to gate on the existing `displayState` instead of the
`hasEnded` variable my dropped patch would have defined. (In the first bundle `minorD2`
reported `OK` while `minorD` missed — applying that pair would have left you with a
reference to an undefined `hasEnded` and a broken client build.)

**bug 11b — re-anchored.** `VideoThumbnail.tsx` now resolves the poster through
`useHydratedMedia()` and computes an `effectivePosterUri`. Re-anchored onto that, and split
into three patches so each one lands on a small, unambiguous target.

**bug 11c — re-anchored and cut in half.** The half that survives is the real fix: never
pass the `.mp4` URL in as a poster image. The half I dropped was adding `onPress` to the
`<VideoThumbnail>` in `PulseFeedCard`. Your line 391 already has
`onPress={handleMediaCardPress}` on the card, and `VideoThumbnail.tsx:46-53` documents
deliberately that a nested `Pressable` claims the touch responder and swallows taps —
breaking tap-to-open and double-tap-to-stamp. My patch would have undone purpose-built
code.

**Net: 48 patches, down from 52.** Four dropped as already-done, one dropped as a
build-breaker, one rewritten, one re-anchored and trimmed, one split into three.

---

## Corrections to the original triage (still stand)

**Bug 1 (invisible trip plan items) — my root cause was wrong.** I blamed
`TripPlanSection.tsx:110`, `if (buckets.length <= 1) return null`. That line is real but
belongs to `DayChipBar` — it hides the *day-chip strip*, not the items. I traced the rest:
`buildBuckets` handles `'__unscheduled__'` correctly, `TripPlanSection` mounts
unconditionally at `app/trip/[id].tsx:446`, `TimelineView` renders "No items for this
filter." rather than nothing, and the server route plus RLS are sound. **I could not prove
bug 1 statically.** It's in `CLAUDE-CODE-COMMAND.md` as a bounded runtime investigation
with everything I ruled out.

**Bug 4 (trips list shows "Dates TBD") — wrong twice.** (a) `trips.ts:509` is inside
`GET /me/trip-invites/pending`, not a trips-list endpoint; (b) the trips list doesn't call
the API server at all — `listMyTrips()` reads Supabase directly under RLS. The privacy
flags are mapped in `mapTrip()` and **read by nothing**. No privacy conditional to fix.

**Bug 8 (stale bio) — my mechanism was wrong.** I said "invalidate the React Query key."
This app has **zero** React Query usage. The real cause is the 5-minute `FEED_FOCUS_TTL_MS`
focus guard in `app/(tabs)/passport.tsx`, fixed here.

**Bug 10** doesn't have "two filter UIs with separate state" — one shared `active` state,
`toggleQuick`/`toggleSheet` byte-identical; the real defect is a vocabulary mismatch, fixed
here. **Minor E** (Pulse `⋯` overflow) **doesn't exist in the code** —
`PulseHeader.tsx:142-153` renders Filters as a direct icon button, no overflow menu.

---

## What's fixed in here

48 anchored patches plus 2 new files: bugs 2, 3, 5, 6, 7 (composer/invite paths), 8, 9, 10,
11, 14, 15, the mislinked privacy route, the RSVP-on-ended-event minor, and the layover
`window.confirm()` replacement.

Bug 14 (the server past-departure guard) is repeated from the last bundle so this one
stands alone. If you already ran that script it reports "already applied" and does nothing.

## What's NOT fixed, and why

- **Bugs 1, 4** — my asserted causes were wrong (above). Runtime investigation, in the command doc.
- **Bugs 12, 13** — need your live DB. `diagnostics.sql` tells double-insert from double-render.
- **Bug 7 on event detail / EventDiscoveryCard** — already fixed in your tree (above).
- **Minor D badge** — already fixed in your tree (above).
- **Minor: verification rows / readiness rows not tappable, re-tap tab to scroll to top** —
  product decisions, not defects. There is no scroll-to-top convention anywhere in the
  codebase, so "add the convention" means designing one. In the command doc.
- **Minor E** — not reproducible, see above.

## Verification — what I ran, and what I could not

**Ran:**

- `apply.py --dry-run` and a full apply against a tree with your real `VideoThumbnail.tsx`
  substituted in: **bug11a / 11b / 11b2 / 11b3 all OK**, and I read the composed output —
  the state hook, the reset effect, the `&& !posterFailed` guard and the `onError` all land
  in the right places.
- TypeScript **parse** of the composed `VideoThumbnail.tsx`: clean. (This is the check that
  caught my JSX-comment-in-attribute-position bug last round.)
- Everything unchanged from revision 1 keeps revision 1's verification: 52/52 reverse-apply
  and re-apply, idempotent second run, byte-identical output, **client tsc clean, server tsc
  clean, 293 server tests pass / 0 fail**.

**Could not run, and you should know it:**

- **A full typecheck of the three drifted files.** My snapshot doesn't even contain
  `src/services/mediaUrl.ts`, which your `VideoThumbnail.tsx` imports — so `tsc` cannot
  resolve your version here at all. `bug11c` and `minorD2` are one-line changes I verified
  by reading your dumps, not by compiling:
  - `bug11c`: `item.media[0].thumbnail_url ?? item.media[0].url` → `?? null`. `posterUri` is
    typed `string | null | undefined`, so `null` is valid.
  - `minorD2`: `event.state` → `displayState`, which is already in scope at your line 94.
  - **Run the client typecheck after applying.** That is the real check, and it takes 30
    seconds.

## Housekeeping note (not a bug)

`files/travel-buddy/src/lib/location/formatEventLocation.ts` is still needed — the event
wizard, `EventComposerSheet` and the event-invite screen all import it. But your codebase
already has a shared `formatLocationLabel` util that `EventDiscoveryCard.tsx:36` delegates
to. Two utilities doing the same job is debt worth consolidating. It's in the command doc
as a cleanup task, not a fix.

## Contents

```
apply.py                 the patcher — idempotent, safe to run twice
files/                   2 new source files, copied into place by apply.py
CLAUDE-CODE-COMMAND.md   hand this to Claude Code in bash
diagnostics.sql          bugs 12/13/11 — read-only SELECTs
README.md                this file
```

## Apply it

This bundle unpacks to **`qa2fix-r2/`**, a different directory from the first bundle's
`qa2fix/`. Nothing collides, and you can keep both on disk. Just make sure every command
you type says `qa2fix-r2` — running the old `qa2fix/apply.py` by accident is the one way to
get the dropped patches back.

```bash
cd ~/workspace
unzip -o portava-qa2-fixes-r2.zip -d .
python3 qa2fix-r2/apply.py --dry-run    # expect: 48 applied · 0 missed
python3 qa2fix-r2/apply.py
```

Optional, once the dry-run above looks right — retire the old bundle so there is only one
`apply.py` in the workspace:

```bash
rm -rf ~/workspace/qa2fix ~/workspace/portava-qa2-fixes.zip
```

Then verify — **from the project directories, never from `~/workspace`**:

```bash
cd ~/workspace/artifacts/travel-buddy && npx tsc -p tsconfig.json --noEmit
cd ~/workspace/artifacts/api-server   && npx tsc -p tsconfig.json --noEmit
```

Running `tsc` from `~/workspace` produces ~1185 fake TS1382/TS17008 errors — the root
`tsconfig.json` extends `expo/tsconfig.base` and sweeps client `.tsx` files into the server
program. That's the artifact that ate an afternoon last week; it is not a real failure.

Any `MISS` means that file has drifted too. Stop and send me the miss list plus the
surrounding lines rather than forcing it — that's exactly the loop that produced this
revision, and it works.
