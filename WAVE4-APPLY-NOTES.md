# Wave 4 Bundle — Round 3 Fixes (55 file changes)

Fixes for the Round 3 audit findings (see PORTAVA-AUDIT-ROUND3.md). Validated: api-server suite **fully green** (5,939 + 26 drift tests, 0 fail), standalone jest **314/314 suites, 1,633 tests + 2/2 web**, both typechecks clean, sync-script harness 114/114, frozen lockfile install verified.

Unzip `portava-wave4-files.zip` over the repo root (or `git apply --binary portava-wave4.patch`).

## ⚠️ Apply-order notes (read first)
1. **Three renames/deletes the zip can't express — do these by hand (or use the .patch which handles them):**
   - DELETE `artifacts/api-server/src/services/accountDeletion.ts` (old duplicate cascade — replaced by the unified service)
   - DELETE `artifacts/api-server/src/migrations/2071_stamp_progress_atomic.sql` and `2072_user_stamps_unique.sql` (renamed → `2075_`/`2076_`, included in zip; **already applied to Supabase under the old names — do NOT re-apply**)
   - DELETE `travel-buddy-standalone/app/settings/settings.machine.ts` (moved → `src/screens/settings/settings.machine.ts`, included) and `travel-buddy-standalone/assets/images/portava-icon.png` (dead asset)
2. **No new SQL migrations to run** — 2075/2076 are renames of already-applied files.
3. After applying: `pnpm install` NOT needed (no dep changes) but run both test suites, then **redeploy the API**.

## What's fixed

**P1 — The sync trap is disarmed.** `post-merge.sh` + `sync-standalone.sh` now default-OFF (loud warning + exit 0) unless `PORTAVA_ENABLE_LEGACY_SYNC=1` is deliberately set; read-only check modes still work. Ledger now protects `app.json`, all icon/splash/favicon/share assets, and the two unprotected test dirs — and `sync_file()` now honors the ledger for config files (it didn't before). `replit.md`/`ARCHITECTURE.md`/README rewritten: **standalone = canonical, artifacts/travel-buddy = LEGACY-FROZEN.** Sync harness 114/114.

**P2 — Share links + universal links now servable by the deployed host.** New `routes/wellKnownShare.ts` on the api-server: `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` (503 until you set `APPLE_APP_ID_PREFIX` + `ANDROID_CERT_SHA256` in deployment env — **do this**), plus server-rendered `/u/:username` and `/passport/:username` OG share pages (private profiles get a no-leak generic card; everything HTML-escaped). 11 new tests.

**P3 — Account deletion unified.** One cascade (AccountDeletionService) now covers the UNION of both previous implementations (stories, reviews, follows, saves, devices, E2EE key_packages, notifications, push tokens, search history + posts, messages, KYC rows, media, storage, tombstone). Internal endpoint: flag-gated on `account_deletion_worker_enabled` like the scheduler, timing-safe secret, and **requests are only marked completed on success** — failures stay pending and retryable (incl. auth-user delete failures). Old service deleted. 21/21 + 19/19 tests.

**Privacy** — `GET /api/featured` and post-savers now honor the `show_real_name` opt-in (was leaking real names to anonymous callers).

**Client** — UUID→handle fallback on `/u/` + `/passport/` (Discover/Saved profile taps work); notifications tab badge clears on viewing (with cross-instance broadcast); offline cold start fails OPEN (app boots; retries in background; real suspensions still enforced); trip/layover group chat loads (accepts both server shapes + fetches messages); group-chat edit/delete failures surface alerts; Android crypto devices register as `android`; app display name → **"Portava"**; iOS 17 calendar permission string fixed (plugin + FullAccess key); unconfigured production build now fails LOUD instead of booting into mock data; accidental `/settings/settings.machine` route killed; watch 'plan' links → real route; dangling icon path literal removed.

**CI/repo** — jest configs fixed in both trees (dead .pnpm path → `<rootDir>/node_modules/test-renderer`); root `.npmrc` (`auto-install-peers=false`) + ghost `mockup-sandbox` importer removed → `pnpm install --frozen-lockfile` works; migration prefix collisions resolved (2071→2075, 2072→2076) + checker wired into `pre-release-check.sh`; travel-buddy.io removed from prod ALLOWED_ORIGINS; server error-leak cleanup (9 raw `error.message` sites → sanitized), timing-safe internal-secret compares, gems-cursor validation, `.or()` metachar stripping, drift-message `exposeDetail` (fixes the 6 failing tests).

## Known remaining (deliberate, needs owner/env action)
- Set `APPLE_APP_ID_PREFIX` (Apple Team ID) + `ANDROID_CERT_SHA256` in Replit deployment secrets, then verify `https://portava.replit.app/.well-known/apple-app-site-association` returns JSON.
- **P4 Android push:** needs a Firebase project + `google-services.json` + `android.googleServicesFile` in app.json — owner action, not in this bundle.
- Pre-existing `2059` migration prefix duplicate: apply state unknown — resolve manually; `pre-release-check.sh` will fail on it by design until resolved.
- `WAVE3-APPLY-NOTES.md` references the old 2071/2072 filenames — historical doc, migrations already applied; ignore.
- EAS env checklist before first build: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_MAPTILER_KEY`, `EXPO_PUBLIC_FOURSQUARE_API_KEY`, `SENTRY_AUTH_TOKEN`.
