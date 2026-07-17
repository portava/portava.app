---
name: Legacy migration reconciliation
description: Lessons from applying the legacy migrations dir against a live schema that drifted to canonical shapes
---

- Live tables often exist with a *canonical* shape while server code uses the *legacy* shape; `CREATE TABLE IF NOT EXISTS` silently no-ops, so reconciliation needs explicit `ALTER TABLE ADD COLUMN IF NOT EXISTS` preludes derived from the legacy definitions.
- **`CREATE INDEX IF NOT EXISTS` validates the column list even when it skips creation** — pre-creating an index under the migration's name does not make the original statement safe if it references a missing column; rewrite the statement to the live column.
- Canonical-vs-legacy NOT NULL conflicts on empty tables are safest resolved with `DROP NOT NULL` (audit checks existence only, so this is audit-neutral).
- Known live renames encountered: `feature_flags.key`→`flag`, `passport_stamps.earned_at`→`awarded_at`, `circle_memberships(owner_id,member_id)`→`(user_id,other_id)`, `trip_crew_location_sessions.allowed_member_ids` is `uuid[]` (drop `::text` casts in policies).
- **Why:** applying legacy SQL verbatim fails or no-ops in these cases; each was hit while zeroing the `--include-legacy` schema audit (details in docs/migrations.md, 2026-07-17 entry).
- **How to apply:** whenever applying/porting a legacy migration file, diff its table shapes against the live schema first and transform at apply time — keep the historical files untouched.
- Adding a previously-missing column can *activate* dormant code paths: the geocode tests broke after `corrected_at` was applied because `readDbCache` stopped erroring and started serving live rows polluted by earlier test runs — geocode tests must default `_setGeocodeDbClientForTests(null)` (now done in beforeEach) since the fetch hook alone does not disable the DB.
