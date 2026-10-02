# Stray `.sql` files and `APPLY-*.md` runbooks — inventory and proposed disposition

Prepared 2026-09-16. **This is a proposal. Nothing has been deleted or moved.**

The standing instruction is to preserve anything whose purpose or application
history is uncertain. So this document sorts by *certainty*, not by tidiness, and
recommends deletion for exactly the files where certainty is total and
demonstrable.

---

## 1. Counts, corrected

Earlier notes in this session said "eleven root `.sql` files and eight
`APPLY-*.md` runbooks". The measured counts are:

| | count | note |
|---|---|---|
| root `.sql` files | **11** | 10 numbered + `CHECK-upsert_city_stamp-RPC.sql` |
| root `APPLY-*.md` runbooks | **13** | not 8 |
| other apply notes at root | 2 | `WAVE2-APPLY-NOTES.md`, `WAVE3-APPLY-NOTES.md` |
| loose `.sql` elsewhere | 4 | named in `docs/RECONCILIATION-PACKET.md` |

`RECONCILIATION-PACKET.md:47` describes a set of "16 loose files" that also names
`migration.sql`. **That file does not exist in the tree.** The packet's list is
stale by one entry.

---

## 2. The ten numbered root `.sql` files — DELETE (certainty: total)

`0160`, `0177`, `0178`, `0179`, `0180`, `0181`, `0182`, `0183`, `0184`, `0185`.

**They are byte-identical duplicates.** `cmp -s` against
`artifacts/api-server/src/migrations/<same name>` returns equal for all ten. Not
similar — identical.

**Nothing can execute them.** Every migration runner and auditor in the repo
resolves its directories explicitly, and the repository root is not among them:
`certifyMigrations.ts`, `checkMigrationLedger.ts`, `checkMigrationPrefixes.ts`,
`auditMigrationsVsLive.ts`, `auditLiveVsCanonical.ts`, `checkDataRights.ts`,
`checkEnumLiterals.ts`, `checkFlagSchemaPrerequisites.ts` and
`checkClientPrivilegeBoundary.ts` all point at `src/migrations` and/or
`api-server/migrations`. There is no double-apply hazard. There never was.

**Their application history lives with the canonical copies, not with them.** The
canonical files carry the ledger rows and the `docs/migrations.md` entries (e.g.
`0184_fsq_places` — *"Applied 2026-07-24 via Supabase Management API"*). Deleting
a duplicate removes no history.

### 2.1 They are not inert, and that is the argument for removing them

`census-highlights-memories.md` records, in its own scope-coverage discussion,
that a bare citation of `0179_stamp_criteria_engine.sql`

> *"resolves onto a STRAY COPY AT THE REPOSITORY ROOT rather than onto
> `src/migrations/0179_stamp_criteria_engine.sql`, because the guard tries the
> cited string as a repo-relative path before consulting its basename index."*

So a census citation currently resolves to the wrong file, and the census had to
write that down and leave the citation unwatched rather than point a scope entry
at the wrong object. **Deleting the strays fixes that citation by construction.**

### 2.2 Deleting them is not a no-op — one guard must change with them

All eleven root `.sql` files are hash-pinned in `FROZEN_LOOSE_FILES`
(`artifacts/api-server/src/scripts/frozenMigrationRoots.ts:388-400`), enforced by
`checkFrozenDir.ts`. Removing the files without removing their entries turns that
check red.

There is precedent for removing entries, in that same file: the `_incoming` root
was removed with a comment explaining that pinning a path which was never in
version control *"only guarantees a permanent red that trains people to ignore
this check, which is the opposite of what it is for."* The same logic applies to
a pin on a file that has been deleted on purpose.

**Proposed action:** delete the ten files, delete their ten `FROZEN_LOOSE_FILES`
entries in the same commit, and repair the `0179` citation in
`census-highlights-memories.md` to spell the canonical path — in that commit, so
the citation never points at a file that has just stopped existing.

---

## 3. `CHECK-upsert_city_stamp-RPC.sql` — DELETE (certainty: total, now)

This is not a migration. It is a diagnostic query written for a human to paste
into the Supabase SQL editor, and its own comments pose an open question:

> *"does the `upsert_city_stamp` RPC exist in your live database? The GPS
> city-stamp write path (`lib/stampHelper.ts`) calls it, but there is no
> `CREATE FUNCTION` for it anywhere in the repo migrations — so it either exists
> ad-hoc in prod, or is missing (in which case GPS city stamps silently fail to
> write)."*

**Both halves of that question are now answered, and the file's premise is
stale.**

1. **The function exists in both databases.** Queried 2026-09-16: production
   (`ajrurzioarfkagpuxfnb`) and portava-ci both hold
   `public.upsert_city_stamp(p_user_id uuid, p_location_city text,
   p_location_country text, p_label text, p_sublabel text, p_postcard_id uuid)`,
   `SECURITY DEFINER`, identical signatures. GPS city stamps are **not** silently
   failing.
2. **The remedy it asks for already landed.**
   `artifacts/api-server/src/migrations/0187_upsert_city_stamp_reconcile.sql`
   exists in the canonical chain and is listed in the `2254` ledger backfill. Its
   header says *"Captures the exact live definition so the chain is
   authoritative."* Its body was diffed against
   `pg_get_functiondef()` from production: **identical**, modulo stripped
   comments. So the sentence *"there is no CREATE FUNCTION for it anywhere in the
   repo migrations"* was true when written and is false now.

The file is a closed question with a recorded answer. **Proposed action:** delete
it, remove its `FROZEN_LOOSE_FILES` entry, and append the measured answer to
`docs/migrations.md` under `0187` so the finding survives the file.

### 3.1 One thing 0187 does not reproduce, recorded here because it was found this way

`0187` restores the function *body* but not its *ACL*. Production holds
`{postgres=X, service_role=X}` — correct. portava-ci, which was built from the
chain, holds `{postgres=X, anon=X, authenticated=X, service_role=X}`, because
Supabase's default privileges grant EXECUTE at `CREATE FUNCTION` time and the
migration never revoked. This is the general defect that migration `2973`
closes; it is recorded here because `CHECK-upsert`'s question is what led to it.

---

## 4. The four other loose `.sql` files — PRESERVE ALL FOUR

None is a duplicate of anything. Each is a labelled, purposeful non-migration,
and one of them says so in its own header.

| file | what it is | why it stays |
|---|---|---|
| `artifacts/api-server/scripts/2080-rollback.sql` | restores the ten flags retired by `2080_retire_inert_seeded_flags.sql` | Its line 4 reads **"⚠ THIS IS NOT A MIGRATION AND MUST NOT BE MOVED INTO src/migrations/."** It is a recovery instrument for an applied migration. Deleting it removes the only written way back. |
| `audit-closeout/sql/optional-drop-dead-buddy-tables.sql` | DB-05, optional and **destructive**: drops seven dead `buddy_*` tables | Explicitly optional and never applied. Whether it *should* be applied is an open owner question; a destructive script whose application history is "not applied, deliberately" is exactly what the preserve rule is for. |
| `qa2fix-r2/diagnostics.sql` | read-only `SELECT`s separating a double-INSERT from a double-RENDER | States "Nothing here mutates data." A diagnostic kit for a bug class that can recur. |
| `scripts/probe-full-name.sql` | probes whether `profiles.full_name` exists live | Same family as `CHECK-upsert` — but unlike it, nothing in this session established that its question is answered. Uncertain, therefore preserved. |

**None of the four is hash-pinned in `frozenMigrationRoots.ts`.** They are loose
*and* unwatched, so an edit to any of them is invisible to every guard. That is a
real gap and the cheap fix is to add them to `FROZEN_LOOSE_FILES` — the same
commit that removes the eleven entries above could add these four, leaving the
guard watching fewer files but the *right* files. **Proposed, not done.**

---

## 5. The thirteen `APPLY-*.md` runbooks and two `WAVE*-APPLY-NOTES.md` — PRESERVE ALL

`APPLY-BUDGET-FX`, `APPLY-COUNTRY-ESSENTIALS`, `APPLY-FSQ-PLACES`,
`APPLY-MOBILE-ENABLE`, `APPLY-NEW-MIGRATIONS`, `APPLY-OG-SHARE`, `APPLY-POLISH`,
`APPLY-PRICE-BASELINES`, `APPLY-STAMP-WAVE1`, `APPLY-STAMP-WAVE2`,
`APPLY-STAMP-WAVE3`, `APPLY-UNIFY`, `APPLY-WAVE3-EVENTS`, plus
`WAVE2-APPLY-NOTES.md` and `WAVE3-APPLY-NOTES.md`.

These are the record of what an operator actually ran against production, in a
repository whose production applies are **manual by design** — CI carries
`KNOWN_PROD_PROJECT_REF` as a denylist and `check:security` fails closed if it is
emptied, so there is no automated production apply and never was. For migrations
in this range the runbooks and `docs/migrations.md` are the *only* application
history that exists outside the live `schema_migration_ledger`.

`0187_upsert_city_stamp_reconcile.sql` is the proof of their value: a function
that existed only ad-hoc in production was reconciled into the chain, and that
kind of reconciliation is precisely what these notes make possible. Deleting
them would trade a small amount of root-directory tidiness for the ability to
answer "how did production get into this state".

They are documentation. They are not executed by anything. **Keep all fifteen.**

---

## 6. Summary

| disposition | count | files |
|---|---|---|
| **DELETE** — byte-identical duplicates | 10 | root `0160`, `0177`–`0185` |
| **DELETE** — question answered, remedy landed | 1 | `CHECK-upsert_city_stamp-RPC.sql` |
| **PRESERVE** — purposeful non-migrations | 4 | `2080-rollback`, `optional-drop-dead-buddy-tables`, `diagnostics`, `probe-full-name` |
| **PRESERVE** — production application history | 15 | 13 `APPLY-*.md` + 2 `WAVE*-APPLY-NOTES.md` |

Deleting the eleven is a single commit that must also:

1. remove their eleven `FROZEN_LOOSE_FILES` entries (`frozenMigrationRoots.ts`);
2. repair the bare `0179_stamp_criteria_engine.sql` citation in
   `census-highlights-memories.md` to spell `src/migrations/...`, so it stops
   resolving onto a file that is about to be deleted;
3. append `CHECK-upsert`'s measured answer to `docs/migrations.md` under `0187`;
4. correct `docs/RECONCILIATION-PACKET.md:47`, which counts 16 loose files and
   names `migration.sql`, which does not exist.

**Not executed.** The eleven are recoverable from git either way, but they are
hash-pinned historical artifacts, and removing a guard's entries is the kind of
change that should be a decision rather than a side effect of tidying. The four
steps above make it a one-commit decision whenever it is wanted.
