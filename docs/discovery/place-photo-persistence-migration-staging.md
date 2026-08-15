# STAGED: apply `2095_discovery_place_photos.sql` — the operator executes

**Status: NOT APPLIED. Staged with before/after verification.**
2026-08-15. Tier 1 step 2's table; ruled to be applied **immediately after the
republish verifies**.

> **Rail:** production writes are staged for the operator, never applied by the
> agent. **Full discipline is kept even though an empty table makes the data
> risk tiny** — the discipline is not proportional to *this* migration's risk,
> it is the practice that makes the next one safe.

**Four phases, in order. None is optional:**

1. snapshot and **before-state**
2. the **sanctioned migration path**
3. **after-state and schema verification**
4. **ONE REAL photo-resolution and persistence proof, end to end**

**Phase 4 is the one that cannot be skipped or simulated.** A created table
proves a migration ran. It does not prove a photo was ever stored. **A zero-row
table is indistinguishable from a table nothing writes to** — this workstream's
own invariant, which is why the end-to-end proof is part of applying rather than
a follow-up.

---

## The sanctioned path, and why it is not `psql`

**Direct `psql` to `db.{ref}.supabase.co` and every pooler host fails from this
workspace** — tested exhaustively, recorded in
`.agents/memory/supabase-migration-access.md`, and the reason the 2026-07-03
production migration run used the Management API instead. **Do not burn time on
psql.**

```
POST https://api.supabase.com/v1/projects/{ref}/database/query
Authorization: Bearer $SUPABASE_ACCESS_TOKEN
{"query": "<sql>"}
```

`{ref}` is the subdomain of `$SUPABASE_URL`. **DDL success returns `[]`.** The
same endpoint serves read-only verification queries, so every phase below uses
one mechanism.

> **BOTH PROJECTS, NOT ONE.** CI's `schema drift` job runs against the
> sanctioned CI project (`hwokxgbmezheskbzskfr`), never production
> (`ajrurzioarfkagpuxfnb`) — the read-only guard refuses production inside CI by
> design. **A production-only apply leaves CI red in a way that looks identical
> to no apply at all.** Run every phase against both refs.

A helper for the commands below:

```bash
sbq() {  # sbq <project-ref> <sql>
  curl -s -X POST "https://api.supabase.com/v1/projects/$1/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$(jq -n --arg q "$2" '{query:$q}')"
}
PROD=ajrurzioarfkagpuxfnb
CI=hwokxgbmezheskbzskfr
```

---

## PHASE 1 — snapshot and before-state

**Note the UTC instant.** It is the lower bound of everything phase 4 attributes
to this work.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/2095-t0.txt
```

**1a. The table must not exist yet.** This is the snapshot: for a
`CREATE TABLE`, the complete prior state is "absent", and recording that is what
lets phase 3 attribute the table to this migration rather than to something that
was already there.

```bash
sbq $PROD "select to_regclass('public.discovery_place_photos') as tbl;"
sbq $CI   "select to_regclass('public.discovery_place_photos') as tbl;"
```

**Expected: `[{"tbl":null}]` on both.**

> **If `tbl` is NOT null, STOP.** The table already exists and this is no longer
> a create — find out what made it before adding anything to it.

**1b. Confirm which databases you are actually pointed at.** Cheap, and it is
the check whose absence makes every later reading unattributable.

```bash
sbq $PROD "select current_database(), current_user, now();"
```

**1c. Record that no code depends on it yet.** The api-server is already
deployed with the store code and is degrading silently to "no stored photo" —
that is the designed inert state, and it means there is no window during which
the apply can break a live request.

---

## PHASE 2 — apply

Send the migration file's contents as one request per statement group. The file
is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), so a
re-run is safe.

```bash
SQL=$(cat artifacts/api-server/src/migrations/2095_discovery_place_photos.sql)
sbq $PROD "$SQL"
sbq $CI   "$SQL"
```

**Expected: `[]` from both** — that is DDL success, not an empty result set to
be worried about.

If a statement is rejected, apply the file's statements individually rather than
guessing which one failed; the recorded 2026-07-16 lesson is that batching hides
which statement broke.

---

## PHASE 3 — after-state and schema verification

**3a. Columns — expect exactly these seven, in this order.**

```bash
sbq $PROD "select column_name, data_type, is_nullable
           from information_schema.columns
           where table_schema='public' and table_name='discovery_place_photos'
           order by ordinal_position;"
```

| column | type | nullable |
|---|---|---|
| `place_key` | text | NO |
| `source` | text | NO |
| `photo_url` | text | YES |
| `photo_ref` | text | YES |
| `resolved_at` | timestamp with time zone | NO |
| `expires_at` | timestamp with time zone | NO |
| `invalid_at` | timestamp with time zone | YES |

**3b. Both CHECK constraints, and the primary key.**

```bash
sbq $PROD "select conname, pg_get_constraintdef(oid)
           from pg_constraint
           where conrelid='public.discovery_place_photos'::regclass
           order by contype, conname;"
```

Expect `discovery_place_photos_has_photo` (`photo_url IS NOT NULL OR photo_ref
IS NOT NULL`), the `source IN ('foursquare','google')` check, and the
`place_key` primary key. **The `has_photo` constraint is the one that matters
most** — without it the table can hold a row that reads as a resolved photo and
contains none.

**3c. The index.**

```bash
sbq $PROD "select indexname from pg_indexes
           where tablename='discovery_place_photos';"
```

**3d. RLS on, and no client grants.**

```bash
sbq $PROD "select relrowsecurity from pg_class
           where oid='public.discovery_place_photos'::regclass;"
# expect: t

sbq $PROD "select grantee, privilege_type from information_schema.role_table_grants
           where table_name='discovery_place_photos'
             and grantee in ('anon','authenticated');"
# expect: []  — service-role only
```

**3e. Repeat 3a–3d against `$CI`.** Same expectations. A drift between the two
is the failure mode this rail exists for.

**3f. The repo's own audit passes.**

```bash
cd artifacts/api-server && pnpm run audit:schema   # exit 0
```

---

## PHASE 4 — ONE REAL end-to-end proof

**This is the phase that proves the feature, and the only one that can.**

Everything above proves a table exists. None of it proves the api-server can
write to it, that `placeKey` survives the round trip, or that a stored photo is
served back. **A zero-row table after real traffic looks exactly like a working
one that nobody exercised.**

### 4a. Pick a place the live chain will actually resolve

**Not a seeded city.** Cebu, Manila, Bali, Bangkok and Singapore ship with
baked-in `image_url` values, so `useFsqPhoto` returns early and **the live chain
never runs** — a check there proves nothing and will look like success.
`.agents/memory/osm-only-photo-path-untested.md` records this trap.

Use Paris, the app's own default. Get one real OSM place id from production:

```bash
curl -s "https://<prod-host>/api/discovery?destination=Paris&category=food&radiusKm=2" \
  | jq -r '.places[0] | {id, name, lat, lng}'
```

Note the `id` — it will look like `node/1234567890`.

### 4b. Confirm the row does not exist yet

```bash
sbq $PROD "select * from public.discovery_place_photos
           where place_key = 'osm:node/1234567890';"
# expect: []
```

**This is the before/after pair.** Without it, a row found in 4d cannot be
attributed to this test.

### 4c. Trigger ONE resolution, with the place key

```bash
curl -s "https://<prod-host>/api/places/fsq-photo?name=<URL-encoded name>&lat=<lat>&lng=<lng>&placeKey=node%2F1234567890" | jq .
```

**Read the response before moving on** — it is diagnostic, not decoration:

| Response | Meaning |
|---|---|
| `{"photoUrl":"https://...","source":"foursquare"}` | Foursquare resolved it |
| `{"photoUrl":null,"reason":"foursquare_quota_exhausted"}` | **expected as of 2026-08-15** — the FSQ account had no credits. Not a failure of this work. Continue to the Google leg below |
| `{"photoUrl":null,"reason":"no_photo_found"}` | FSQ has no photo for this place. Continue to the Google leg |

If Foursquare returned nothing, run the second link exactly as the client would:

```bash
curl -s "https://<prod-host>/api/places/photo?name=<URL-encoded name>&lat=<lat>&lng=<lng>&placeKey=node%2F1234567890" | jq .
```

Expect `{"photoUrl":"https://places.googleapis.com/v1/places/.../media?...","source":"google"}`.

### 4d. Prove it persisted — and prove WHAT persisted

```bash
sbq $PROD "select place_key, source, photo_url, photo_ref, resolved_at, expires_at, invalid_at
           from public.discovery_place_photos
           where place_key = 'osm:node/1234567890';"
```

**Four things must all be true. Any one failing means the feature does not work,
whatever the table looks like:**

1. **Exactly one row exists**, keyed `osm:node/1234567890` — the `osm:` prefix
   proves `normalisePlaceKey` ran rather than the raw id being stored.
2. **For a Google row: `photo_ref` is set and `photo_url` is NULL.**
   **`photo_ref` must NOT contain `key=`.** This is the credential guard — a
   stored key-bearing URL would leak a secret into a table and become a dead
   link on the next rotation.
3. **`expires_at` − `resolved_at` = 30 days.** A row with no horizon is a stale
   field with no owner.
4. **`invalid_at` is NULL.**

### 4e. Prove the READ path — that the work actually stops being repeated

Persisting is only half of it. Call the **first** link again with the same
`placeKey`:

```bash
curl -s "https://<prod-host>/api/places/fsq-photo?name=<URL-encoded name>&lat=<lat>&lng=<lng>&placeKey=node%2F1234567890" | jq .
```

**Expect `{"photoUrl":"...","source":"google","cached":true}`.**

- **`cached: true` is the proof** that the answer came from the store.
- **`source: "google"` returned by the Foursquare-named route is correct, not a
  bug** — what is stored is the canonical resolved photo *for the place*, and
  `source` travels with it so attribution stays truthful.
- **A hit here means neither provider was called.** That is the entire point of
  the work, and this response is the only direct evidence of it.

### 4f. Record the result

Append the outcome to this file and set the `2095` row in
[`../migrations.md`](../migrations.md) to applied **with the date** — and only
after phases 3 and 4 both pass. That file's own standing warning is that
"applied" claims in it are not authoritative; do not add another one that has
not been verified against the live database.

---

## Undo

```sql
DROP TABLE IF EXISTS public.discovery_place_photos;
```

**Nothing depends on this table.** Dropping it costs one re-resolve per place
and returns the system to pre-apply behaviour exactly. It holds no place
attributes and no user data — which is what makes it a cache rather than a
corpus.

## What this is NOT

Explicit non-goals from the ruling, each needing a **new** ruling before anyone
starts: crawling photos, bulk enrichment, multiple candidates per place, quality
scoring, cross-provider deduplication, pre-populating cities.

The table gets **one row for one place at the moment that place's photo was
resolved for a real viewer.** It does nothing on its own initiative. **If it
ever starts filling up for places nobody looked at, that change has crossed the
line this ruling drew.**
