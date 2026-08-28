# Discovery serve-point report — 2026-08-28

Run against **production** (`ajrurzioarfkagpuxfnb`), read-only, from `public.rank_events`
where `surface = 'discovery'`. Serve-point markers are read from `features->>'servePoint'`,
the same field `lib/discoveryServePointReport.ts` consumes.

## Result

| Population | Rows | Sessions | Window |
|---|---|---|---|
| `GET /discovery` — serve points 1–6 (**the D5 denominator**) | **0** | — | — |
| Serve points 7–9 (feed / search / suggest) | 13 | 4 | 2026-08-15 03:12Z → 08:13Z |

Every one of the 13 rows carries `servePoint = 9` — **SUGGEST**. Serve points 1–8 have
produced no rows at all. `engineMode` and `modeReason` are absent from every row.

## Verdict: D5 cannot be answered — exit 3, pause

The D5 revisit clause asks *what fraction of `GET /discovery` serves reached a ranker*.
That fraction is **0 / 0 — undefined**, not "low". There is no denominator.

Serve point 9 is deliberately excluded from the D5 arithmetic
(`discoveryServePointReport.ts:91-104`): suggest contains no ranker call at all, so a row from
it is not "a serve that could have been ranked and lost". Counting it would push the ranked
share down with rows that were never candidates — a second measurement error introduced while
fixing the first, and a self-confirming one.

## Why there is no data — and why waiting will not fix it

This is **not** an instrumentation failure. `discovery_serve_log_enabled` is enabled in
production and the writer works where it was exercised. The cause is that **the traffic does
not exist**:

- Across *all* surfaces, `rank_events` has ≤ 7 distinct `user_id` values ever.
- The discovery rows come from 4 sessions on a single day, twelve days ago.
- Production contains only test data and has no real end users.

Two structural limits compound this, both worth recording because they will still apply after
launch:

1. **Anonymous traffic can never be counted.** `rank_events.user_id` is `NOT NULL`
   (`0153_add_rank_events.sql`), so every figure this report can ever produce is a share of
   *authenticated* serves. `logDiscoveryServe` returns early without a `userId`
   (`discoveryServeLog.ts:192`).
2. **Serve point 7 has no caller.** `GET /discovery/feed` is implemented and instrumented
   (`discovery.ts:1910`, log at `:2056`) but nothing in the repository calls it, so it cannot
   contribute rows regardless of traffic.

**Consequence for the programme:** Stages 0→4 are blocked on *having users*, not on
engineering. Stage 0 cannot yield a baseline, Stages 2–3 cannot measure divergence, and
Stage 4 cannot measure engagement, until real traffic exists. No further Discovery
instrumentation work changes that. The engine work itself can continue — it simply cannot be
*validated* against user behaviour before launch.

## Also uncovered while producing this

`GET /discovery/community` (`discovery.ts:2115`, returns items at `:2329-2345`) is a genuine
serve point that is **entirely uninstrumented** — no `logDiscoveryServe`, no `logImpression`,
no serve-point marker, and no enum member. Ruling D4=C requires the baseline to cover
everything users receive. It does not. When traffic exists, this route's serves would be
invisible to the very measurement the baseline was widened to make representative.
