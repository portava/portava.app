# Travel Buddy — Posts UI wiring (composer + live feed round-trip)

Wires the REAL posts round-trip into the UI:
  composer Share -> createPost (API) -> DB -> Pulse refetch on focus -> post shows.

Prereq: the posts FRONTEND client must already be applied
(src/services/posts.ts + src/hooks/usePosts.ts from the previous package).

## Files -> exact paths (place individually; never drop a folder over src/)
    travel-buddy/app/create.tsx                 -> artifacts/travel-buddy/app/create.tsx                (REPLACE — Share now calls createPost)
    travel-buddy/app/(tabs)/index.tsx           -> artifacts/travel-buddy/app/(tabs)/index.tsx          (REPLACE — adds Live posts section + focus refetch)
    travel-buddy/src/components/RealPostsList.tsx-> artifacts/travel-buddy/src/components/RealPostsList.tsx (NEW)
    travel-buddy/src/services/posts.test.ts     -> artifacts/travel-buddy/src/services/posts.test.ts    (NEW — frontend mapping tests)

## What changed
1. app/create.tsx — the composer's "Share" button now:
   - calls usePostActions().create({ content, visibility })
   - prepends the chosen category as a [tag] in content (no category column yet)
   - maps UI visibility Public->public, Private->private (Friends dropped; no
     trip context here so trip_only isn't offered on standalone composer)
   - shows a spinner while submitting, disables until there's text
   - shows a friendly error per errorKind; on success does router.back()
2. app/(tabs)/index.tsx — adds a "Live posts" section (RealPostsList) fed by
   useGlobalFeed(), placed above the Pulse Wall. Uses useFocusEffect to refetch
   whenever the screen regains focus (so a newly created post appears from a
   REAL GET, not optimistic state). Existing mock Pulse cards remain intact.
3. RealPostsList.tsx — simple cards: author short id, content, visibility badge,
   relative time, trip label if attached. Loading/empty/error states.

## Verify
    cd artifacts/travel-buddy
    npx tsc --noEmit
    node --import tsx/esm --test src/services/posts.test.ts   # 4 mapping tests

Then the LIVE round-trip (the real proof):
  1. Sign in. Open Pulse — "Live posts" shows empty or existing posts.
  2. Tap + / Post Update -> composer.
  3. Type text, choose Public, Share.
  4. On return to Pulse, the new post appears in "Live posts" (from a real GET).
  5. Confirm in Supabase: select id, author_id, content, visibility from posts;

## CAVEATS (could not run tsc / full RN here — verify on Replit)
1. useFocusEffect is imported from 'expo-router'. It IS a standard expo-router
   re-export. If tsc somehow flags it in this version, change the import to:
       import { useFocusEffect } from '@react-navigation/native';
   (expo-router depends on it, so it resolves.)
2. The frontend service tests (posts.test.ts) cover response/error mapping but
   NOT the full createPost fetch flow (cleanly mocking the supabase ESM import
   needs a loader). The backend's 20 tests prove authorization; the live UI test
   proves the round-trip.
3. Category is not persisted (no column) — it's prepended to content as [tag].
   A future migration can add a category column if desired.

## Boundaries kept
No service-role key on client. No direct supabase writes for posts. author_id is
server-derived. No optimistic faking — the feed proves the save via real GET.
Private/trip_only never enter the global feed (server-enforced; feed is public
standalone only).

## Next (after this passes)
Map PostRow into the rich PulseFeedCard union so real posts blend into the full
Pulse design (instead of the separate "Live posts" strip).
