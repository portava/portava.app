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

## Also uncovered while producing this — and fixed

`GET /discovery/community` (`discovery.ts:2115`, returns items at `:2329-2345`) was a genuine
serve point that recorded **nothing** — no `logDiscoveryServe`, no `logImpression`, no
serve-point marker, no enum member. Ruling D4=C requires the baseline to cover everything users
receive, and it did not: once traffic exists, this route's serves would have been invisible to
the very measurement the baseline was widened to make representative.

**Now instrumented as serve point 10 (`COMMUNITY`)**, in the same change as this report. It
reuses the identity the saved-places block already resolves, so it costs no extra
`auth.getUser`; the call sits after `res.json`, un-awaited and flag-gated. It is deliberately
**excluded** from `DISCOVERY_ENDPOINT_POINTS`, `RANKED_POINTS` and `CACHE_A_POINTS`: community
runs no ranker, so counting it in the D5 denominator would repeat the error described above.

## What I deliberately did NOT build on the back of this

**The PDE serve path (D5=B) — held, on the packet's own terms.**

D5=B says: cache candidates user-independently, rank on every request. The engine side is
close to ready — `rankForViewer` exists, and the Stage 2 shadow block at `discovery.ts:1508`
already computes exactly the ranked page a pde serve would need, just after the response and
with writes suppressed. Wiring it to serve is a small, well-understood change.

It is held anyway, because the packet made the sequencing an explicit commitment:

> *"If Cache A's real hit rate is far lower than its TTL implies … D5 becomes materially
> cheaper, and option C stops being indefensible. **Stage 0 measures this directly, which is why
> it is sequenced before the flag rather than after it. No ruling here is irreversible on the
> strength of an unmeasured assumption.**"*

Stage 0 has now run and measured **nothing** (above). Building the pde serve path today would
be shipping a user-facing ranking change on precisely the unmeasured assumption the programme
said it would not rely on — and doing it at the one moment the measurement is known to be
absent rather than merely pending.

Two further reasons it would be inert anyway:

1. **The mode cannot be turned on.** Migration 2091, which seeds `DISCOVERY_ENGINE_MODE`, is
   unapplied in CI *and* production, and `metadata.mode` — the field D2=A makes load-bearing —
   has **no write path**: `PATCH /admin/feature-flags/:flag` accepts only `{ enabled }`
   (`admin.ts:654`) and the RPC behind it takes no metadata parameter. The three-valued switch
   cannot be moved off `legacy` through any supported surface.
2. **It could not be validated.** Divergence and engagement both need traffic.

**A modelling trap to record before anyone does build it.** `RANKED_POINTS`
(`discoveryServePointReport.ts:101-104`) is the static set `{5, 6}` and is documented as "serve
points on which a ranker ran during the request itself". Under pde, serve points 1–3 *would*
rank, and that set silently becomes wrong. Whoever wires the pde branch must derive
"was this ranked" from `engineMode`, not from the serve point, or the first ranked cache hit
will be reported as unranked.

### Recommended order when this resumes

1. ~~Apply **2091**~~ — **done 2026-08-28.** Both switches now exist, seeded inert, in CI *and*
   production: `DISCOVERY_ENGINE_MODE` (enabled=false, `mode=legacy`) and
   `disable_discovery_pde` (enabled=false). Serving behaviour is unchanged by construction —
   before, the mode resolved to `legacy` via `flag_absent`; now via `flag_disabled`.
2. ~~Give `metadata.mode` a write path with audit~~ — **done 2026-08-28**, migration **2198** and
   `PATCH /admin/feature-flags/:flag/metadata`. The switch now has a handle. Note the endpoint
   **replaces** the metadata document rather than merging, and **refuses** an unrecognised mode
   rather than storing it: the resolver is fail-closed, so a stored typo would return 200 and
   then silently serve `legacy`, which is the worst possible feedback during a rollout.
3. Get **traffic**. Everything from Stage 0 onward is blocked on it.
4. Only then re-run this report; if points 1–6 are still starved, D5=B is justified on evidence
   rather than on the packet's estimate.

Steps 1 and 2 were the parts that could be finished without users. Step 3 is not an engineering
task, and step 4 cannot begin until it is done.
