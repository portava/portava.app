# TRAVEL_BUDDY_BACKEND_PLAN.md

Backend truth layer on **Supabase** (Postgres + Auth + RLS + Storage + Realtime).
REST-first this pass; schema designed so Realtime turns on later with no model change.

This pass ships the **durable spine only**: Auth + Profiles + Trips + trip_members,
with RLS and real persistence replacing session/mock state. Everything later attaches here.

---

## 0. Decisions locked
- Stack: Supabase. Relational data (users/trips/plans/messages/availability/attachments)
  maps to Postgres far better than documents; RLS fits the strict privacy rules; Realtime
  is built-in for the next pass.
- This pass: REST/data-access + schema + RLS + persistence. NO realtime UI, NO translation,
  NO Pulse backend yet — but tables/mutations are designed so realtime enables cleanly.
- First slice: Auth + Users + Trips (the spine). Build durable foundation before messaging/
  translation/realtime.

## 1. Full target data model (built incrementally; spine = bold)
- **profiles** — 1:1 with auth.users (handle, name, avatar, home/current city, travel_style,
  interests[], verified, open_to_meet, is_private, bio)
- **trips** — owner_id, title, destination city/country, dates, status, visibility, cover, etc.
- **trip_members** — (trip_id, user_id, role) — owner/member/invited
- plans — trip_id?, host_id, title, time, location, status, attendee_count
- plan_members — (plan_id, user_id, status: joined/requested/hosting)
- places / hidden_gems / city_notes — discovery content (later; seeded provisional today)
- attachments — source→target links (replaces session AttachmentStore)
- availability_weekly / availability_trip_windows — replaces session AvailabilityStore
- message_threads / thread_members / messages — messaging (+ translation fields) (later)
- blocks — blocked users (privacy)
- saved_items — user saves (Discovery/Trip Saved Ideas)

## 2. Spine schema (this pass) — see migrations/0001_spine.sql
profiles, trips, trip_members + enums (trip_status, trip_visibility, member_role).
- profiles.id = auth.users.id (FK, on delete cascade). A trigger creates a profile row on signup.
- trips.owner_id → profiles.id. trip_members links users to trips with a role.
- updated_at maintained by trigger. All tables have created_at.

## 3. RLS policies (this pass)
profiles:
- SELECT: a profile is visible if it's yours, OR not private, OR you share a trip with them.
- UPDATE/INSERT: only your own row.
trips:
- SELECT: visible if you're the owner, a member, OR visibility = 'public'.
- INSERT: owner_id must equal auth.uid().
- UPDATE/DELETE: owner only.
trip_members:
- SELECT: rows for trips you can see.
- INSERT/DELETE: trip owner manages membership (self-join later via invite flow).
(All policies written so realtime subscriptions inherit the same visibility.)

## 4. Service layer (frontend) — src/services/*
Thin typed wrappers over supabase-js. UI calls these, never supabase directly, so a
future swap (or mocking in tests) is trivial. This pass:
- src/lib/supabase.ts — client (URL + anon key via env)
- src/services/auth.ts — signUp, signIn, signOut, getSession, onAuthChange
- src/services/profiles.ts — getMyProfile, getProfile, updateMyProfile
- src/services/trips.ts — listMyTrips, getTrip, createTrip, updateTrip, deleteTrip,
  addMember, removeMember
Each maps 1:1 to the AttachmentService-style interface pattern already in the app.

## 5. Hooks — src/hooks/*
- useSession() — current auth session + loading
- useMyTrips() — list for the Trips tab (loading/empty/error)
- useTrip(id) — single trip for /trip/[id]
These return {data, loading, error} exactly like the existing mock hooks, so screens swap
import source with minimal churn. Mock stays available behind a flag until verified.

## 6. Migration sequence (no big-bang)
1. Add deps: @supabase/supabase-js, expo env config. (manual: see SETUP below)
2. Run migrations/0001_spine.sql in Supabase SQL editor.
3. Drop in src/lib/supabase.ts + services/auth, profiles, trips + hooks.
4. Wire ONE screen end-to-end first: Trips tab → useMyTrips() (real list), with an auth gate.
5. Then /trip/[id] → useTrip(id). Then trip create → createTrip().
6. Keep mock data importable; switch screens one at a time; verify each.
7. Later passes: attachments + availability (move session stores to tables), then messaging
   + translation, then realtime + presence, then Pulse content.

## 7. Privacy / permissions principles
- RLS is the enforcement boundary — the client is never trusted.
- Private profiles hidden unless a trip is shared. Private trips invisible to non-members.
- Blocked users (later table) excluded at the policy level.
- No personal data in URLs; Storage buckets get their own policies when avatars/covers move
  off remote mock URLs.

## 8. What this pass deliberately does NOT do
Realtime UI, presence/typing, message translation, Pulse/discovery content tables, payments.
All are designed-for but out of scope until the spine is proven.

## 9. SETUP (manual steps only you can do)
1. Create a Supabase project; copy Project URL + anon public key.
2. Add to app config (e.g. app.json "extra" or .env via expo-constants):
   EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY
3. Install deps on your Mac:
   npm install @supabase/supabase-js --legacy-peer-deps
4. Open Supabase SQL editor, paste migrations/0001_spine.sql, run.
5. Apply the frontend patch (services + hooks + supabase client).
6. Wire the Trips tab to useMyTrips() behind an auth gate; test create/read.

(Claude can't create your Supabase project, run SQL on it, or hold your keys — those are
yours. Claude provides the schema, policies, services, hooks, and wiring.)
