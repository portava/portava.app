# P1 Phase −1 — the repository proof

**Governing rule: no P1 architecture work may use an unverified factual claim as
a prerequisite.** Every claim carried into P1 is labelled below as one of
**REQUIREMENT** (an owner directive, not a fact about the tree), **KNOWN CURRENT
STATE** (verified at HEAD with `file:line`), or **ASSUMPTION TO VERIFY** — and
every assumption is then verified or refuted.

Verified at **HEAD = `93523f4fb`** (`Merge pull request #37 from
portava/retention-window-20260814`), branch `bughunt-20260805`.

> **Read this first — the session began on a stale HEAD.** The working checkout
> was at `8d04d9919`, **two commits behind** `origin/bughunt-20260805`. Unit D
> (`a759208a6`) was not an ancestor of that commit, so the handoff claim "units
> A–D all merged" read as **false** until the checkout was updated. It is
> **true** at the real HEAD. All findings below were re-confirmed after
> `git reset --hard origin/bughunt-20260805`; `git diff 8d04d9919 HEAD` over
> every discovery file read here is **empty**, so no discovery finding moved.
> The lesson is recorded because the failure mode is silent: a stale checkout
> refutes true claims, which is the same observable signal as a false claim.

---

## 0. Carried-in claims that are not about discovery

| Claim | Label | Verdict |
|---|---|---|
| Units A–D all merged | ASSUMPTION | **CONFIRMED at real HEAD.** Unit D = `a759208a6`, merged via PR #37 (`93523f4fb`). Not an ancestor of the stale `8d04d9919`. |
| `artifacts/travel-buddy` archived at `bc1bef404` | ASSUMPTION | **CONFIRMED.** `bc1bef404` is an ancestor of HEAD; `git ls-files artifacts/travel-buddy` returns **0 tracked files**. Note: an **untracked** copy still sits on disk in the primary working directory (`node_modules`, `ios`, `expo-env.d.ts`) — archived in git, still present on the filesystem. |
| 90-day retention policy at `docs/ops/retention-policy.md` | ASSUMPTION | **CONFIRMED at real HEAD** (213 lines, added by `a759208a6`). Absent at the stale checkout — this was the tell that exposed the stale HEAD. |
| post-media anonymous read REVOKED in production | ASSUMPTION | **CONFIRMED in-repo.** `src/migrations/2089_revoke_post_media_public_read.sql:101` drops `post_media_storage_public_read`; evidence written up in `docs/media/post-media-public-read-revocation-evidence.md`. |

### The premise change, and where it bears on discovery

`docs/media/staging-boundary-decisions.md:55-57` still lists the read policy
under **"Held — do not touch"**, and `docs/ops/unseeded-flag-inventory.md:168`
still reads "Held and untouched: `post_media` read policy". **Both are now stale
prose.** The hold that forced the staging boundary's D1 answer no longer exists.

**Bearing on discovery: none that is load-bearing, and this is worth stating
plainly rather than leaving implied.** Discovery serves OSM/Overpass places and
`discovery_places` rows. Neither Cache A (`discovery_cache`) nor Cache B
(`_compassCandidateCache`) stores media bytes or signed URLs — the only media
field on a `DiscoveryPlace` is `headerImageUrl`, and the ranking path reads it
only as a **boolean** (`hasMedia: !!(p.headerImageUrl)`,
`routes/discovery.ts:1360`, and a completeness weight at `:1361`). Revoking
anonymous read on `post-media` therefore cannot change discovery ordering,
discovery cache contents, or discovery cache keys. The two subsystems touch only
where a place carries a header image for **display**, and that is a rendering
concern downstream of everything P1 proposes. The two stale docs above should be
corrected, but not as part of P1.

---

## 1. SERVE TOPOLOGY

> Claimed: "discovery has six serve points; five return before any logging;
> three return before any ranker runs."

**Label: ASSUMPTION TO VERIFY. Result: two-thirds confirmed, one third refuted.**

### 1a. The six serve points of `GET /discovery` — CONFIRMED

`GET /discovery` is defined at `routes/discovery.ts:890`. It has exactly **six**
paths that return candidate places to a user:

| # | Serve point | Line | What serves it | Writes `rank_events`? | Runs a ranker **in this request**? | Where the order came from |
|---|---|---|---|---|---|---|
| 1 | Cache A — L1 hit | `:1114` → `:1105` | in-process `Map` | **No** | **No** | raw Overpass order |
| 2 | Cache A — L2 fresh | `:1130` → `:1105` | `discovery_cache` table | **No** | **No** | raw Overpass order |
| 3 | Cache A — L2 stale (SWR) | `:1151` → `:1105` | `discovery_cache` + background revalidate | **No** | **No** | raw Overpass order |
| 4 | Cache B hit | `:1228` | `_compassCandidateCache` | **No** | **No** | Compass order, up to 10 min old |
| 5 | Compass fresh rank | `:1270` | `rankItemsForDiscovery` (`:1242`) | **No** | **Yes** — Compass | Compass |
| 6 | Cold fetch — legacy rank | `:1441` | `rankCandidates` (`:1339`) + `drsRankItems` (`:1398`) | **Yes** (`:1433`) | **Yes** — portavaRank + DRS | legacy |

Three further exits return **no places** and are not serve points: `:954`
(HTTP 400, no destination), `:1161` (geocode failed → empty list), `:1447`
(handler threw → empty list).

### 1b. "Five return before any logging" — CONFIRMED, with the word "logging" pinned

Exactly **one** of the six (#6, at `:1433`) calls `logImpression`. The other
five return without writing a single `rank_events` row.

The claim is only true if **"logging" means `rank_events` impression logging**.
It is false for request logging: #1, #2 and #3 all emit `req.log.info(...,
"discovery: cache hit")` at `:1104`, and #4 emits one at `:1227`. The
distinction matters for P1 — a shadow mode that "logs" must be explicit about
which of the two it means, and only one of them is the measurement substrate.

### 1c. "Three return before any ranker runs" — REFUTED as stated

Under the plain reading — *no ranker executes during this request* — the answer
is **four**, not three: serve points #1, #2, #3 **and #4**. Cache B hit (#4)
replays a stored order and invokes no ranker.

Under the other available reading — *the order served was never produced by any
ranker* — the answer is **three** (#1, #2, #3), because #4's order was produced
by Compass on an earlier request.

Both readings are defensible in English; they are not interchangeable in design.
**The number that governs P1 is four**, because a flag deciding "which engine
handled this request" must account for every path on which *no engine ran at
all*, and #4 is one of them.

### 1d. The rest of the discovery surface — serve points the claim omits

The claim is scoped to `GET /discovery`. Four further routes serve discovery
content at HEAD and **none of them ranks or logs**:

| Route | Line | Ranks? | Logs `rank_events`? | Uses Cache A? |
|---|---|---|---|---|
| `GET /discovery/feed` | `routes/discovery.ts:1560` | **No** | **No** | **No** — calls `queryOverpass` directly (`:1640`) |
| `GET /discovery/counts` | `routes/discovery.ts:1503` | No | No | **Writes it** — see §1e |
| `GET /discovery/search` | `routes/discoverySearch.ts:1321` | **No** | **No** | No |
| `GET /discovery/suggest` | `routes/discoverySearch.ts:1570` | **No** | **No** | No |

`grep` for `rankCandidates|rankItemsForDiscovery|drsRankItems|logImpression` over
`routes/discoverySearch.ts` returns **nothing**. `/discovery/feed` bypasses the
cache layer entirely and merges raw Overpass + DB output with no scoring step.

**Consequence for P1:** "discovery" is not one pipeline with six exits. It is
**ten serve points across five routes, of which exactly two rank and exactly one
logs.**

### 1e. `/discovery/counts` writes the cache that `/discovery` serves from

`routes/discovery.ts:1542` — `if (enriched.length > 0) cache.set(k, { places:
enriched, cachedAt: Date.now() })` — uses the **same `cacheKey(destination, cat,
radiusKm)`** as the main route. A category-count request therefore **primes
Cache A**, and the next `GET /discovery?category=for_you` for that city serves
from L1 at `:1114` without ranking.

It warms **L1 only** (no `writePlacesToDb`), so this priming is per-instance and
invisible to any database query.

### 1f. Dead code found: `scoreWithContext` is unreachable

`routes/discovery.ts:1423` reads `ranked = discoveryCtx ? scoreWithContext(places,
discoveryCtx) : places`. It sits in the `else` branch of `if (callerUserId)`
(`:1288`). But `discoveryCtx` is assigned only at `:942`, inside `if
(authData?.user)`, which also sets `callerUserId` at `:925`. So `discoveryCtx !==
null` **implies** `callerUserId !== null`, and in the `else` branch `discoveryCtx`
is always `null`.

**`scoreWithContext` (defined at `:817`) never runs from this route.** The
unauthenticated cold-fetch serve is completely unranked. This is not a P1
deliverable, but it means "the legacy path" has no anonymous ranking behaviour to
preserve or compare against.

---

## 2. THE CACHE FORK

> Claimed: Cache A = L1 Map + L2 `discovery_cache`, user-independent key, serves
> raw pre-ranking candidates, never ranks. Cache B = `_compassCandidateCache`,
> per-user, stores post-ranking order, features discarded.

**Label: ASSUMPTION TO VERIFY. Result: CONFIRMED in full, plus two structural
findings the claim does not contain.**

### 2a. Cache A — confirmed

| Property | Evidence |
|---|---|
| L1 = in-memory `Map` | `const cache = new Map<string, CacheEntry>()` — `routes/discovery.ts:144` |
| L2 = `discovery_cache` table | `lib/discoveryPersistentCache.ts:55` (read), `:100` (upsert, `onConflict: "cache_key"`) |
| Key is **user-independent** | `cacheKey(dest, cat, radius)` = `` `${dest.toLowerCase().trim()}:${cat}:${radius}` `` — `routes/discovery.ts:159-161`; call site `const key = cacheKey(destination, category, radiusKm)` at `:1025`. **No `callerUserId` term.** |
| Stores **raw pre-ranking** candidates | `cache.set(key, { places: enrichedOsm, ... })` at `:1204`; `enrichedOsm` is Overpass output plus saved-counts (`:1185`), assembled **before** any ranker |
| **Never ranks** | `serveCachedPlaces` (`:1089-1110`) does `mergeAndDedup` → `applyFilters` → `slice`. `applyFilters` (`:1028`) applies openNow/minRating/age filters and the plain `sortBy` comparators (`:1053-1071`). No ranker. |
| TTL | 2 h (`PLACE_TTL_MS`, `lib/discoveryPersistentCache.ts:19`) |

### 2b. Cache B — confirmed

| Property | Evidence |
|---|---|
| `_compassCandidateCache` | `routes/discovery.ts:153` |
| **Per-user** key | `` `${userId}:${destination}:r${radiusKm}:s${sortBy}` `` — `:155-157` |
| Stores **post-ranking** order | written at `:1263` from `compassRanked`, built at `:1248` from `scored` = `rankItemsForDiscovery(...)` output (`:1242`) |
| **Features discarded** | `:1248-1258` maps each scored result back through `placeById` to the plain `DiscoveryPlace`. The score and every feature on `r` are dropped; **only the array order survives.** |
| TTL | 10 min (`COMPASS_CANDIDATE_CACHE_TTL_MS`, `:152`) |
| In-process only | no table behind it |

### 2c. Finding the claim does not contain: **the fork is not a fork — A gates B**

The Cache A check (`:1113`) returns **before** the Compass block (`:1211`) is
ever reached. The two caches are not parallel branches; they are in **series**,
A first.

Everything follows from that ordering:

1. **The ranker runs only on a Cache A miss.** For `category=for_you`, a Cache A
   hit serves raw Overpass order and returns at `:1114` / `:1130` / `:1151`,
   never reaching `:1211`.
2. **Cache A is user-independent; Cache B is per-user.** On a cold fetch, user X
   triggers the Compass rank, receives it, and stores it under **X's** Cache B
   key — while the **raw, pre-rank** list is written to Cache A under a key
   **shared by everyone** (`:1204`).
3. Therefore: **for a given (city, category, radius), the Compass ranker runs at
   most once per 2 hours, its output is served to exactly one user, and every
   other user for the next 2 hours receives the unranked Overpass order.**

This is the mechanism behind the owner's directive, stated structurally.

### 2d. Finding the claim does not contain: **Cache B is very nearly unreachable**

Cache B's TTL (10 min) is shorter than Cache A's (2 h), and Cache B is only
consulted **after** Cache A misses. In steady state a Cache A miss at time *T*
writes Cache A at `:1204`; the next miss for that key cannot occur before
*T + 2 h*, by which time the Cache B entry written at *T* (`:1263`) has been dead
for 1 h 50 m.

Cache B can only be hit when Cache A does **not** get written or is evicted:

- **Overpass returned nothing.** Both cache writes sit inside one guard, `if
  (enrichedOsm.length > 0)` at `:1203` — L1 at `:1204` and L2 at `:1206`. A key
  whose Overpass query is empty or times out is cached in **neither** layer and
  cold-fetches on every request.
- **Concurrent requests** in the window before `:1204` executes.
- **Invalidation** — save/un-save and admin image actions delete L2 rows
  (`lib/discoveryPersistentCache.ts:173`, `:210`).
- **Process restart** clears L1 (but L2 survives).

`sortBy=nearest` bypasses Cache B in both directions (`skipCache`, `:1222`,
`:1262`).

**Cache B is close to vestigial in production.** Any P1 design that treats it as
a meaningful serving tier — or that measures ranker behaviour by instrumenting it
— is measuring almost nothing. This is corroborated independently by
`src/scripts/checkDiscoveryCacheKeys.ts:127`, which records that Cache B "cannot
be seen" by any database query.

### 2d′. A third cache exists that the claim omits

`compass/CompassCacheEngine.ts` is a **separate** per-user cache: L1 `Map` keyed
`` `${userId}:${cacheKey}` `` (`:45-49`) plus L2 table **`compass_feed_cache`**
(`:99-105`), with per-type TTLs (`:23-30`) and its own invalidation + audit trail
(`:162-191`). It backs Compass feed surfaces, **not** `GET /discovery` — which
imports nothing from it. It is named here so it is not mistaken for Cache A: the
"L1 Map + L2 table" shape is common to both, but the tables, keys and semantics
are different.

---

## 3. `rank_events` IS MUTABLE STATE

> Claimed: outcome UPDATEs the impression row in place; one terminal outcome per
> impression; behaviour chains structurally impossible.

**Label: ASSUMPTION TO VERIFY. Result: CONFIRMED — and the third part is true
more strongly than claimed.**

- **In-place UPDATE — confirmed.** `routes/rankEvents.ts:158-161`:
  `.from("rank_events").update({ outcome, outcome_at }).eq("id", row.id)`. The
  target is found at `:131-139`: most recent row for this `user_id` + `item_id` +
  `surface` **filtered to `.eq("outcome", "impression")`** (`:137`), ordered
  `served_at` desc, limit 1.
- **One terminal outcome per impression — confirmed.** After the update the row's
  `outcome` is no longer `"impression"`, so the finder at `:137` can never match
  it again.
- **Behaviour chains structurally impossible — confirmed, and stronger than
  claimed.** A second outcome for the same item finds no row and returns **404 at
  `:153-155`** — which returns *before* the additive analytics insert at
  `:184-198`. So the second event in a chain produces **no row of any kind**. A
  tap reported before a save does not merely fail to chain; **the save is
  discarded entirely.**

**One qualification on "not an event log".** The table is a **hybrid** at HEAD.
Alongside the mutable impression rows, `:184-198` appends a genuine append-only
analytics row per outcome, tagged `outcome: "analytics"` as a sentinel
(`:193-194`) specifically to keep it from being matched by the impression finder.
`POST /rank-events` (`:42-77`) also inserts standalone `place_view` rows on
surface `living_page`. So: **the impression funnel is mutable state; a
parallel append-only stream shares the table.** Both statements must be carried
forward, because the first alone would make the analytics rows invisible to P1
and the second alone would make the funnel look like a log.

**What impression rows carry** (`lib/rankLog.ts:111-121`): `user_id`, `item_id`,
`item_kind`, `position` (array index), `features` (with GPS-bearing keys stripped
— `:64-73`), `outcome`, `served_at`, `surface`, `session_id` (one UUID per batch,
`:100`). This is the **only** place ranking features are persisted, and per §1b
it is reached from exactly one of the ten discovery serve points.

---

## 4. THE FLAG-LOADING TRAP

> Claimed: `compass/flags.ts` loads via LIKE on the `COMPASS_` prefix so a
> `DISCOVERY_`-named flag silently reads false; `isKillSwitchEngaged` treats a
> missing row as not-engaged and a genuine error as engaged.

**Label: ASSUMPTION TO VERIFY. Result: BOTH CONFIRMED — and they are in two
different modules, which is the part that decides the design.**

### 4a. The prefix trap — CONFIRMED

`compass/flags.ts:29`: `.like("flag", "COMPASS_%")`. `loadFlags` returns a record
containing **only** `COMPASS_`-prefixed rows; `isEnabled` (`:51-54`) then reads
`flags[flag] ?? false`.

A flag named `DISCOVERY_ENGINE_MODE` read through `isEnabled` returns **`false`
with no error, no warning and no log line**, however the row is set — and the
30-second TTL cache (`:9`, `:42-47`) means it stays false without a further
query. `routes/discovery.ts:35` imports `isEnabled` from exactly this module and
uses it at `:1215` for `COMPASS_V1_RULE_BASED_ENABLED`, which works only because
that name carries the prefix.

Additional failure mode in the same function: `loadFlags` swallows every error
and returns `{}` (`:35-37`), so a database failure makes **every** Compass flag
read `false` — and caches that empty result for 30 s.

### 4b. The kill-switch polarity — CONFIRMED

`lib/featureFlags.ts:55-67`. `maybeSingle()` on a **missing** row returns
`data: null, error: null` → `Boolean(null?.enabled)` → **`false` = not engaged**.
A **genuine** error returns `true` at `:62`, and a thrown exception returns
`true` at `:65` — **engaged**. The reasoning is documented in the file at
`:28-54` and is deliberate: an unreadable stop must engage.

### 4c. The finding that decides the design: **two flag systems, different semantics**

These are **not** the same loader, and P1 must choose between them explicitly:

| | `compass/flags.ts` | `lib/featureFlags.ts` |
|---|---|---|
| Query | `.like("flag", "COMPASS_%")` — bulk prefix | `.eq("flag", flag)` — exact match |
| Prefix constraint | **Yes** — non-`COMPASS_` names silently unreadable | **None** — any name works |
| Cache | 30 s in-memory | none |
| On DB error | all flags `false` | `isFlagEnabled` → `false`; `isKillSwitchEngaged` → **`true`** |
| Reads `metadata` | no | **yes** — `getFlagRow` (`:73-91`) returns `{ enabled, metadata }` |

Two consequences for `DISCOVERY_ENGINE_MODE`:

1. **A `DISCOVERY_`-prefixed flag must not be read through `compass/flags.ts`.**
   The choice is genuinely binary: name it `COMPASS_*` and use the existing
   loader, or keep the `DISCOVERY_` name and read it through
   `lib/featureFlags.ts`. There is no third option in which the current
   `isEnabled` sees it.
2. **A three-valued mode cannot be carried by `enabled` at all.** `enabled` is
   `boolean` (`lib/database.types.ts:5745`). The table does have `metadata Json |
   null` (`:5747`), and `getFlagRow` is the **only** helper at HEAD that reads it
   — in `lib/featureFlags.ts`, the non-prefixed module. This is a decision point,
   not a mechanic, and it is raised as **D3** in the design packet.

---

## Summary of verdicts

| # | Claim | Verdict |
|---|---|---|
| 1 | Six serve points in `GET /discovery` | **CONFIRMED** |
| 1 | Five return before any logging | **CONFIRMED** — where "logging" = `rank_events` only |
| 1 | Three return before any ranker runs | **REFUTED** — **four** run no ranker; three serve an order no ranker produced |
| 1 | (new) Four more discovery routes serve, none ranks or logs | **FOUND** — ten serve points across five routes |
| 1 | (new) `/discovery/counts` primes Cache A | **FOUND** — `:1542` |
| 1 | (new) `scoreWithContext` is unreachable | **FOUND** — `:1423` dead |
| 2 | Cache A shape, key, semantics | **CONFIRMED** |
| 2 | Cache B shape, key, semantics | **CONFIRMED** |
| 2 | (new) A gates B — ranker runs only on a Cache A miss | **FOUND** |
| 2 | (new) Cache B is near-unreachable in steady state | **FOUND** |
| 2 | (new) A third cache (`compass_feed_cache`) exists | **FOUND** |
| 3 | `rank_events` mutable; one outcome; no chains | **CONFIRMED** — chains fail harder than claimed (404, no row at all) |
| 3 | (qualification) a parallel append-only stream shares the table | **FOUND** |
| 4 | `COMPASS_` LIKE prefix trap | **CONFIRMED** — `flags.ts:29` |
| 4 | Kill-switch polarity | **CONFIRMED** — `featureFlags.ts:55-67` |
| 4 | (new) Two flag systems with different semantics | **FOUND** — decides D2/D3 |
| — | Units A–D merged / travel-buddy archived / retention policy / post-media revoked | **ALL CONFIRMED** at real HEAD |
