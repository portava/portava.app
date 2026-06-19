# BACKEND_PASS_1_REPORT.md — Spine (Auth + Profiles + Trips)

First backend pass on Supabase. Ships the durable spine: schema + RLS + service layer +
hooks. REST-first; realtime-ready. NOT yet wired into screens (that's the per-screen swap,
done after you stand up your Supabase project — see steps below).

## Delivered
- TRAVEL_BUDDY_BACKEND_PLAN.md — full data model, migration sequence, privacy principles.
- migrations/0001_spine.sql — profiles, trips, trip_members + enums + triggers + RLS
  (3 tables, RLS on all, 10 policies, signup→profile trigger, owner→member trigger,
  can_see_trip / shares_trip_with helpers to avoid policy recursion).
- src/lib/supabase.ts — client; isSupabaseConfigured guards everything (no crash unconfigured).
- src/services/auth.ts — signUp / signIn / signOut / getSessionUserId / onAuthChange.
- src/services/trips.ts — getMyProfile / updateMyProfile / listMyTrips / getTrip /
  createTrip / updateTrip / deleteTrip / addMember / removeMember. Maps snake_case ↔ camelCase.
- src/hooks/useBackend.ts — useSession / useMyTrips / useTrip, same {data,loading,error}
  shape as the mock hooks for clean screen swap.

## Architecture decisions honored
- Supabase / Postgres (relational fit + RLS + built-in realtime later).
- REST/data-access this pass; tables + mutations designed so realtime enables with NO model
  change. No realtime UI, no translation, no Pulse backend yet.
- Spine first; everything later (plans, attachments, availability, messaging) attaches here.

## RLS summary (enforcement boundary — client never trusted)
- profiles: see your own, or non-private, or someone you share a trip with; write only your own.
- trips: see if owner/member/public; insert only as yourself; update/delete owner only.
- trip_members: see members of trips you can see; owner manages membership.

## Honest status
- Services no-op gracefully until EXPO_PUBLIC_SUPABASE_URL/ANON_KEY are set — app keeps
  running on existing mock screens. Nothing is presented as live until you wire a screen.
- Session stores (attachments, availability) remain session-only until their own backend
  passes (next migrations) — unchanged here.

## SETUP — manual steps only you can do (Claude can't create your project or hold keys)
1. Create a Supabase project; copy Project URL + anon public key.
2. Install the SDK on your Mac:
   npm install @supabase/supabase-js --legacy-peer-deps
3. Add env (e.g. app config "extra" or shell): EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY
4. Supabase SQL editor → paste migrations/0001_spine.sql → Run.
5. Restart: npx expo start --clear

## Wiring a screen (do AFTER setup; one at a time, verify each)
- Trips tab: replace `import { trips } from '../../src/data/cebu'` usage with
  `useMyTrips()` from '../../src/hooks/useBackend' → render data, add loading/empty/error.
  Gate behind useSession().isAuthed (show a sign-in prompt if not authed).
- /trip/[id]: use useTrip(id) for the row; keep mock timeline/plans until those tables land.
- Trip create (/trip/new): call createTrip(...) then navigate to the new id.
Keep mock importable behind a flag until each swap is verified.

## Static checks (this env)
- Escaped-backtick scan: CLEAN
- New TS files brace/paren/bracket balance: BALANCED
- SQL paren balance OK; 3 tables, 3 RLS-enabled, 10 policies, 2 helper fns, 3 triggers
- supabase access isolated to lib/services/hooks — no screen imports the client directly
- NOTE: @supabase/supabase-js resolves only after you `npm install` it on your Mac.

## Files added
TRAVEL_BUDDY_BACKEND_PLAN.md, BACKEND_PASS_1_REPORT.md, migrations/0001_spine.sql,
src/lib/supabase.ts, src/services/auth.ts, src/services/trips.ts, src/hooks/useBackend.ts

## Next passes (attach to this spine)
plans + plan_members → attachments (move AttachmentStore to table) → availability
(move AvailabilityStore to tables) → messaging + translation fields → realtime + presence
→ discovery/Pulse content tables. Each gets its own migration + services + screen swap.

## Summary
The truth-layer foundation is in place: a real relational schema with strict RLS, a clean
typed service layer, and drop-in hooks that mirror the mock hooks. Nothing goes live until
you create your Supabase project and wire screens one at a time — the app keeps running on
mock until then. This is the spine everything else will hang from.
