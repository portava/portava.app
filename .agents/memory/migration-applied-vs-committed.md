---
name: A migration file is not evidence, in either direction
description: No migration runner and no schema_migrations table exist; a committed file does not mean applied, and "in no migration file" does not mean drift.
---

There is **no migration runner** in this repo and **no `schema_migrations` table**
(`docs/migrations.md`: "Verified 2026-08-09: no table matching `%migration%` exists
in `public` or `supabase_migrations`"). Migrations are applied by hand through the
Supabase Management API and recorded by hand in `docs/migrations.md`. Nothing
reconciles the two. Both directions of inference are therefore unsound:

**A committed file does not mean applied.** `docs/migrations.md` carries its own
warning: `0108_rent_buddy_spec_tables.sql` was logged applied 2026-07-05 but never
ran (invalid `ADD CONSTRAINT IF NOT EXISTS`), and the whole 0047–0113 rent_buddy
chain was found unapplied on 2026-07-16 despite being listed. A 2026-07-17 audit
found ~40 files with missing objects. Verify the objects exist live.

**"Appears in no migration file" does not mean drift.** Two checks before writing
that claim:

1. **Search every root, not just the canonical one — and do not trust a list.**
   Canonical is `artifacts/api-server/src/migrations/` (229 files, 2026-08-10).
   **The two biggest non-canonical roots are the two that matter most, and both are
   easy to miss:**

   - **`artifacts/api-server/migrations/` — 68 files.** The frozen *legacy chain*
     (no `src/`). `auditMigrationsVsLive.ts` names it exactly that and scans it
     **only** when passed `--include-legacy`, because it diverges heavily from
     live (its `0032` creates `user_location_preferences` while the canonical
     `0032` creates `location_preferences`). That file is under active edit, so
     grep for the gate rather than trusting a line number — it has already moved
     once (a guard import was inserted above it):

     ```
     grep -n 'include-legacy' artifacts/api-server/src/scripts/auditMigrationsVsLive.ts
     ```

     ```ts
     if (process.argv.includes("--include-legacy")) {
       MIGRATION_DIRS.push(resolve(__dir, "../../migrations"));
     }
     ```
   - **`./migrations/` at the repo root — 33 files.** Archived 2026-08-08. The same
     script only *frozen-guards* it (`checkFrozenDirGuard`, comment "2. Repo-root
     dir: migrations/ (archived 2026-08-08)") — **it is never audited against live,
     not even with `--include-legacy`.**

   Everything else is smaller: `supabase/migrations/` 14, `docs/sql/` 13, the repo
   root itself 10, `files/…` 6, `docs/migrations/` 5, `db/migrations/` 4,
   `travel-buddy-standalone/migrations/` 3, `artifacts/travel-buddy/migrations/` 3 (that tree archived at `bc1bef404`),
   plus 1–2-file handoff/patch drops (`portava-stamp-wave*-files/`,
   `*-backend/migrations/`, `composer-pkg/`, …). Every count here rots, and an
   enumeration re-creates the exact failure this entry exists to prevent, so
   search instead:

   ```
   find . -name '[0-9][0-9][0-9][0-9]_*.sql' -not -path '*/node_modules/*' \
     | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn
   ```

   Everything outside the canonical dir is legacy, archived or a drop.
   `auditMigrationsVsLive.ts` scans only the canonical dir unless given
   `--include-legacy`, so its silence is not a tree-wide search — and even with
   that flag it adds only `artifacts/api-server/migrations/`. The repo-root
   `migrations/` and every drop directory are outside its reach entirely.
2. **Rule out a concurrent session.** `2078_profiles_role_not_self_writable.sql`
   shipped a drift note claiming its objects pre-existed out-of-band; it was
   **retracted** in the file header and in `docs/security/admin-authz-audit.md` §"RETRACTED".
   What actually happened: a peer Claude Code session applied 2078 live at ~10:11
   and had not committed the file; the session that queried at ~11:18 read peer
   work-in-progress as history. Compare file mtimes against commit timestamps, and
   prefer evidence of the *prior* state (a failing test, a permission still granted)
   over the mere presence of the fix.

`2079_is_official_privileged_both_directions.sql` shows what a sound drift note
looks like — it says "DRIFT NOTE — this one is real" precisely because the
distinction had already been botched once.

**How to apply:** verify against live via the Management API before recording or
trusting an "applied" row; see [supabase-migration-access.md](supabase-migration-access.md)
for the request shape and the apply-time gotchas.
