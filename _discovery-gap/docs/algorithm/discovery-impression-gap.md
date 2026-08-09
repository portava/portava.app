# Discovery produces zero ranking impressions — and it may not be a logging bug

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

**Nothing is fixed here.** The first correction below is to a recommendation I
made before reading `logImpression`'s contract.

---

## The correction

My first read was "the `logImpression` call is stranded on the cold-fetch path;
move it so cached serves log too." That is not implementable as stated, and the
reason matters more than the fix.

`logImpression` requires ranking output, not just item ids:

```ts
export async function logImpression(
  scored: ScoredCandidate<RankCandidate>[],   // ← .candidate.kind, .candidate.id, .features
  userId: string,
  surface: "pulse" | "discovery" | "events",
  sessionId?: string,
): Promise<void>
```

It writes `features: stripCoordinateKeys(s.features)` per row — the feature
vector the ranker produced. The cached paths serve `DiscoveryPlace` objects via
`toPublic()`. They have no features, **because no ranking ran**. Ranking and
`scoredByPlaceId` exist only on the cold-fetch path.

So the call cannot move. The data it needs is not there.

---

## What that implies

`rank_events` records *ranked* serves. If Discovery has zero rows, then on this
corpus **Discovery ranking is essentially never executing** — the cache is
serving nearly every request, and personalisation is being bypassed rather than
merely unlogged.

That is a different and larger problem than an instrumentation gap. The feed
spec leans on Discovery relevance; if the ranker rarely runs, that relevance is
not being computed, let alone measured.

### Six serve points, three serve items, one logs

| Line | Path | Serves | Logs? |
|---|---|---|---|
| 1105 | `serveCachedPlaces()` — L1 memory / L2 Postgres | `slice` | **no** |
| 1161 | empty result | `[]` | n/a |
| 1228 | compass candidate cache hit | `cSlice` | **no** |
| 1270 | compass candidate, uncached | `cSlice` | **no** |
| 1441 | cold fetch | `slice` | **yes** (line 1433) |
| 1447 | empty fallback | `[]` | n/a |

And the one logging call is further gated:

```ts
if (callerUserId && scoredByPlaceId.size > 0) { … }
```

So it needs an **authenticated** caller, a **non-empty ranking**, and a **cache
miss**, simultaneously.

---

## Three candidate causes — production evidence needed

Cannot be separated from the repo. In rising order of severity:

1. **Cache hit rate is ~100%.** Cold fetch effectively never runs, so ranking
   never runs. Discovery personalisation is not happening.
2. **Discovery traffic is mostly unauthenticated.** `callerUserId` is null, the
   guard short-circuits. Ranking may run but is never recorded.
3. **`scoredByPlaceId` is empty even on cold fetch.** Ranking runs but produces
   nothing — a bug in the ranker's Discovery path.

### How to tell them apart, without new instrumentation

The handler already logs each path distinctly:

```
line 1104   "discovery: cache hit"                 { cacheLevel: "L1" | "L2" | … }
line 1227   "discovery: compass candidate cache hit"
line 1439   "discovery: cold fetch"                 { cacheLevel: "miss", dbCount, osmCount }
```

Count these in production logs over a representative window.

- Almost no `cold fetch` → **cause 1**. The fix is about cache policy or about
  ranking cached results, not about logging.
- Plenty of `cold fetch` but still zero rows → **cause 2 or 3**. Distinguish by
  whether those requests carry auth.

Do this before changing code. Each cause has a different fix, and two of the
three are not fixed by touching `logImpression` at all.

---

## If it turns out to be cause 1, the options are not equal

| Option | Cost |
|---|---|
| Rank on cache hit, then log | Correct impressions, but re-ranking on every hit gives up the latency the cache exists for. |
| Log a feature-less impression on cache hit | Cheap, and it **pollutes the corpus**: rows with empty `features` are indistinguishable at query time from ranked rows whose features were genuinely empty. Fitting weights on that mixture is worse than having no discovery rows, because the gap stops being visible. |
| Cache the ranking alongside the places | Preserves both latency and fidelity. Largest change — the cache entry has to carry scores, and they go stale with the ranker. |
| Accept that cached serves are not ranked impressions | Zero code. Requires saying out loud that Discovery is unpersonalised, and deciding whether that is acceptable. |

The second option is the tempting one and the one to avoid. A row that looks
like a ranked impression and carries no ranking is exactly the failure mode
this project keeps rediscovering: a signal that reports success while carrying
nothing.

---

## Related, from the same diagnostic run

- **`living_page` is rejected by the live CHECK.** Permitted surfaces live are
  `pulse, discovery, events, compass, search, nearby, story, event, trip,
  profile, explore` — 11 values against the 3 declared in migration `0153`.
  `living_page` is not among them, so every Living Page impression fails its
  insert and is swallowed by the fire-and-forget handler in
  `routes/rankEvents.ts`. Also note `logImpression`'s `surface` parameter is
  typed `"pulse" | "discovery" | "events"`, so those surfaces could not route
  through it even if permitted — they are direct inserts.
- **Eight permitted surfaces are never written**: `search`, `nearby`, `story`,
  `event`, `trip`, `profile`, `explore` — plus `living_page` written but not
  permitted. The declared and actual vocabularies have drifted apart in both
  directions.
- **`item_kind` already permits `buddy`** (`post, event, plan, buddy, place,
  gem`), which makes the buddy-booking instrumentation cheaper than assumed —
  see `rank-events-signal-gaps.md` finding 2.

---

## Not verified here

- Which of the three causes holds. That needs the production log counts above.
- Whether `serveCachedPlaces` returns ranked ordering by accident (e.g. cached
  in ranked order from a prior cold fetch). If so, cached serves may be
  *partially* personalised, which changes what "unranked" means here.
