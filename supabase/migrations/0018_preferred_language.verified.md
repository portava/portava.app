# Migration 0018 — Verified Applied

**Migration:** `0018_preferred_language.sql`
**Applied:** 2026-06-22
**Database:** Supabase project `ajrurzioarfkagpuxfnb` (production)

## SQL Executed

```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_language TEXT;
```

Executed via Supabase SQL Editor → Primary Database. Result: **"Success. No rows returned."** (standard Supabase response for successful DDL with no rows affected).

## Column Verified

Verified via Supabase REST API immediately after execution:

```
GET /rest/v1/profiles?select=preferred_language&limit=1
→ [{"preferred_language":null}]
```

The column is present and readable in production. All existing rows have `NULL` (expected — the column is nullable with no default).

## End-to-end path

- `artifacts/travel-buddy/app/profile/edit.tsx` — language picker writes `preferredLanguage` via `updateMyProfile(patch)`
- `artifacts/api-server/src/routes/profile.ts` — PATCH handler maps `preferredLanguage → preferred_language` and writes to Supabase; GET handler reads it back in `PROFILE_COLUMNS`
- `artifacts/api-server/src/services/messageTranslation.ts` — reads `preferred_language` at translation time; takes priority over `preferred_message_language`
