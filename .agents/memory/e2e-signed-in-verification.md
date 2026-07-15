---
name: E2E verification with signed-in accounts
description: How to verify auth-gated app flows end-to-end without a human sign-in session
---

# Recipe
- Create ephemeral users via Supabase Admin API (`POST /auth/v1/admin/users` with service role key, `email_confirm: true`), sign in via `POST /auth/v1/token?grant_type=password`. The service role key works as the `apikey` header for the token endpoint — do NOT use the workspace `EXPO_PUBLIC_SUPABASE_ANON_KEY` shell env var (it is corrupted with non-ASCII chars; see env-secrets-gotchas).
- Upsert a `profiles` row (id, handle, name) via PostgREST after user creation — API routes 404 recipient users with no profile.
- Delete the users via the admin API when done.

# Hitting the local API server
- Curl the dev proxy on localhost port 80; route paths already include `/api/...` (the preview path is not an extra prefix). `/api/healthz` is the health probe.

**Why:** interactive verification tasks ("verify X with a signed-in account") are fully doable at the API level this way; only pixel-level UI interaction remains code-review-only.
**How to apply:** for any "verify flows end-to-end" task, script the flows in /tmp with node fetch against localhost + admin-created users.
