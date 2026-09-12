# scripts/local-db — kernel SQL, executed

A throwaway PostgreSQL that carries the trip domain's real schema, so the
suites under `src/test/db/` run `trip_kernel_execute`, the outbox drain, the
snapshot fold and the RLS policies **as functions**, not as text a test greps.

```
pnpm --filter @workspace/api-server test:db-local     # up.sh, then run-tests.sh
pnpm --filter @workspace/api-server db:local:up       # just the database (writes .env.local-db)
pnpm --filter @workspace/api-server db:local:down     # stop a cluster up.sh booted
```

## What `up.sh` builds

1. **`shim.sql`** — the Supabase surface the chain references and nothing more:
   the PostgREST roles, `auth.users`, `auth.uid()/role()/jwt()` reading the
   same GUCs PostgREST sets, PostGIS, pgcrypto in `extensions`. Measured over
   the 498 canonical files; no GoTrue, PostgREST, storage or realtime.
2. **The baseline** — `baseline/20260819_baseline_structure.sql`, production's
   structure on 2026-08-19, no rows. Exactly three PostgreSQL-17-only statement
   shapes fail on 16 (`MAINTAIN`, `transaction_timeout`, the dump's own
   `CREATE SCHEMA public`); any other error aborts.
3. **The canonical chain** from `2093` (the first file whose objects the
   baseline lacks; `2092` is the last one present), each file as `psql` runs
   it, in byte order. A file may fail **only** if `KNOWN_UNREPLAYABLE.json`
   names it with its verbatim error, and a listed file that replays in order
   aborts the run so the list can only shrink. The eight listed files are
   profile-deletion and intel migrations plus one PostgreSQL 17 privilege;
   every `trip_*` object, the kernel and the projection worker replay cleanly,
   and `up.sh` refuses to finish unless they are all present.

Two modes: `LOCAL_DB_URL` set (CI's `postgis/postgis:16-3.4` service
container) or unset (boot a cluster under `/tmp/portava-local-db`; as root it
runs as an unprivileged helper user because PostgreSQL will not start as root).

## What it proves, and what it does not

- It proves **behaviour**: a command appends one event at the next aggregate
  version and one receipt; a replay by key is a duplicate; the worker applies
  each outbox event once; a snapshot replays to its state and a tampered one
  fails to verify; RLS hides a private trip from a non-member.
- It proves **nothing about drift**. `docs/ci/BOOTSTRAP.md` §1 explains why
  replaying the chain into the CI project would make `check:schema-references`
  compare the files to themselves. This database is never that project's
  target, never audited, and never holds real data.
- It is not production and not the CI project. A migration that replays here
  is *replayable on this baseline*; whether it is applied anywhere is what
  `public.schema_migration_ledger` and the runbook say, not this script.

`run-tests.sh` refuses a vacuous pass: `skipped` must be 0 and `pass` > 0. The
same files sit in the ordinary `pnpm test` list and skip there without a
database, exactly as `tripKernelLive.test.ts` skips without credentials.
