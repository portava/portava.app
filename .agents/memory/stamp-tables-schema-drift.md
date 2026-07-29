---
name: Duplicate unmigrated stamp tables
description: Portava had 3 parallel stamp-related tables where some existed only as migration files, never applied to the live Supabase DB, silently breaking features.
---

# Duplicate unmigrated stamp tables

Found (2026-07-28): `content_stamps` (polymorphic post/media reaction stamps) and `media_stamp_reactions` (separate long-press "stamp-it" count) both had migration files in `src/migrations/` but did not exist in the live Supabase database (`PGRST205` on every query). Every write to the Roam/Watch stamp-reaction endpoint was silently failing at the DB layer — no client bug was needed to explain a "dead" stamp button.

Separately, `passport_stamps` (legacy passport milestone table, last write ~months ago) DOES exist live but is no longer written to by the active award pipeline (`src/routes/posts.ts` trip/location-milestone stamps write to `user_stamps` instead). Code that reads `passport_stamps` for aggregate stats (e.g. buildStats's countries/cities counters) silently returns stale/empty data even though real stamps exist in `user_stamps`.

**Why:** grepping/reading migration files or route code tells you nothing about whether a table actually exists live — this project has repeated, serious schema drift between migration history and the real Supabase schema (see also `db-column-drift.md`, `legacy-migration-reconciliation.md`, `social-graph-live-tables.md`). A "silent fail-open" catch block in the route code (`try { ... } catch { /* non-critical */ }`) makes this invisible in the UI — no error surfaces, the feature just quietly does nothing.

**How to apply:** whenever a reported bug is "button/feature does nothing, no visible error," and you find a plausible client-side gesture/wiring bug, still verify the actual backend table exists live (`select 1 from <table> limit 1` via the Supabase Management API — see `supabase-migration-access.md`) before concluding the fix is complete. A client-side fix on top of a nonexistent table looks correct in code review and typecheck but does nothing in production. Apply migration files directly via the Management API if you find real gaps — do not assume "migration file exists" means "table exists."
