# Portava Discovery Engine — current state

*Derived from the repository, 2026-09-04. Authoritative for control flow only where it cites a
file; where it touches rulings it defers to `docs/discovery/ROADMAP.md`.*

The discovery engine answers `GET /discovery` (and the sibling routes `/discovery/feed`,
`/search`, `/suggest`, `/community`). Its job is to turn a `(destination, category)` request into
a page of places, events, plans and gems. What actually runs is a **two-cache serve pipeline**
with an optional per-request ranker whose activation is governed by an **engine-mode switch**.

## The two caches are in series, not a fork

`routes/discovery.ts`:

- **Cache A** is a **user-independent** candidate cache keyed on `(destination, category,
  radiusKm)` with a ~2-hour TTL. It holds the unranked candidate list. It is checked first and,
  on a hit, can return **before** the Compass ranking block.
- **Cache B** is a **per-user** cache holding a rendered/ranked page. On a cold fetch the
  *unranked* candidate list is written to Cache A while the ranked output goes only to the
  requesting user's Cache B entry.

The consequence, true at any traffic volume including zero, is that under the legacy default a
given Cache-A key is ranked **at most once per TTL and for exactly one user**; every other
request for that key receives the cached candidate order. This is the control-flow defect that
roadmap option **D5=B** (rank on every request over a user-independent candidate cache) exists to
close.

## The ten serve points

Every place the surface hands items to a caller is a numbered serve point
(`DiscoveryServePoint`, `lib/discoveryServeLog.ts`), logged to `rank_events` behind the
`discovery_serve_log_enabled` flag so the D4=C baseline covers **everything users receive**:

| # | Point | Ranks in-request? |
|---|---|---|
| 1 | `CACHE_A_L1` | legacy: no · pde: **yes** |
| 2 | `CACHE_A_L2_FRESH` | legacy: no · pde: **yes** |
| 3 | `CACHE_A_L2_STALE` | legacy: no · pde: **yes** |
| 4 | `CACHE_B_HIT` | no — replays a stored Compass order |
| 5 | `COMPASS_FRESH_RANK` | **yes** |
| 6 | `COLD_FETCH_LEGACY_RANK` | **yes** |
| 7 | `FEED` (`GET /discovery/feed`) | no ranker. *Had no caller in the repo until #382 (2026-09-04); it now has two — `DiscoveryEventPostsRail.tsx` and `ForYouTab.tsx:428`* |
| 8 | `SEARCH` | no ranker (query relevance) |
| 9 | `SUGGEST` | no ranker |
| 10 | `COMMUNITY` (`GET /discovery/community`) | no ranker |

Serve points 5 and 6 are the only ones that rank in-request under **legacy** mode. Points 7–10
run no ranker and are therefore excluded from the D5 ranked-share denominator (`RANKED_POINTS`
history is in `04`/`06`; the reader is `discoveryServePointReport.ts`).

## Engine mode: legacy / pde / shadow

`DISCOVERY_ENGINE_MODE` (migration `2091`, seeded `mode=legacy`, `enabled=false`) is the
three-valued switch (`lib/discoveryEngineMode.ts`). `metadata.mode` has a fail-closed write path
(`PATCH /admin/feature-flags/:flag/metadata`, migration `2198`): an unrecognised mode is refused
rather than stored, so a typo cannot silently serve `legacy`.

- **legacy** — the shipping default. Cache-A hits return the cached candidate order unranked.
- **pde** — cache-A serve points 1–3 rank the cached candidates per request
  (`serveCachedPlaces`, the `pdeScoredById` branch) and log those impressions with
  `rankedInRequest: true`. This is the D5=B serve path, landed inert by **#250**. It is **wired
  but held OFF**, and the hold is a named, unruled owner gate — ROADMAP **Phase F, gate 2** —
  not merely a preference: the flag ships `enabled=false`/`mode='legacy'` (`2091:70-73`) and no
  later migration moves it. The empirical check owed before the flip (ROADMAP Phase E step 3) is
  still undischarged, and the instrument it reads was corrected in #366 and #387, so it is owed
  a **fresh** reading rather than the retrieval of `serve-point-report-20260828.md`'s numbers.
- **shadow** — `lib/discoveryShadow.ts` computes the page a pde serve *would* have produced,
  after the response and with writes suppressed, and records the divergence. Append-only per
  D7=A (migrations `2092`–`2094`).

## What is deliberately not built here

- **The pde serve path is not enabled.** It exists and is tested; enabling it is an owner
  decision, blocked on traffic, not on engineering (ROADMAP; `serve-point-report-20260828.md`).
- **Event Truth** — the append-only decision store that would make ranked pages reconstructable
  six months later — is **Phase-B gated and unbuilt** (`event-truth-schema-packet.md`). See `04`.
