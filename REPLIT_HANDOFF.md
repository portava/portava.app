# Travel Buddy — Replit Handoff

Expo SDK 54 / React Native / Expo Router (file-based) / TypeScript app.
This is the full current source. Supabase backend (auth + trips + map-privacy schema).

## Run
    npm install --legacy-peer-deps
    npx expo start --clear        # press w for web

## REQUIRED: environment variables
Create a `.env` at project root (NOT committed):
    EXPO_PUBLIC_SUPABASE_URL=https://ajrurzioarfkagpuxfnb.supabase.co
    EXPO_PUBLIC_SUPABASE_ANON_KEY=<the project's anon/publishable key>
Without these, the app runs on MOCK data (no backend) and still works.

## Database (Supabase)
Run these in the Supabase SQL editor in order (already run on the live project):
    migrations/0001_spine.sql        -- profiles, trips, trip_members + RLS
    migrations/0002_map_privacy.sql  -- map_pins, user_locations, user_location_privacy, circle_memberships + RLS
Note: the original auth signup trigger was DROPPED (it caused 500s). Profiles are created
CLIENT-SIDE via ensureProfile() in src/services/auth.ts (on signUp + signIn).

## What works
- Auth gate: email+password sign up / sign in / sign out (src/context/SessionContext.tsx,
  app/(auth)/sign-in.tsx, app/index.tsx session gate). Profiles created client-side.
- Trips tab reads via useMyTrips(); create form -> createTrip(); /trip/[id] -> useTrip().
- Live Map: data + privacy schema only (no live locations rendered). Placeholders at
  app/live-map.tsx, Discovery map card, trip detail map section.
- Everything falls back to mock data if Supabase isn't configured.

## OPEN ISSUE (unresolved) — trip INSERT returns 403 RLS
Creating a trip fails with: `new row violates row-level security policy for table "trips"`
(Postgres 42501). Confirmed so far:
- Token is valid: getUser() returns the user; access_token present; role=authenticated.
- src/services/trips.ts createTrip() attaches the token explicitly (authedClient in
  src/lib/supabase.ts sets Authorization: Bearer <token>).
- trips_insert policy = `to authenticated with check (owner_id = auth.uid())` (correct).
- authenticated role HAS INSERT grant on trips.
- Account: role=authenticated, aud=authenticated, email confirmed.
- Even a temporary `to public with check (true)` policy still 403'd.
- The project's JWT signing key was rotated from legacy HS256 to ECC (P-256) ~1 day ago;
  legacy secret is retained for verification. JWT mismatch is SUSPECTED but not confirmed.
- A separate net::ERR_ADDRESS_UNREACHABLE to the supabase host appeared at one point
  (possible VPN/proxy/DNS interference on the dev machine) — verify basic connectivity
  to https://ajrurzioarfkagpuxfnb.supabase.co/auth/v1/health first.

### Suggested next debugging steps for whoever picks this up
1. Confirm the device can reach the Supabase host (the ERR_ADDRESS_UNREACHABLE may be
   masking results; rule out VPN/proxy/DNS).
2. With a FRESH login (access tokens expire after 3600s), retry create with the temporary
   `to public with check (true)` policy. If that succeeds, the request is arriving as anon
   (token not verified as authenticated) -> pursue the JWT signing-key alignment.
3. If still failing, decode the access_token at jwt.io and confirm `role: authenticated`
   and a valid `sub`, and that the token's `kid`/alg matches an ACTIVE verification key.
4. Restore the proper policy after testing:
       drop policy if exists trips_insert on trips;
       create policy trips_insert on trips for insert to authenticated
         with check (owner_id = auth.uid());

## Notable files
- src/lib/supabase.ts        supabase client + authedClient(token) helper
- src/services/auth.ts       signUp/signIn/signOut + ensureProfile (client-side profile)
- src/services/trips.ts      profiles + trips CRUD (createTrip uses authedClient)
- src/services/map.ts        map pins + location privacy (schema-backed, UI placeholder)
- src/hooks/useBackend.ts    useSession / useMyTrips / useTrip
- src/context/SessionContext.tsx  app-wide auth state
- app/_layout.tsx            providers (SessionProvider outermost)
- migrations/*.sql           schema + RLS

## Design system
src/theme/tokens.ts — ink/paper/signal(vermilion #FF4D2E)/deep(teal) palette, Courier stamp
type role, shadow tokens. Honesty-first: never fake AI/data, label provisional, location
private by default.
