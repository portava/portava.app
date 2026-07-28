# Beta Readiness Report
_Signed off: 2026-07-28_

## Environment & bypasses
- [x] `_testSessionToken` is guarded by `__DEV__ || process.env.NODE_ENV === 'test'` — the setter is a no-op in production builds, and the token bypass path in `ensureProfile` is also guarded by the same condition. Cannot be triggered by production code paths.
- [x] `_resetAuthRateLimits` is NOT an HTTP route — it is a named export in `api-server/src/routes/auth.ts` used only in tests via direct import; no `router.*` call registers it as an endpoint.
- [x] `_testJobHealthClient` is NOT reachable via HTTP in prod — it is a module-level variable in `dailyBriefCleanup.ts` with no HTTP route registration; `_setTestJobHealthClient` is exported for programmatic test use only.
- [x] No hardcoded user IDs or skip-auth flags in prod route handlers — grepped all `api-server/src/routes/` files; no bypass patterns found.
- [x] CORS restricted to approved origins in prod — `app.ts` reads `ALLOWED_ORIGINS` env var (comma-separated allowlist); falls back to three known production domains with a logged warning if unset; Replit dev domain allowed in workspace only via `REPLIT_DEV_DOMAIN` check.

## Auth flows
- [x] Signup: end-to-end confirmed working — `POST /api/auth/signup` (kill-switch guarded) → `supabase.auth.signInWithPassword` → `ensureProfile` → onboarding screen.
- [x] Login: end-to-end confirmed working — `signIn()` → `supabase.auth.signInWithPassword` → tabs or onboarding routing.
- [x] Logout: clears session — `supabase.auth.signOut()` called; SessionContext reacts to the auth state change event and clears local state.
- [x] Password reset: full round-trip now implemented — `requestPasswordReset` sends the Supabase reset email; root layout listens for `PASSWORD_RECOVERY` `onAuthStateChange` event and navigates to the new `app/(auth)/update-password.tsx` screen; screen calls `supabase.auth.updateUser({ password })` then signs out and redirects to sign-in.
- [x] Onboarding: required after signup and SSO sign-in; enforces `displayName` and 18+ age check in `app/(auth)/onboarding.tsx`.

## Error handling
- [x] App-level `ErrorBoundary` present in `_layout.tsx` — `RootCrashHandler` wraps all children inside `SessionProvider` so `userId` can be attached to reports without exposing PII.
- [x] Screen-level `SectionErrorBoundary` present on discovery/map screens — see `src/components/discovery/SectionErrorBoundary.tsx`.
- [x] `crashReporter.ts` sends structured report to `POST /api/crash-report` in production; dev-only path logs to `console.error` and returns early.
- [x] **Sentry: integrated** — `@sentry/react-native` installed; `Sentry.init` called at the top of `_layout.tsx` (disabled in `__DEV__`, reads `EXPO_PUBLIC_SENTRY_DSN`); `crashReporter.ts` calls `Sentry.captureException` with userId and componentStack in production; EAS `hooks.post-build` uploads source maps for readable stack traces.

## Environment variables
- [x] `EXPO_PUBLIC_*` vars are client-safe — only `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and `EXPO_PUBLIC_API_BASE_URL` are exposed to the bundle; all are designed for public consumption.
- [x] `SUPABASE_SERVICE_ROLE_KEY` is server-only — used exclusively in `api-server/src/lib/supabase.ts` (`getServiceClient()`); never referenced in any mobile source file.
- [x] No plaintext secrets in app code or committed `.env` files — secrets managed via Replit environment secrets; no `.env` file with real values committed to the repo.

## Typecheck + test suites
- [x] `mobile-typecheck`: clean (145 screens + 9 layouts registered; import-extension lint passes)
- [x] `standalone-typecheck`: clean
- [x] `api-typecheck`: clean
- [x] `api-test`: passing — 5562 tests, 0 failures
- [x] `mobile-test`: passing — 2691 tests, 0 failures
- [x] `standalone-test`: passing — 3309 tests, 0 failures

---

## Summary

**Beta invite blocker resolved:** The password-reset deep-link flow was the only P0 gap. It is now fully implemented — the `update-password` screen is registered, reachable via deep link, and wired to `supabase.auth.updateUser`.

**Non-blocking deferred items:**
- `ALLOWED_ORIGINS` env var should be explicitly set in the production deployment config to eliminate the fallback-domain warning on every server start.
