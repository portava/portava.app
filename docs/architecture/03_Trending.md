# Trending — current state

*Derived from the repository, 2026-09-04.*

## Ruling: Trending as a peer scoring system is STALE

The original `03` proposed a trend engine with its own lifecycle, velocity computation and
personalization, ranked as a peer. The 2026-08-15 redirect marks peer scoring systems **STALE**,
and ROADMAP **step 7** admits velocity only as a **capped modifier** to the taste-spine ranker.
The 2026-08-10 review also found the proposed normaliser divided by an exposure denominator that
actually counted conversions — a defect there is now no standalone engine to carry.

**So there is no trend engine.** The one velocity signal that ships is a bounded ranker modifier.

## What ships instead: capped `local_momentum`

`lib/discoveryLocalMomentum.ts` computes a **place-level 48-hour velocity** relative to the
place's *own* 30-day baseline — not popularity and not virality:

- **Source:** `rank_events` rows with `surface = 'discovery'`. A row carries the impression at
  `served_at` and, if it converted, an outcome at `outcome_at`; both are counted at their own
  time. `outcome = 'analytics'` rows are excluded (they are per-candidate ranker bookkeeping).
- **Arithmetic:** weighted activity (impression 1 · save 3 · other outcome 2), `recent` = Σ over
  the last 48 h, `baseline48h` = prior-28-day Σ ÷ 14, `velocity =
  (recent − baseline48h) / (baseline48h + smoothing)`, `momentum = clamp(velocity / saturation,
  0, 1)`. A floor (`MOMENTUM_MIN_RECENT_WEIGHT`) makes three impressions **not** a surge.
- **Honest limits, stated not hidden:** `rank_events.user_id` is `NOT NULL`, so momentum is a
  property of **authenticated** activity only; a place with no rows has momentum **0** ("no
  evidence of a surge", never "evidence of decline") — the signal is strictly non-negative.
- **Cached** per candidate-set key (`destination:category`) with a short TTL and a bounded map,
  because it is user-independent and, under D5=B, would otherwise pay a 30-day scan per request.

## Why it stays a modifier: the cap

Its contribution to `portavaRank` is hard-capped at `LOCAL_MOMENTUM_MAX_CONTRIBUTION = 0.15`,
applied **after** the weight so no admin weight override can lift it past the cap. 0.15 is below
every taste signal (`categoryAffinity 0.4`, `interestTag 0.3`, `cityMatch 0.45`,
`actionability 0.9`) and equal to the smallest positive one (`verifiedBonus`). A fully saturated
momentum can therefore **break a tie** between two places the viewer rates alike, and **cannot**
lift a place over one the viewer's taste prefers by even a single interest tag. That numeric
boundary is what makes momentum admissible while the ranker is on HOLD — a modifier that cannot
dominate cannot turn the evidence system into a trending feed.

Thin cities damp it further: `lib/discoveryModifiers.ts` scales momentum by
`momentumScale ∈ [0.5, 1.0]` from the world-model **city confidence**, because velocity computed
over little data is mostly noise. Everything is gated by `discovery_ranking_modifiers_enabled`
(migration `2289`), **seeded OFF** — with the flag off no momentum is read and the ranker is
unchanged.
