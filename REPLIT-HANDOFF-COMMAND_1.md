# Portava — Apply Audit Fix Wave 1 + Complete Remaining Production Items

**Context for the agent:** A full production audit was run on this codebase (see `PORTAVA-PRODUCTION-AUDIT.md`). 26 findings have already been FIXED in the attached bundle (`portava-fixes-files.zip` — 49 files, unzip over the repo root; or apply `portava-fixes.patch` with `git apply --binary`). Your job: **apply the bundle, verify it, then complete the remaining items listed in Part 3.** Do not re-litigate the fixes; verify and integrate.

---

## Part 1 — Apply the fix bundle

Unzip `portava-fixes-files.zip` over the repo root (it contains files under `travel-buddy-standalone/`, `artifacts/api-server/`, `scripts/`, plus `APPLY-NEW-MIGRATIONS.md`). Then:

1. Delete `travel-buddy-standalone/app.json.bak` (superseded; the bundle's `app.json` is authoritative).
2. Run `pnpm install` in `travel-buddy-standalone` (package.json changed: runtime deps moved out of devDependencies, bogus `test-renderer` removed, `react-test-renderer` pinned to 19.1.0, `expo-openmls` now `file:./vendor/expo-openmls` — vendored copy included in the bundle).
3. Apply the two new SQL migrations in the Supabase SQL editor per `APPLY-NEW-MIGRATIONS.md`:
   - `artifacts/api-server/src/migrations/2069_circle_invites.sql` (creates the missing `circle_invites` table — circle invite endpoints currently 500)
   - `artifacts/api-server/src/migrations/2070_rls_hardening.sql` (enables deny-all RLS on 12 anon-key-exposed tables)
4. Run the API server test suite and the standalone typecheck/tests. Fix any breakage the environment surfaces (the fixes were written without node_modules available).

### What the bundle contains (already done — verify, don't redo)

**Build/config:**
- `eas.json`: prebuild paths fixed (`bash scripts/eas-install-rust.sh`, script vendored into the app at `travel-buddy-standalone/scripts/`), prebuild added to production, `env` blocks added to preview+production (`EXPO_PUBLIC_API_BASE_URL=https://portava.replit.app`, `EXPO_PUBLIC_WEB_ORIGIN=https://app.travel-buddy.io`), unsupported `hooks` field removed (now `eas-build-on-success` script in package.json).
- `app.json`: all dev `*.spock.replit.dev` hosts replaced with `app.travel-buddy.io` (associatedDomains, intentFilters, router origin); `ios.config.usesNonExemptEncryption: true` added; `android.adaptiveIcon` added.
- Placeholder `assets/images/icon.png` + `adaptive-icon.png` generated (navy "P") so builds succeed.

**Client:**
- E2EE registration fixed: calls `POST /me/crypto-devices` (was double-prefixed `/api/api/me/devices`), public-key upload → `POST /api/me/crypto-devices/:id/public-key`.
- Password reset: all `/(auth)` dead-ends → `/(auth)/sign-in`; expired-link "Request a new link" → sign-in with `?mode=forgot-password` (sign-in now honors the param).
- Buddy offers: `createBuddyOffer(requestId, payload)` → `POST /api/rent-a-buddy/requests/:requestId/offers`; "Requests Inbox" tile added to buddy dashboard; "Saved Buddies" entry added to rent-a-buddy home.
- Safety-number screen: env var fixed, now consumes new `GET /api/users/:userId/devices`.
- Compass Settings now reachable from Compass Preferences ("Data & Privacy" section).
- `[STAMP_DEBUG]`/crypto/stamp-animation logs gated behind `__DEV__`.
- Admin reports client aligned to the live handler (`page`/`limit`/`status`; "All" fans out over the four statuses).
- "Coming soon" labels removed from live features (explore-portava rows, PassportOwnerMenuSheet My Events / Notifications).
- 9 orphaned admin screens wired into the admin hub (`profile/edit/connected.tsx`) + RAB admin Marketplace tile.

**Server:**
- Crypto device routes renamed to `/me/crypto-devices*` (collision with push-token routes resolved; PUT kept as legacy alias on public-key). New `GET /users/:userId/devices` (public key fields only) for safety numbers.
- Messaging's shadowing `POST /me/notifications/read-all` renamed to `/me/messaging/inbox-viewed`; notification center now reaches the real read-all handler (badge clears); messaging client repointed.
- Schema drift fixed: `compass_analytics`→`compass_settings` (admin.ts), `passport_stamps.locked` filter removed (passport.ts ×2), `events.start_at`→`starts_at` (CompassGraphEngine), visuals service column fixes (`location_name`, `blurb`, `canonical_location_id`), trustScore select trimmed to existing columns, pulse trust weighting → `trust_profiles.overall_score`.
- `/internal/buddy-requests/expire` now requires `INTERNAL_API_SECRET` (fails closed; no longer compares SESSION_SECRET).
- Duplicate `GET /admin/reports` removed from reports.ts; meetup→trip-plan guard ported into the winning handler in plan.ts and the shadowed duplicate removed from meetups.ts.
- `scripts/sync-standalone.sh --check-source/--check-lockfile` now exit 1 when the source tree is missing (was false-PASS).

---

## Part 2 — Verify after applying (must pass)

1. `pnpm --dir artifacts/api-server test` (or the repo's API test workflow) — expect green; `src/test/rentABuddy.test.ts` was updated for the INTERNAL_API_SECRET change.
2. Typecheck both trees.
3. Smoke: sign in → passport loads; create a circle invite (exercises new `circle_invites` table); mark-all-notifications-read clears the unread badge; E2EE init registers a device (watch server logs for `POST /api/me/crypto-devices` 201); buddy request → offer from requests-inbox.
4. `eas build --profile production --platform ios --no-wait` should pass pre-install/prebuild (icon + script now exist). Confirm `EXPO_PUBLIC_API_BASE_URL` bakes in (check the build's env in EAS).
5. Verify RLS: with the app's anon key, `select * from feature_flags` must now return permission denied / empty.

---

## Part 3 — Remaining work (NOT in the bundle — implement these)

### P0 — before any store submission
1. **Confirm the two production URLs.** The bundle assumes API = `https://portava.replit.app`, web origin = `https://app.travel-buddy.io` (taken from `.replit` ALLOWED_ORIGINS). If different, update `eas.json` env + `app.json` domains. Host `apple-app-site-association` and `assetlinks.json` on the web-origin domain so universal links verify.
2. **Secrets provisioning:** in EAS project env: `EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (for sourcemap upload), `EXPO_PUBLIC_MAPTILER_KEY`, `EXPO_PUBLIC_FOURSQUARE_API_KEY`. In Replit deployment secrets: `SESSION_SECRET`, `SENTRY_DSN`, `INTERNAL_API_SECRET` (now required by the expire endpoint), plus the LiveKit/Foursquare/Google keys already in use. Add all of these (names only) to `.env.example`, and add a `[deployment] run` command to `.replit` so the deploy is reproducible.
3. **Replace placeholder icons** with real Portava branding (icon.png 1024², adaptive-icon.png, ideally a dedicated splash).
4. **Live DB probe:** run `select column_name from information_schema.columns where table_name='profiles' and column_name='full_name';` — if absent, replace `full_name` in the 11 server files that select it (featured.ts, posts.ts, messaging.ts, …) with `display_name`/`name`; if present, add a tracking migration for it.
5. **Privacy policy:** fill the placeholders in `privacy-policy-draft.md` (legal name, email, address, provider names), host it, and put the URL in both store listings.

### P1 — production integrity
6. **Schema baseline:** `pg_dump --schema-only` the live DB into a baseline migration; fold the trust-engine and other legacy-only DDL into the canonical chain (`artifacts/api-server/src/migrations/`). The schema currently cannot be rebuilt from migrations (no CREATE TABLE for `posts`, `circles`, modern `profiles`).
7. **Account deletion:** add a scheduled worker that executes deletion requests at `user_deletion_requests.scheduled_at` (currently manual-admin-only), and extend execution to cascade: posts, media, message ciphertext, verification rows, and `auth.admin.deleteUser` (email currently persists forever). Required for Play Data Safety / Apple / GDPR claims.
8. **Identity verification:** integrate a real provider (Stripe Identity or Persona) in `services/identityVerification/` — currently stubs; production has NO real KYC while rent-a-buddy pairs strangers. Until then, hard-disable booking creation behind a feature flag (payments endpoints are also 501/503 stubs — don't let users create bookings they can't pay for).
9. **Signup kill switch:** make the client call `GET /auth/signup-status` before `supabase.auth.signUp()` (or route signup through `POST /api/auth/signup`) so the invite-only/disable flags actually work.
10. **Sanitize DB errors:** replace the pervasive `sendError(res, "db_error", error.message)` pattern — log the real message server-side, return a generic string. Same for the global error handler's `err.message` echo in app.ts.
11. **Rate limits → Redis:** back `lib/rateLimit.ts` and the express-rate-limit stores with `REDIS_URL` so limits hold across instances/restarts.

### P2 — repo hygiene
12. **Declare `travel-buddy-standalone` canonical** (the old `artifacts/travel-buddy` tree is gone): update `replit.md`, `ARCHITECTURE.md`, `scripts/post-merge.sh`, and the two `.replit` workflows still running `pnpm --filter @workspace/travel-buddy` (they currently match nothing). Do NOT restore the old tree from a backup and run sync — it would overwrite ~60 newer standalone files.
13. Delete the dead root prototype `app/`, `src/`, root `app.json` stub, root `eas.json`; consolidate the 11 migration locations; renumber the duplicate `2059` migration; init git + set up CI (typecheck, API tests, `sync-standalone.sh --check-source`, `checkWritePathColumns`).
14. Permission-string branding pass ("Travel Buddy" → "Portava") and Play background-location declaration + review video.
15. Update `store-compliance.md` checklist as items complete; file the BIS encryption self-classification.

Work through Part 1 → 2 → 3 in order. For each item, report what you changed and show verification output.
