# Wave 2 Bundle — Apply Notes (17 files)

Unzip `portava-wave2-files.zip` over the repo root (or `git apply --binary portava-wave2.patch`). These complete Part 3 items #2(docs), #7, #9, #10, #11(partial), #12, #14 from CLAUDE-CODE-COMMAND.md. **If Claude Code already did any of these in the workspace, keep whichever version is newer — don't double-apply.**

## What's in it

**Server (`artifacts/api-server`):**
- `src/services/accountDeletion.ts` (NEW) — full deletion cascade: content, interactions, follows, devices/key_packages, notifications, search history, storage objects, profile anonymization, then `auth.admin.deleteUser`. Returns per-table results.
- `src/routes/profile.ts` — NEW `POST /internal/deletion-requests/execute-due` (X-Internal-Secret gated, fails closed; batch 20, marks requests completed). **Schedule this daily** (Replit Scheduled Deployment / cron): `curl -X POST $API/api/internal/deletion-requests/execute-due -H "X-Internal-Secret: $INTERNAL_API_SECRET"`
- `src/routes/admin.ts` — admin execute path now uses the same cascade (response shape unchanged).
- `src/lib/http.ts` + `src/app.ts` — in production, 5xx error details are logged server-side and clients get generic messages (dev unchanged, JSON shape unchanged).
- `src/lib/rateLimit.ts` — Redis-backed (ioredis, already a dep) when `REDIS_URL` set: epoch-aligned windows + background sync; unchanged in-memory behavior otherwise. auth.ts limiters untouched (no redis store pkg in deps — add `rate-limit-redis` later if wanted).
- `.env.example` (both root + api-server) — complete env var inventory, names only, required vs optional.
- `.replit` — `[deployment]` build/run commands added (confirm in Replit UI — UI settings override the file).
- `scripts/probe-full-name.sql` (NEW) — run in Supabase SQL editor to settle the `profiles.full_name` question; includes remediation options. (Note: test fixture liveColumns.json suggests the column DOES exist live.)

**Client (`travel-buddy-standalone`):**
- `src/services/auth.ts` — signup now checks `/api/auth/signup-status` first (4s timeout, fail-open); disabled/invite-only surfaces a friendly error via the existing error path.
- `app.json` — permission strings rebranded to "Portava", duplicate always-location strings unified, bogus `NSUserNotificationsUsageDescription` removed.

**Docs/repo:**
- `replit.md`, `ARCHITECTURE.md`, `travel-buddy-standalone/README.md` — SOURCE OF TRUTH banners: standalone is canonical as of 2026-08-04.
- `.replit` — mobile-test/mobile-typecheck workflows repointed (`pnpm --dir travel-buddy-standalone`; old `--filter @workspace/travel-buddy` matched nothing).
- `scripts/post-merge.sh` — hard guard: aborts safely since the old canonical tree is gone.
- `privacy-policy-draft.md` — TODO table at top listing exactly what the owner must fill; verified subprocessors named (Supabase, Sentry, LiveKit, Expo, Foursquare, MapTiler).

## After applying
1. Run api-server typecheck + tests in the workspace.
2. Redeploy.
3. Set up the daily deletion-worker schedule (above).
4. Owner still must do: fill+host privacy policy, real icons, EAS secrets (Sentry/MapTiler/FSQ), identity provider decision, run `probe-full-name.sql`, register a real domain (optional), BIS filing.
