---
name: Supabase migration access
description: How schema migrations get applied in this project and the current broken credential.
---

Schema migrations live in `artifacts/api-server/src/migrations/` and are applied to production Supabase via the Management API (`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `SUPABASE_ACCESS_TOKEN`), then logged in `docs/migrations.md`.

**As of 2026-07-15 the workspace `SUPABASE_ACCESS_TOKEN` secret is invalid** — 43 chars (valid `sbp_` tokens are 44), Management API returns "JWT could not be decoded". Direct psql also fails: `SUPABASE_DB_PASSWORD` gets "password authentication failed" against the `aws-1-us-east-1` pooler (the tenant resolves there).

**How to apply:** ask the user for a fresh personal access token from supabase.com/dashboard/account/tokens (via requestSecrets), or have them paste the SQL into the Supabase SQL editor. Migration `0120_passport_section_order.sql` is pending this.

**Why it matters:** the profile route strips unknown columns on 42703/PGRST204, so an unapplied `profiles` column fails silently — saves appear to succeed but the field never persists.
