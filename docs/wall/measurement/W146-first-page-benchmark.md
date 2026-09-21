# W146 — the Wall's For You first page, measured against a real PostgreSQL

**Date measured:** 2026-09-20
**Harness:** `artifacts/api-server/src/test/wallFirstPageLiveDb.test.ts`
**Run with:** `npm run test:wall-first-page-live-db` (see *How to reproduce*)

---

## Read this first

**The numbers below are not the production numbers.** They were taken on a
loopback PostgreSQL with 150 posts in it. Production has neither of those
properties. Nothing in this document licenses the claim that the Wall's first
page meets — or misses — Wall spec §33 / TABLE 4's "< 500 ms backend excluding
network" in production. That figure is still **unmeasured**, and the empty table
in *The production figure* below is deliberately empty.

What this measurement does establish is narrower and was previously unknown:
the first page **runs against the real schema** — every column it selects
exists, every filter is one PostgREST accepts, every write it issues meets the
real constraints or is visibly refused — and one page costs **346 real HTTP
round trips to the database edge**, a count that did not vary across eight runs.

It also turned up a defect that only a real schema could show. See *Finding*.

---

## The environment

| Component | What was used | Real or stubbed |
|---|---|---|
| Database | PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1), local, `127.0.0.1:5433` | **REAL** |
| Schema | The production schema of the 23 tables the Wall reads, extracted from the live CI Supabase project | **REAL** |
| API edge | PostgREST 12.2.3, `127.0.0.1:3999`, `db-schemas = "public, auth"` | **REAL** |
| Client | `@supabase/supabase-js` 2.108.2 — the same dependency the server ships | **REAL** |
| Router | `src/routes/wall.ts`, mounted unmodified on Express 5.2.1 over loopback | **REAL** |
| Transport | HTTP on loopback, Node v22.22.2 | real, but **no network** |
| Auth (GoTrue) | A local shim answers `/auth/v1/*` with the fixture viewer | **STUBBED** |

### How the schema was verified

The database was built from a DDL extraction of the live CI Supabase project
(`hwokxgbmezheskbzskfr`), not from this repository's migrations, so it carries
what CI actually has rather than what the migration lane believes it has. At the
time the environment was built, the extraction was checked against CI and
matched on:

* column count for all 23 tables;
* an **md5 fingerprint over all 638 columns** (`name:type:notnull:default:generated`),
  identical to CI: `796068b1e6cbf30e18fb8308cf1327b9`;
* 99 non-constraint indexes, 23 PRIMARY KEY, 9 UNIQUE, 62 CHECK, 48 FOREIGN KEY.

Re-checked at measurement time: the 23 tables carry **638 columns**, and 98
foreign keys are installed (the 48 listed above plus those of the supporting
tables the extraction also created). The md5 above was **not re-derived** for
this document — the exact concatenation and ordering used to produce it were not
recorded alongside the DDL, and a fingerprint computed by a different formula
would not be evidence of the same thing. Treat the md5 equality as a fact
established when the environment was built, and the 638-column count as the part
re-confirmed here.

The only change made to the environment for this benchmark was additive and
touches no column: PostgREST was started with `db-schemas = "public, auth"` and
`service_role` was granted on `auth.users`, because `profiles.id REFERENCES
auth.users(id)` and there is no GoTrue locally to create users through. `public`
remains the first — and therefore default — schema, so the **measured path is
unchanged**.

### What is NOT real here

1. **No network.** Everything is loopback: no TLS handshake, no region hop, no
   connection pooler, no packet loss. A production round trip is milliseconds;
   here it is microseconds.
2. **No production data volume.** 150 posts, 25 profiles, 30 places. Index
   selectivity, planner choices and buffer-cache behaviour at that size say
   nothing about behaviour at production size.
3. **GoTrue is stubbed.** `client.auth.getUser()` is answered by a local shim
   that reads an `X-Fixture-Viewer` header. The auth round trip production pays
   on every single request is absent from these figures.
4. **Six tables the page reads are absent.** The local database has the 23
   verified tables. The first page also reads `events`,
   `identity_verifications`, `user_mutes`, `post_hides`,
   `creator_activity_scores` and `viewer_creator_fatigue`, which are outside
   that set. Those six reads return `42P01` quickly instead of doing real work,
   and the gates they feed (mute, viewer-hide, creator activity, fatigue) are
   inert for this measurement. The router degrades gracefully and logs each one.
   **The effect is to make the measured figure slightly optimistic.**
5. **No cold start, no contention.** One warm process, twenty sequential
   requests, an otherwise idle box.

Taken together, every one of these biases the number **downward**. The
production number cannot be lower than this one for structural reasons; how much
higher it is, this environment cannot say.

---

## The dataset

Seeded fresh at the start of the run, deleted at the end, every row carrying the
namespaced marker `w146fp` so a crashed run cannot leave data for the next one
to measure.

| Table | Rows | Notes |
|---|---:|---|
| `auth.users` | 25 | required by `profiles_id_fkey`; marker in `email` |
| `profiles` | 25 | 1 viewer + 24 authors; marker in `handle` |
| `places` | 30 | marker in `normalized_name` |
| `posts` | 150 | `= CANDIDATE_FETCH`; all `public` / `active` / `published`; marker in `source` |
| `user_follows` | 24 | the viewer follows all 24 authors |
| `feature_flags` | 12 | 11 Wall/intel flags all ON + 1 namespaced teardown sentinel |
| `rank_events` | 0 | see *Finding* — the page's writes are refused |
| everything else | 0 | the other 17 tables are empty |

The corpus is the **same shape and the same seed** (`seededRandom(20260905)`,
150 posts / 24 authors / 30 places / 5 cities / 5 categories) as the in-memory
benchmark in `src/test/wallPerformance.test.ts`, so the two numbers describe the
same world. The only differences are the ones the real schema forces: real
UUIDs, and every `NOT NULL` column without a default supplied.

All eleven Wall and intelligence flags are **ON**, so this measures the most
expensive realistic first page, not the cheapest one.

---

## What was measured

`GET /api/wall?mode=for_you` — the default 20-item first page, asserted to be a
full page with a cursor before any timing is taken — 5 unmeasured warmup
requests then 20 measured, timed off the wire with
`src/test/helpers/benchmark.ts` (nearest-rank percentiles, the same helper the
in-memory benchmark uses).

### Measured: local real PostgreSQL, loopback, 150-post corpus

| Metric | Value |
|---|---|
| **p50** | **388 ms** median of eight runs — 379.1, 379.4, 383.4, **385.7, 389.4**, 415.8, 416.1, 520.9 |
| **p95** | **461 ms** median of eight runs — 407.6, 414.6, 416.3, **437.5, 484.6**, 487.0, 501.3, 618.3 |
| min / max single request observed | 318 ms / 694 ms |
| **Database round trips per page** | **346** — identical in all eight runs |
| Samples | n = 20 measured per run, 5 warmup |

**The read count is deterministic. The timings are not, and they move with the
load on the box.** Seven of the eight runs were taken while the machine was
otherwise quiet and landed at p50 379–416 ms / p95 408–501 ms. The eighth was
taken while other work was running on the same host and landed at p50 521 ms /
p95 618 ms — a 35% shift from nothing but neighbours. Quote the range, not a
single figure, and do not read any of them as a hardware-independent number.

### Re-measured after the runtime write gate landed

The harness gained a target gate (see "The write gate" below), which changes how
it selects its database but nothing it measures. Two confirming runs on the same
stack, same corpus, same host:

| Run | p50 | p95 | Round trips |
|---|---|---|---|
| A | 367.8 ms | 398.1 ms | 346 |
| B | 369.9 ms | 421.5 ms | 346 |

Both sit inside the quiet-box range above, and the round-trip count is unchanged
at 346, which is the figure that carries. **The table above is still the one to
quote** — it is the median of eight runs rather than two, and widening the
sample is the only thing that would move it.

**Two of the eight runs recorded a p95 over 500 ms**, on loopback, with 150 posts
and six of the page's reads short-circuiting on a missing table. That is not a
production result and is not quoted as one, but it is the wrong side of TABLE 4's
500 ms line on a setup with every advantage, and it is the fact a reader should
carry out of this document rather than the median.

### Where the 346 round trips go (`WALL_BENCH_DIAG=1`)

```
rank_events=151  feature_flags=79  posts=24  trips=22  hidden_gems=22
passport_memories=20  profiles=6  blocks=4  user_follows=3  trip_members=2
places=2  events=2  auth=1  wall_session_intents=1  passport_postcards=1
identity_verifications=1  user_mutes=1  post_hides=1  post_saves=1
creator_activity_scores=1  viewer_creator_fatigue=1
```

This matches what `wallPerformance.test.ts` records against its fake (~362 calls,
ratchet 375) closely enough to confirm the two are counting the same work, one
layer apart: that file counts calls into a fake client, this one counts HTTP
requests that really left the process.

The three largest contributors are the ones that file already names, and none of
them is W146's to fix:

* **151 `rank_events`** — one analytics row per scored candidate, fire-and-forget
  and batchable. On this schema **every one of them is refused**; see *Finding*.
* **79 `feature_flags`** — `isFlagEnabled` does an uncached read on every call.
  At ~1 ms of real round trip each, this alone is a fifth of the page.
* **~64 context-thread reads** (`trips` 22, `hidden_gems` 22,
  `passport_memories` 20) — `ContextThreadService` gathers candidate facts **per
  feed item** rather than once per page.

At 346 round trips, a first page can only clear 500 ms if the average database
round trip stays under ~1.4 ms — and that is before any of the page's own CPU
work is counted. That is the real content of this measurement: not the 385 ms,
but the fact that the page's latency budget is almost entirely round-trip count.

---

## Finding, now CLOSED: the first page's ranking analytics were refused by the real schema

Surfaced by this harness on its first run against the real schema, and fixed
since. Both halves are kept here: a finding whose record disappears when it is
fixed teaches nothing about how it was missed.

### What it was

Every one of the 151 `rank_events` inserts the first page issued was rejected:

```
new row for relation "rank_events" violates check constraint
"rank_events_surface_check"        (surface = 'explore')     [23514]
```

The mechanism was two files that had apparently never been compared:

* `src/services/wall/WallRankingService.ts` — `FOR_YOU_SURFACE = "explore"`. One
  constant did two jobs: it picked the ranker's WEIGHT PROFILE *and* it was the
  value `DiscoveryRankingService`'s analytics writer stamped onto every
  `rank_events` row.
* `src/migrations/2893_rank_events_retire_writerless_surfaces.sql` — **retired**
  the `explore` label from `rank_events_surface_check`, on the stated grounds
  that it had "no writer anywhere in the tree". It had one: the Wall's For You
  page, on every request.

The inserts are fire-and-forget and the rejection was logged at warn and
dropped, so the page kept working and nothing went red. Against the in-memory
fake in `wallPerformance.test.ts` all 151 "succeeded" — its `insert` returns
`{ error: null }` unconditionally. The defect was invisible to every test in the
repository until a real database was put under the router.

### What closed it

The two vocabularies are now threaded separately, because the whole defect was
that they had silently become one:

* `FOR_YOU_WEIGHT_PROFILE = "explore"` — the ranker's weight profile. §14's
  objective is exploration and diversity, and there is no `wall` key in
  `SURFACE_WEIGHT_PROFILES`, so renaming this would fall through to the default
  profile and re-rank every user's feed. Changing it changes what users see.
* `FOR_YOU_ANALYTICS_SURFACE: PersistedRankSurface = "wall"` — the value
  persisted. The type is the enforcement: a label the database would reject is
  now a compile error rather than a warning nobody reads.

The constraint was **not** widened. `explore` is still refused, which is the
half a reader should check first, because "the rows land now" would also be
satisfied by re-admitting everything.

### How it stays closed

The harness test was rewritten in place, as its own comment instructed, and now
asserts the closure from three sides in one run against the real schema:

1. the first page's rows **land** (`rows.length > 0`);
2. every one of them carries `surface = 'wall'` and nothing else;
3. a direct insert with `surface = 'explore'` is **still** refused `23514`, and
   one with `surface = 'wall'` is still accepted — same table, same viewer, same
   foreign key, so neither result can be read as a broken fixture.

Note what the original finding meant for the timings above: the 151 inserts were
issued and round-tripped either way, so they are inside the measured figure.
They were simply refused on arrival.

---

## The production figure

**Unmeasured.** This table is empty on purpose and must not be filled from the
numbers above.

| Metric | Production value | Measured on | By |
|---|---|---|---|
| For You first page p50 | *(not measured)* | | |
| For You first page p95 | *(not measured)* | | |
| Database round trips per page | *(not measured)* | | |
| Average round-trip latency | *(not measured)* | | |

### What getting that figure would still take

1. **Server-side timing on the real deployment.** The target is "backend
   excluding network", so it has to be measured inside the API server — request
   received to response written — not from a client. That means a timing
   histogram on the `/wall` handler, exported, with p50/p95 per mode.
2. **Production data volume and distribution.** A viewer with a realistic follow
   graph, against a `posts` table of production size. The 150-row corpus here
   cannot exercise index selectivity or planner choices at scale.
3. **The real database edge.** Production's PostgREST, pooler, region and TLS.
   The 346-round-trip count is the number that converts latency into page time,
   and it is the one thing in this document that **does** carry over: whatever
   the average round trip costs in production, multiply it by ~346.
4. **Real GoTrue.** Every authenticated request pays an `auth.getUser()` round
   trip that is stubbed out here.
5. **Cold starts and concurrency.** A p95 taken on an idle box with one warm
   process is not the p95 of a serving fleet.

Until all five exist, the honest statement about TABLE 4's backend row is that it
is **not known to be met and not known to be missed**.

---

## The production-safety guard, and the write gate in front of it

`src/lib/ciSupabaseGuard.mjs` refuses to let a process start whenever
`CI_SUPABASE_PROJECT_REF` / `KNOWN_PROD_PROJECT_REF` are unset — which is every
ordinary run — and that refusal is this repository's production denylist. It is
**not weakened** by this harness. What the harness adds is an honest reading of
its own target, decided in code, in three mutually exclusive modes.

| Mode | Selected by | What runs |
|---|---|---|
| **LOCAL** | `W146_LOCAL_DB_URL` names the one disposable database, and `SUPABASE_URL` agrees with it | `assertDisposableLocalBenchmarkTarget()`, which refuses everything else and opens the write latch |
| **REMOTE** | `SUPABASE_URL` names anything else | the full guard, as the module's first act |
| **NO TARGET** | `SUPABASE_URL` names nothing | nothing. The benchmark skips, no client is built, the latch stays shut |

A loopback host cannot be a Supabase project at all: there is no project ref to
resolve, the allowlist has nothing to bind to, and no packet leaves the machine.
That is why LOCAL skips the guard — and it skips it only after its own refusal
has run.

**Selection is explicit.** A bare loopback `SUPABASE_URL` that nobody configured
is *not* LOCAL mode; it takes the guarded branch. The disposable database has to
be named in a second, independent variable, and the two have to agree, or the
run refuses with `target_mismatch`.

**The gate is on the WRITE, not on the connection.** `APPROVED_TARGET` in
`src/test/helpers/liveWallCorpus.ts` starts null; only the assertion above sets
it; and `seedCorpus` and `teardownCorpus` each throw a `DisposableTargetError`
at their first statement while it is shut. So the two write paths refuse
whatever client they are handed.

For **anything else** the full guard runs exactly as
`wallSessionIntentLiveDb.test.ts` runs it, before `@supabase/supabase-js` is
loaded — every value import that reaches Supabase is deferred into `before()`
so the guard's "not even loaded when refused" contract holds.

`isLoopbackTarget()` **fails closed**: it parses the URL and matches the
hostname exactly, so `""`, `not a url`, `postgres://…`,
`https://127.0.0.1.evil.example`, `http://user@127.0.0.1@evil.example` and
`https://evil.example#127.0.0.1` all take the guarded branch.

### The refusals are tested, and the tests need no database

They run on **every** invocation of the file, including one with nothing
configured at all — which is how the refusal paths are proved without ever
connecting to anything:

* `isLoopbackTarget() accepts only genuine loopback hosts`
* `isLoopbackTarget() FAILS CLOSED on everything else`
* `approves the configured disposable target, and ONLY that one`
* `REFUSES missing, remote, production and ambiguous targets` — nine cases, each
  checked by refusal **reason**: nothing configured, blank, whitespace,
  production named as the disposable database, a remote project named as it, a
  hostile loopback spelling, a production runtime URL, an unset runtime URL, and
  two different loopback targets. The latch must stay shut after every one.
* `the WRITE paths refuse while the latch is shut` — calls `seedCorpus` and
  `teardownCorpus` with a client that throws if it is ever reached. It is not
  reached.
* `REFUSED IS STILL REFUSED` — **spawns this very file** with
  `SUPABASE_URL=https://w146benchmarkref.supabase.co`, the two env vars deleted
  and `W146_LOCAL_DB_URL` deleted, and asserts the child exits **2** with
  `[ciSupabaseGuard] REFUSED` in its output.
* `a remote SUPABASE_URL is refused even WITH a disposable database configured`
  — spawns it again with the disposable database configured *and* `SUPABASE_URL`
  pointing at declared production. The child refuses at the gate with
  `runtime_target_not_loopback` and attempts nothing.

### Why `check:guard-coverage` lists this file

That checker recognises coverage by matching a **static** side-effect import on
a line of its own, because the guard works by ES module evaluation order. This
file cannot take that form: the guard must *not* run for the disposable loopback
target, and deciding that means reading the environment, which a static import
cannot wait for. So the front door is reached by `await import(...)` — invisible
to a regex over import statements.

This file and `src/test/helpers/liveWallCorpus.ts` are therefore listed in
`RUNTIME_TARGET_GATES` in `artifacts/api-server/scripts/check-guard-coverage.mjs`.
That is an exception to **static detection**, not to the production guard, and
deliberately not an `EXEMPT` entry — exemption in that checker means *unguarded*,
and "CI does not run it" is explicitly rejected as a reason there. The checker
re-verifies the gate's shape against both files' code on every run: the explicit
selector, the refusing assertion, the dynamic front-door import and the latched
write paths must all still be present, named as whole statements, or the files
are reported as ordinary unguarded reachers.

Neither production (`ajrurzioarfkagpuxfnb`) nor the CI project was written to by
this benchmark. The entire run targeted `http://127.0.0.1:4000`.

---

## How to reproduce

The harness needs a PostgreSQL carrying the Wall schema, a PostgREST in front of
it, and something answering `/auth/v1/*`. With that running:

```sh
cd artifacts/api-server
SUPABASE_URL=http://127.0.0.1:4000 \
SUPABASE_SERVICE_ROLE_KEY=<service_role jwt> \
npm run test:wall-first-page-live-db

# add WALL_BENCH_DIAG=1 for the per-table round-trip breakdown
```

The npm script pins `W146_LOCAL_DB_URL=http://127.0.0.1:4000` — a committed,
independent statement of *which* database is disposable. `SUPABASE_URL` has to
agree with it or the run refuses before connecting, which is the point: two
statements, not one inference. Running the file without `SUPABASE_URL` set is
also fine and reaches nothing — the benchmark skips and the write-gate tests
still run.

PostgREST must expose the `auth` schema (`db-schemas = "public, auth"`, and
`GRANT USAGE ON SCHEMA auth` / `SELECT, INSERT, DELETE ON auth.users TO
service_role`), because `profiles.id REFERENCES auth.users(id)` and there is no
GoTrue. The harness says exactly this, and refuses to run, if it cannot reach
that schema.

The file is in `scripts/UNREGISTERED_TESTS_ALLOWLIST.json` rather than the
curated `test` script for the same reason as
`wallSessionIntentLiveDb.test.ts`: that script pins
`SUPABASE_URL=http://127.0.0.1:9` and `SUPABASE_SERVICE_ROLE_KEY=dummy`, so
registering it would run a database benchmark with no database on every ordinary
suite run. The ten guard and write-gate tests above are deliberately **outside**
the skippable `describe`, so the file can never be one that asserts nothing:
with no database configured at all it still runs ten real assertions.

### It fails rather than passing vacuously

* An unreachable database is a **thrown error in `before()`**, not a skip.
* An auth endpoint that will not name the fixture viewer is a thrown error.
* Any seed the real schema refuses is a thrown error naming the table and the
  SQLSTATE.
* A page that is not a full 20 items with a cursor fails before any timing runs.
* A p50 under 1 ms fails as "too fast to be a real database page".
* A missing target skips with its reason carried into the TAP output
  (`describe({ skip })`), which is what `.github/scripts/run-live-suite.sh`
  scores as red.

### Cleanup

`after()` deletes every row **by marker**, not from memory, in foreign-key-safe
order: `rank_events` (by viewer), `wall_session_intents`, `posts` (by `source`),
`user_follows`, `profiles` (by `handle` prefix), `places` (by `normalized_name`
prefix), `auth.users` (by `email` prefix). Feature-flag names are global and
cannot carry a marker, so the run writes one extra flag whose name **is**
namespaced; finding it at the start of a later run is how that run knows the
flags in the table belong to a dead predecessor rather than to the environment.
Verified after the runs above: every fixture table back to 0 rows.

---

## 2026-09-21 — RE-MEASURED, and the evidence AUDITED rather than re-quoted

A live-arm defect was found in a *different* harness, `mapProjectionPerf.test.ts`
(M256(a)): it printed `arm=live-supabase` whenever two environment variables were
set, while the harness built the in-process double regardless. The label outran
the thing it labelled by about an order of magnitude.

That made one question unavoidable: **were W146's numbers produced the same way?**
The answer had to be established, not assumed, because "this one is fine" is what
the M256(a) header also said.

### The audit, and its result

**Nothing is withdrawn. W146's figures were produced against a real database.**
Three independent checks, in increasing strength:

1. **Read the wiring.** `createClient(SUPABASE_URL, SERVICE_ROLE_KEY)` builds a
   real supabase-js client; `_setTestClient(pub, true)` installs *that object*;
   the real `wallRouter` is mounted on it. There is no fake anywhere in the
   measured path — unlike M256(a), where `startRouterApp` always built one.
2. **Take the database away.** With PostgREST unreachable the suite does **not**
   fall back to anything: `before()` throws, all five live cases are CANCELLED,
   and the run exits 1. A harness that cannot produce a number without a real
   database cannot have produced its number with a double.
3. **Re-measure.** Three fresh runs against a rebuilt throwaway PostgreSQL
   carrying the replayed chain:

| run | p50 | p95 | round trips |
|---|---|---|---|
| 1 | 393.4 ms | 464.4 ms | **346** |
| 2 | 382.1 ms | 418.6 ms | **346** |
| 3 | 376.6 ms | 436.2 ms | **346** |
| *previously recorded (median of eight)* | *388 ms* | *461 ms* | ***346*** |

The latencies sit inside the existing quiet-box spread, and the **round-trip
count is identical — 346 in every run, old and new**. That count is the
discriminating figure: it is a property of the query plan the router issues, not
of the machine's mood, and a double would not reproduce it.

**So the recorded p50 388 ms / p95 461 ms stands, and W146's verdict stands.**

### What DID need fixing: the label had no binding to the object

W146 never had M256(a)'s bug, but it had the same *structural* weakness —
nothing asserted that the object handed to the router was a real client. The
comment said "the REAL supabase-js client", and a comment is worth exactly as
much as the next edit's care.

Two additions close it:

- an **install-time refusal** in `before()`: the client's own `rest.url` must
  start with the configured `SUPABASE_URL`, or the harness throws before a single
  request is measured;
- a **case that reports it as a pass**, `"the measured client IS the real one —
  the label is bound to the object"`, so the property is visible rather than
  merely un-violated.

Armed, not assumed: replacing the measured client with a plain-object double —
leaving every sentence in the file intact — makes `before()` throw
*"the client about to be measured does not point at the configured target …
A benchmark whose client is not the real one is a number about nothing"* and
cancels all six live cases. Restored: 16/16.

### Scope, unchanged

Still a loopback PostgREST over a disposable PostgreSQL: real schema, real
indexes, real planner, no network, no production data. It is a regression gate on
the work the route does per request. It is **not** a production latency, and the
production column of the table above remains deliberately empty.

