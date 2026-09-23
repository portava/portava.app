# Refreshing the production schema snapshot

`src/lib/capability/snapshots/<date>-production-schema.json` is a **frozen
capture** of production's `public` schema and `feature_flags`.
`checkFlagSchemaPrerequisites` grades every answer against it, so **the snapshot
is the expiry date on everything that check says.**

On 2026-09-08 a stale snapshot made the check report green while four of its
`KNOWN` entries described defects that had already been fixed. It could not tell,
because a frozen file has no way to notice the world moved. That is the class the
tripwire below exists to close.

## When to refresh

**In the same change that applies a migration to production.** Not later.

Two files must move together:

| file | what it records |
|---|---|
| `src/lib/capability/production-applied-migrations.json` | that the migration was applied |
| `src/lib/capability/snapshots/<date>-production-schema.json` | what production now looks like |

If the first is ahead of the second, `checkFlagSchemaPrerequisites` **fails**
rather than reporting a confident green. That is deliberate: it is better for the
check to refuse than to answer from a database that no longer exists.

## How to refresh

Read-only access to production (`ajrurzioarfkagpuxfnb`) is required for the
capture itself. **Ordinary CI does not need it** — the staleness tripwire is
entirely offline and compares two committed files.

Capture the four components with exactly the method recorded in the snapshot's
`method` field:

```sql
-- tables (views included)
SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position)
  FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name;

-- functions (extension-owned excluded)
SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.objid = p.oid AND d.deptype = 'e' AND d.classid = 'pg_proc'::regclass);

-- enums
SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public' AND t.typtype = 'e';

-- flags
SELECT flag, enabled FROM public.feature_flags;

-- the watermark
--
-- DO NOT USE `SELECT max(version) FROM supabase_migrations.schema_migrations`.
-- It is what this file used to say, and on production it answers '2272' — a
-- PRE-cutover serial, months behind. That column is TEXT holding two formats at
-- once, bare serials ('2272') and 14-digit timestamps ('20260921101005'), and
-- under en_US.UTF-8 a timestamp sorts BELOW a four-digit serial (the third
-- character decides it, '0' against '9'). So max() over the mixed column returns
-- the largest SERIAL, not the newest migration. On portava-ci the same query is
-- correct, because that column happens to be single-format — which is exactly
-- why rehearsing it there can never catch this.
--
-- Compare like with like: take the newest of each format and let the caller see
-- that the column is mixed.
SELECT
  max(version) FILTER (WHERE version ~ '^[0-9]{14}$') AS newest_timestamp_version,
  max((version)::bigint) FILTER (WHERE version ~ '^[0-9]{1,6}$') AS newest_serial_version,
  count(*) FILTER (WHERE version ~ '^[0-9]{14}$')     AS timestamp_rows,
  count(*) FILTER (WHERE version ~ '^[0-9]{1,6}$')    AS serial_rows,
  count(*)                                            AS total_rows
FROM supabase_migrations.schema_migrations;

-- And note what NEITHER watermark establishes: this table is not an inventory.
-- A migration can be live in the database with no row here and no row in
-- public.schema_migration_ledger either. See docs/migrations.md,
-- "An applied migration file is a historical artifact".
```

Then set `capturedAt`, `productionMigrationWatermark`, and the three
`checksums`.

## Prove the refresh is COMPLETE, do not assume it

**A partial refresh is worse than a stale one, because it looks current.** Have
the database compute the same digests and check they match what you wrote:

```sql
SELECT md5(string_agg(table_name || ':' || md5(cols), E'\n' ORDER BY table_name))
  FROM (SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS cols
          FROM information_schema.columns WHERE table_schema = 'public'
         GROUP BY table_name) t;
```

**Compare function and flag digests under `COLLATE "C"`.** Postgres's default
collation orders case-insensitively and a codepoint sort does not, so comparing
them under the default collation reports a spurious mismatch on identical data:

```sql
SELECT md5(string_agg(flag || '=' || CASE WHEN enabled THEN 'true' ELSE 'false' END,
                      ',' ORDER BY flag COLLATE "C")) FROM public.feature_flags;
```

The `checksums` block in the snapshot is recomputed by the guard on every run, so
if you write the file correctly and record the digests honestly, a later
hand-edit is caught automatically.

## What the guard checks

| failure | how it is detected | offline? |
|---|---|---|
| a migration applied after the capture | `production-applied-migrations.json` newest version > snapshot watermark | yes |
| snapshot hand-edited or partially refreshed | recorded `checksums` vs recomputed | yes |
| legacy snapshot with neither field | warns, does not fail | yes |

Both are covered by `src/test/snapshotFreshnessGuard.test.ts`, which mutates a
copy of each file and asserts the guard exits non-zero — so the guard itself
cannot silently stop working.
