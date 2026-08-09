# Discovery ranking may rarely or never execute on the dominant serve path

Found by `src/scripts/checkRankEventsSurfaces.ts` (commit `5c525ffca`).
`discovery` is a **permitted** surface, the code **does** call `logImpression`,
and the live table holds **zero** discovery rows.

```
── observed rows by surface ──
      179775  pulse
       12556  compass
        5200  events
   (discovery: absent)
```

**Nothing is fixed here.** No code changes. This document establishes what is
cached, which was the open question blocking any fix.

---

## Finding statement

"Discovery has zero ranking impressions" is not sufficient to conclude
"Discovery impressions are broken." The supported statement is:

> **Discovery ranking may rarely or never execute on the dominant serve path.**

The invariant this protects: `rank_events` means *this entity was actually
processed by the ranker with a real feature vector*. Rows must not be created
for cached or unranked objects merely to close a telemetry gap.

---

## Two corrections to my earlier write-up

**1. The `logImpression` call cannot simply be moved.** It requires ranking
output, not item ids:

```ts
export async function logImpression(
  scored: ScoredCandidate<RankCandidate>[],   // ← .candidate.kind, .candidate.id, .features
  userId: string,
  surface: "pulse" | "discovery" | "events",
  sessionId?: string,
): Promise<void>
```

It writes `features: stripCoordinateKeys(s.features)` per row. Cached paths
serve `DiscoveryPlace` objects via `toPublic()` — no features, because no
ranking ran on that path.

**2. My cost table said "re-ranking on every cache hit gives up the latency
the cache exists for." That was wrong**, and it was wrong because I had not yet
established what the cache holds. See below — the cache exists to avoid an
Overpass/Nominatim *network fetch*. Ranking is in-process CPU plus two small
indexed lookups. Those are not the same order of cost. The corrected table is
at the end.

---

## What is actually cached

There are **two** caches on this route, they hold different things, and they
fail in different ways.

### Cache A — the L1/L2 places cache

```ts
interface CacheEntry { places: DiscoveryPlace[]; cachedAt: number }   // :137
function cacheKey(dest: string, cat: string, radius: number)          // :159
```

**Key is user-independent** — destination, category, radius. No userId, no
session, no context.

**It holds raw shared candidate data**, not a resolved response. `DiscoveryPlace[]`
straight from OSM. This is the *correct* thing to cache.

Three exits serve from it, all through one helper:

| Line | Exit | `cacheLevel` |
|---|---|---|
| 1114 | L1 in-memory hit | `"L1"` |
| 1130 | L2 Postgres, fresh | `"L2_fresh"` |
| 1151 | L2 Postgres, stale-while-revalidate | `"L2_stale"` |

And `serveCachedPlaces` (:1089–1110) does, in full:

```
queryDbPlaces()      re-query community DB places (fresh every request)
haversine annotate   if sortBy === "nearest"
mergeAndDedup()
applyFilters()
.slice(page)  → toPublic()
res.json({ … cached: true })
```

**No `rankCandidates`. No `scoreWithContext`. No `logImpression`.**

Each call site is `await serveCachedPlaces(…); return;` — an early return that
terminates the handler at line 1115 / 1131 / 1152. The ranker is at **1339**,
inside `if (callerUserId)` at **1288**. Every cache-A hit returns before that
code is reachable.

> **So for cache A the answer is neither option posed.** It is not an
> already-resolved response — it is raw shared candidates, keyed correctly.
> The per-user ranking step is simply **absent from the cached branch**. The
> cold path ranks *after* candidate assembly; the cached path performs the same
> assembly and then serves without ever ranking.

Against the target pipeline:

```
intended:  cache shared candidates → retrieve cheap → apply user features → rank → serve → log
cold:      fetch OSM → cache → merge DB → rank per user → serve → log        ✓
cache A:   hit → merge DB →  ── no rank ──  → serve →  ── no log ──          ✗
```

The cache is the right shape. One stage is missing from one branch.

### Cache B — the compass candidate cache

```ts
const _compassCandidateCache = new Map<string, { places: DiscoveryPlace[]; at: number }>();  // :153
compassCandidateCacheKey(callerUserId, destination, radiusKm, sortBy)                        // :155
  → `${userId}:${destination}:r${radius}:s${sortBy}`
```

**Key includes `callerUserId`** — this cache is per-user. And what it stores is
the **post-ranking** result:

```ts
const compassRanked: DiscoveryPlace[] = scored.map((r) => { … });   // :1248
_compassCandidateCache.set(cCacheKey, { places: compassRanked, at: Date.now() });  // :1263
```

> **For cache B the answer is the second option** — an already-resolved,
> ranked result. But because the key is per-user, it is **not** serving one
> user's ranking to another. Ranking did run, for this user, once. Replays
> within TTL are stale, not wrong.

The consequence differs accordingly: cache B is **not** a personalisation
bypass. It is a genuine telemetry gap — real ranked serves that go unrecorded
on replay. Note `scored.map(...)` keeps the *order* and discards the
`ScoredCandidate` wrapper, so the **features are thrown away at write time**.
Logging a replay would require storing them, not re-deriving them.

---

## What this means for the zero rows

The only `logImpression` call is at **1433**, on the cold-fetch path, gated:

```ts
if (callerUserId && scoredByPlaceId.size > 0) { … }   // no sessionId passed
```

Both caches return before reaching it. So zero rows means **cold fetch with an
authenticated caller and a non-empty ranking essentially never completes** —
one or both caches absorb effectively all authenticated Discovery traffic.

That is now structurally supported, independent of any production number. What
the production numbers still decide is **which cache dominates**, because the
two need different fixes:

| Dominant path | Nature | Fix |
|---|---|---|
| Cache A | **Ranking bypass.** Personalisation is not computed at all. | Architectural — apply ranking after cache retrieval |
| Cache B | **Telemetry gap.** Ranking ran; the replay is unlogged and features were discarded. | Narrow — persist features with the entry, log on replay |

Both may be significant. They are not the same problem and should not get the
same fix.

---

## The one production fact still needed

Count these three log lines over a representative window, as **counts and
percentages of the three**:

```
:1104   "discovery: cache hit"                    { cacheLevel: "L1" | "L2_fresh" | "L2_stale" }
:1227   "discovery: compass candidate cache hit"
:1439   "discovery: cold fetch"                   { cacheLevel: "miss", dbCount, osmCount }
```

`cacheLevel` further splits cache A three ways, which matters for TTL policy
but not for the A-versus-B decision above.

Reading:

- **Cache A ≫ everything** → ranking bypass is the primary finding. Product
  decision about where personalisation sits relative to caching.
- **Cache B ≫ everything** → primarily a logging gap on a per-user cache.
  Smaller, and does not implicate personalisation.
- **Cold fetch non-trivial but still zero rows** → the gate is failing, not the
  cache. Check whether those requests carry auth (`callerUserId`) and whether
  `scoredByPlaceId` is populated.

No new instrumentation is required to get this. The lines already emit.

---

## Corrected options — cache A only

Superseding the table in the previous revision.

| Option | Real cost |
|---|---|
| **Rank after cache retrieval** | The Overpass/Nominatim fetch stays cached — that is what the cache is for. Added cost is `rankCandidates` in-process over the page, plus two indexed lookups (`user_follows`, `compass_user_preferences`). Not free, and the `DiscoveryRankingService` pass at :1344 has unmeasured cost — but not the round trip the cache exists to avoid. **My earlier framing of this as giving up the cache benefit was wrong.** |
| Log a feature-less impression on cache hit | **Do not.** Rows with empty `features` are indistinguishable at query time from ranked rows whose features were genuinely empty. Fitting weights on that mixture is worse than zero rows, because the gap stops being visible. This violates the `rank_events` invariant stated at the top. |
| Cache the ranking alongside the places | Coherent for cache B, where the ranking already exists and is being discarded. For cache A it is wrong on its face — the entry is shared across users, so a stored ranking would be one user's, replayed to others. |
| Accept that cached serves are unranked | Zero code. Requires saying out loud that Discovery is substantially unpersonalised, and deciding whether that is acceptable. |

Per-user caching of the *ranking* on cache A would require re-keying the entry
by user, which discards the shared-candidate benefit that makes cache A
correct. That is the trade the first option avoids.

---

## Related, from the same diagnostic run

- **`living_page` is rejected by the live CHECK.** Permitted live: `pulse,
  discovery, events, compass, search, nearby, story, event, trip, profile,
  explore` — 11 values against the 3 in migration `0153`. `living_page` is not
  among them, so every Living Page impression fails its insert and is swallowed
  by the fire-and-forget handler in `routes/rankEvents.ts`. Note also that
  `logImpression`'s `surface` parameter is typed `"pulse" | "discovery" |
  "events"`, so other surfaces could not route through it even if permitted —
  they are direct inserts.
- **Eight permitted surfaces are never written**: `search`, `nearby`, `story`,
  `event`, `trip`, `profile`, `explore` — plus `living_page` written but not
  permitted. The declared and actual vocabularies have drifted in both
  directions.
- **`item_kind` already permits `buddy`** (`post, event, plan, buddy, place,
  gem`), making buddy-booking instrumentation cheaper than assumed — see
  `rank-events-signal-gaps.md` finding 2.

---

## Not verified here

- **The A/B split.** Needs the production log counts above. Everything in this
  document about *which* cache dominates is unresolved until then.
- **The cost of ranking on a cache hit.** Argued from what the code does, not
  measured. The `DiscoveryRankingService` pass at :1344 was not read closely
  and may carry I/O that changes the first option's cost.
- **Whether cache-A ordering is accidentally ranked** — e.g. an entry written
  by a prior cold fetch retaining that fetch's ranked order. `mergeAndDedup`
  and `applyFilters` run over it afterward, so any such order is not preserved
  intact, but this was not traced.
