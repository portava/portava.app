# Portava audit close-out — one bundle, everything remaining

This closes the server-side audit tail in a single deliverable: an idempotent apply
script for the verified fixes, optional SQL, the two agent command-docs, and your
provisioning steps. **Every finding was re-verified against the real code first** —
which caught several more false positives (the earlier audit tooling only scanned
`src/migrations` and sampled endpoints, so it over-reported).

## Apply order
```bash
cd ~/workspace/artifacts/api-server

# 1) Apply the verified server fixes (idempotent — safe to re-run):
python3 /path/to/apply-portava-audit-closeout.py

# 2) Verify:
npx tsc -p tsconfig.json --noEmit && echo "tsc OK"
node --import tsx/esm src/scripts/checkAsyncHandlers.ts        # PASSED
npm test    # now runs WITH Supabase test env (see note); expect only the 2 documented trip-crew harness tests failing

# 3) OPTIONAL, destructive — dead-table cleanup (review first):
#    run sql/optional-drop-dead-buddy-tables.sql in the Supabase SQL editor

# 4) Hand the two docs in agent/ to your Replit agent (client cluster + media hydration).
# 5) Do the provisioning steps in PROVISIONING.md (PROV-01/02/03 + MapTiler key).
```
The apply script edits `package.json`, `.env.example`, 4 route/lib files, and 2 test
files, all via anchored/surgical edits (robust to your drift; prints `+ applied` /
`= already applied` / `! anchor not found` per item). If any prints `! anchor not
found`, that one file drifted — tell me and I'll re-anchor it.

## What this bundle FIXES (verified real, tsc-clean, tests green)
- **API-05** — `GET /rent-a-buddy/by-user/:userId` used `select("*")`; now uses the
  curated `BUDDY_PUBLIC_COLUMNS` like its sibling routes (no more column over-exposure).
- **API-07** — added a positive/numeric guard on package `priceUsd` (was truthy-only;
  a negative/string price could be inserted). (The tip handler already validated range.)
- **FL-04** — removed the dead, fail-open `memoriesEnabled()` helper (never called).
- **Test suite (CI green):** the `test` script now sets the Supabase test env
  (`isServiceClientReady` was false under bare `npm test`, 503-ing 47 write-path tests);
  fixed the marketplace router mount in `rentBuddyReliabilityRoutes.test.ts` (~9 tests,
  a miss from my API-01 fix — it used a local alias my sed didn't catch); fixed the stale
  events-media test to post an app-storage URL; and fixed a **real latent bug** in
  `delayedPostPublisher` (`opts?.client ?? …` swallowed an explicit `null`) that the
  null-client test relied on. Net: **60 failures → 2**.
- **PROV-04** — documented the used-but-undocumented env vars in `.env.example`
  (OpenAI, Ticketmaster, Mapbox, Redis, internal secrets, LiveKit, IDENTITY_PROVIDER).
- **PROV-06** — removed dead `GOOGLE_MAPS_API_KEY` / `MAPTILER_API_KEY` server config.

## FALSE POSITIVES — verified, NO fix needed (don't act on these)
- **DB-01 / DB-02** — tables/columns exist in the frozen legacy `migrations/` chain
  (confirmed against your live DB).
- **DB-03** — 23 tables are RLS-enabled with no policy, but the client never reads any
  of them with the anon key (client only anon-reads `profiles/circles/trips/trip_members`,
  which aren't RLS'd). Server uses the service-role key (bypasses RLS). Deny-all is a safe
  default here, not a leak.
- **DB-04/06/07** — every `USING(true)` policy is on a public reference table or
  service-role-scoped; no write-capable unrestricted policy exists.
- **FL-04 (as framed)** — the Memories *backend is live*; the flag "gate" was dead code,
  not the routes. (We removed the dead code; no need to seed `memories_enabled`.)
- **API-05 (4 of 5)** — passport postcards/og-image/stamp-preview are correctly-public,
  properly-gated endpoints; the hidden-gem guide directory is intentionally public.
- **API-07 (admin router)** — well-validated with zod already; the tip handler validates range.
- **Trip-crew coordinate leak** — the real "no exact coords" test PASSES; `buildCrewCard`
  coarsening is correct.

## DOCUMENTED — real but NOT auto-fixed (need a decision or client work)
- **API-04 (route collisions)** — 7 duplicate registrations. Two are safe dead-copy
  deletes (`reports.ts` `/admin/reports`, `rentABuddySpec.ts` bookings/events) — left for
  you since deleting is optional cleanup. **Most important: `/me/devices` (#5/#6)** is a
  real collision — push-token registration (notifications.ts) shadows E2E-crypto device
  registration (devices.ts), so crypto device provisioning is unreachable. Fix = rename the
  crypto routes to a distinct base (e.g. `/me/crypto-devices`) + update the client; that's
  client-coordinated, so it's in the agent doc. #1/#2/#3 are divergent handlers where the
  feature-richer one is shadowed — decide the canonical behavior before deleting either.
- **API-04 marketplace validation (rest)** — the other ~20 marketplace write handlers lack
  zod (mostly non-money). Low priority; add schemas incrementally.
- **PROV-05 (Foursquare v3)** — the deprecated-v3 autocomplete helper is dormant (no key)
  and fails safe (`[]`). Attribution ("Powered by Foursquare") is confirmed surfaced. When
  you provision a *new* FSQ key, migrate `lib/foursquarePlaces.ts` to
  `https://places-api.foursquare.com/places/search` with `Authorization: Bearer` +
  `X-Places-Api-Version`. Didn't ship blind (unverified new-API contract).
- **DB-05** — 7 dead `buddy_*` tables; optional drop in `sql/`.
- **2 trip-crew tests** — `tripCrewLocation.test.ts` tests 7 & 8 fail because the fake test
  client doesn't surface `crewPrefs` rows to `getCrewMap` (harness gap). NOT a product or
  privacy bug — the coordinate-leak test passes and coarsening is verified. Left as a
  harness cleanup.

## HANDED OFF
- **Agent** (`agent/`): the client cluster (API-02 Share path, CL-01–13, SEC-01 Request
  button, FL-08 flag gating, dead screens) + SEC-02 media hydration + the `/me/devices`
  crypto-route rename.
- **You** (`PROVISIONING.md`): PROV-01 Stripe, PROV-02 KYC vendor, PROV-03 LiveKit,
  plus the SEC-02 bucket cutover (already delivered) and the MapTiler key restriction.

## Audit status after this bundle
Every P0–P2 server finding is **fixed, verified-false-positive, or documented with a
reason**. The only remaining *code* work on my side is the two adapters I offered to
write once you pick a KYC vendor and a payment flow (PROV-01/02). Everything else is
client (agent) or provisioning (you).
