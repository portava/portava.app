---
name: Supabase migration access
description: How schema migrations get applied in this project and the current broken credential.
---

Schema migrations live in `artifacts/api-server/src/migrations/` and are applied to production Supabase via the Management API (`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `SUPABASE_ACCESS_TOKEN`), then logged in `docs/migrations.md`.

**As of 2026-07-15 a fresh `SUPABASE_ACCESS_TOKEN` was saved and the Management API works.** The previous token was 43 chars (valid `sbp_` tokens are 44) and returned "JWT could not be decoded". Direct psql also fails: `SUPABASE_DB_PASSWORD` gets "password authentication failed" against the `aws-1-us-east-1` pooler (the tenant resolves there) — do not rely on psql.

**How to apply future migrations:** use `POST https://api.supabase.com/v1/projects/<ref>/database/query` with `Authorization: Bearer $SUPABASE_ACCESS_TOKEN`. The project ref is `ajrurzioarfkagpuxfnb` (derived from `$SUPABASE_URL`). A successful DDL returns `[]`.

**Why it matters:** the profile route strips unknown columns on 42703/PGRST204, so an unapplied `profiles` column fails silently — saves appear to succeed but the field never persists.
