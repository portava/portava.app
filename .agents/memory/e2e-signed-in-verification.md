---
name: E2E verification with signed-in accounts
description: How to verify auth-gated app flows end-to-end without a human sign-in session
---

# Recipe
- Create ephemeral users via Supabase Admin API (`POST /auth/v1/admin/users` with service role key, `email_confirm: true`), sign in via `POST /auth/v1/token?grant_type=password`. The service role key works as the `apikey` header for the token endpoint — do NOT use the workspace `EXPO_PUBLIC_SUPABASE_ANON_KEY` shell env var (it is corrupted with non-ASCII chars; see env-secrets-gotchas).
- Upsert a `profiles` row (id, handle, name) via PostgREST after user creation — API routes 404 recipient users with no profile.
- Delete the users via the admin API when done.

# Hitting the local API server
- Curl the dev proxy on localhost port 80. The Express app mounts its router under `/api`, and most route paths ALSO start with `/api/...`, so the full dev URL is `http://localhost:80/api/api/...` (e.g. `/api/api/rent-a-buddy/search`). Only routes defined without the `/api` prefix (e.g. `/healthz`) live at `/api/healthz`. A bare-HTML 404 from curl usually means you forgot the double prefix, not that the route is missing.

**Why:** interactive verification tasks ("verify X with a signed-in account") are fully doable at the API level this way; only pixel-level UI interaction remains code-review-only.
**How to apply:** for any "verify flows end-to-end" task, script the flows in /tmp with node fetch against localhost + admin-created users.

- Compass routes register as `/compass/...` (no extra `/api` prefix), so their dev URL is single-prefix: `http://localhost:80/api/compass/ask`. Check the route registration before assuming the double `/api/api` prefix.
