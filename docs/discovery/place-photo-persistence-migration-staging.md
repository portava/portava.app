# STAGED: `2095_discovery_place_photos.sql` — the operator presses this

**Status: NOT APPLIED. Staged for the operator, with before/after verification.**
2026-08-15. Tier 1 step 2 of the Place Intelligence sequence.

> **Rail:** production writes are staged for the operator, never applied by the
> agent. This file is the staging: the exact commands, what to expect before,
> what to expect after, and how to undo it.

---

## What ships without you doing anything

**The code is already merged and it is inert.** Every path through
`discoveryPlacePhotoStore.ts` swallows its own errors and degrades to "no stored
photo", which is precisely the behaviour that existed before it. Until this
migration is applied:

- reads find no table, return `null`, and the live FSQ → Google → artwork chain
  runs exactly as it does today;
- writes fail and are logged at `debug`, deliberately not `warn` — a log line
  nobody can act on trains people to ignore the channel, and this one would fire
  on every card;
- **no user-visible behaviour changes at all.**

So there is no deadline on this and nothing is broken while it waits. Applying
it is what turns the work on.

## Why this table exists

Discovery resolves a place photo through Foursquare → Google → category artwork
**per card, at request time**. That works. What it does not do is remember —
nothing is stored, so **every viewer of every card re-pays two external
providers** for the field a user sees first.

Classified by the owner as **enabling infrastructure, not a new product
feature**: the chain is already approved behaviour, so storing its winner adds
no behaviour, it only stops the work being repeated.

## Before — what should be true now

```bash
# 1. The table must NOT exist yet.
psql "$DATABASE_URL" -c "\dt public.discovery_place_photos"
#   expected: Did not find any relation named "public.discovery_place_photos".

# 2. Confirm which database you are pointed at BEFORE running anything.
psql "$DATABASE_URL" -c "select current_database(), current_user;"
```

> **Both projects, not one.** The rail is explicit and it has already cost this
> workstream once: CI's `schema drift` job runs against the sanctioned CI
> project (`hwokxgbmezheskbzskfr`), never production (`ajrurzioarfkagpuxfnb`).
> **A production-only apply leaves CI red in a way that looks identical to no
> apply at all.** Apply to both.

## Apply

```bash
psql "$DATABASE_URL" -f artifacts/api-server/src/migrations/2095_discovery_place_photos.sql
```

The file is idempotent — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS` — so re-running it is safe.

## After — what must be true

```bash
# 1. Table exists with the expected columns.
psql "$DATABASE_URL" -c "
  select column_name, data_type, is_nullable
  from information_schema.columns
  where table_schema='public' and table_name='discovery_place_photos'
  order by ordinal_position;"
```

Expect exactly these seven columns:

| column | type | nullable |
|---|---|---|
| `place_key` | text | NO |
| `source` | text | NO |
| `photo_url` | text | YES |
| `photo_ref` | text | YES |
| `resolved_at` | timestamptz | NO |
| `expires_at` | timestamptz | NO |
| `invalid_at` | timestamptz | YES |

```bash
# 2. Both CHECK constraints exist — the source whitelist and "must carry a photo".
psql "$DATABASE_URL" -c "
  select conname, pg_get_constraintdef(oid)
  from pg_constraint
  where conrelid='public.discovery_place_photos'::regclass and contype='c';"
#   expected: discovery_place_photos_has_photo, and the source IN (...) check

# 3. RLS is on and no client grants were issued.
psql "$DATABASE_URL" -c "
  select relrowsecurity from pg_class
  where oid='public.discovery_place_photos'::regclass;"
#   expected: t

psql "$DATABASE_URL" -c "
  select grantee, privilege_type from information_schema.role_table_grants
  where table_name='discovery_place_photos' and grantee in ('anon','authenticated');"
#   expected: zero rows. This table is service-role only.
```

## Verifying it is actually doing something — and this part matters

**The failure mode to guard against is that everything looks fine and nothing is
being stored.** A table with zero rows is indistinguishable from a table that is
never written to, which is this workstream's own invariant wearing a new hat. So
do not stop at "the table exists".

```bash
# Row count, a few minutes after real Discovery traffic on a NON-SEEDED city.
psql "$DATABASE_URL" -c "
  select source, count(*), min(resolved_at), max(resolved_at)
  from public.discovery_place_photos group by source;"
```

**Use a destination outside Cebu / Manila / Bali / Bangkok / Singapore.** Those
five are seeded with baked-in `image_url` values, so the client short-circuits
and the live chain — and therefore this store — is **never exercised**. Paris is
the app's own default and has no seeded rows.

- **Rows appearing, `source` mostly `google`** — expected as of 2026-08-15:
  Foursquare was returning HTTP 429 (account credits exhausted), so Google was
  carrying every card.
- **Zero rows after real traffic** — the write path is not running. Check that
  the client is sending `placeKey` (it is optional by design, and absent means
  silently no persistence).

## Undo

```sql
DROP TABLE IF EXISTS public.discovery_place_photos;
```

**Nothing else depends on this table.** Dropping it costs one re-resolve per
place and returns the system to today's behaviour exactly. It holds no place
attributes, no user data, and nothing that cannot be recomputed — which is what
makes it a cache rather than a corpus.

## What this is NOT

Explicit non-goals from the ruling, each requiring a **new** ruling before
anyone starts: crawling photos, bulk enrichment, multiple candidates per place,
quality scoring, cross-provider deduplication, pre-populating cities.

This table gets **one row for one place at the moment that place's photo was
resolved for a real viewer.** It does nothing on its own initiative. If a future
change makes it start filling up for places nobody looked at, that change has
crossed the line this ruling drew.
