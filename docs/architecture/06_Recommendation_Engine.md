# Recommendation Engine — current state

*Derived from the repository, 2026-09-04. Defers to `docs/discovery/ROADMAP.md` for what may be
enabled.*

The ranker is `portavaRank` (`lib/portavaRank.ts`). The roadmap direction (step 7) is **taste as
the spine, everything else a modifier**; step 8 is a budgeted **exploration governor** with
reason codes. Unit D3 built the modifier and governor machinery **behind one flag seeded OFF**,
because the ranker is on explicit owner **HOLD** — the contracts exist and are tested, but
nothing is enabled.

## The scoring model (real features, not a partly-constant vector)

`scoreCandidate` sums a weighted feature vector (`DEFAULT_WEIGHTS`). The 2026-08-10 review's
"partly-constant feature vector" no longer describes it — the live features include:

- **Taste:** `interestTag` (0.3), `categoryAffinity` (0.4), `cityMatch` (0.45),
  `neighborhoodMatch` (0.2).
- **Actionability (the Portava edge):** `actionability` (0.9) from time-to-start kernels and
  availability fit — "things you can DO" beat viral posts from nowhere.
- **Quality / abuse resistance:** `trust`, `socialProof` (0.25, log-scaled and dampened for
  unknown authors), `verifiedBonus` (0.15), `recency`.
- **Per-kind priors**, `capacityOpen`, and a `seenPenalty` (−0.6) that pushes down already-seen
  items.
- A **place-affinity boost** (×1.15) applied when the viewer has ≥ 2 `place_view` events for a
  candidate's place.

Diversity and exploration are deterministic within an hour (seeded per viewer+hour) so a
paginating session sees a stable page.

## The unit-D3 modifiers (flag `discovery_ranking_modifiers_enabled`, seeded OFF — migration 2289)

Assembled per request by `lib/discoveryModifiers.ts`. With the flag **off** it performs one
cached flag read and returns an inert record — no momentum map, no city-confidence read, the
default budget — and `portavaRank` scores exactly as before. Every input it can hand the ranker
is **bounded by a code constant, not a config value**:

1. **Capped `local_momentum`** — a place velocity signal (`03`) entering the vector as feature
   `localMomentum`, weight `LOCAL_MOMENTUM_MAX_CONTRIBUTION = 0.15`, clamped **after** the weight
   so no weight table can exceed the cap. Below every taste signal by construction: momentum is a
   tie-breaker, never a driver. The `portavaRank` cap test pins the constant.
2. **City-confidence scaling** — `momentumScale ∈ [0.5, 1.0]` and `explorationBudgetPct ∈
   [15, 25]` derived monotonically from the world-model depth score (`05`), defaulting to the
   thin end when absent.

## The exploration governor (step 8) — `FeedSlotAllocator.allocateExplorationBudget`

A budgeted allocator, not fixed positions:

- **Budget** a share of the page clamped to `[15, 25] %` (`clampGovernorBudget`); the pool is the
  bottom third of the ranked list (`GOVERNOR_POOL_START_SHARE`); nothing is added or dropped, so
  the result is a permutation the shadow/divergence comparison can still read.
- **Reason codes** per pick, each a statement of *absence* — what the system expects to learn:
  `unfamiliar_category` (affinity < 0.25), `low_social_proof` (no saves), `rising_momentum`
  (momentum ≥ 0.5 the taste model has not caught up to), `long_tail` (none of the above; the
  budget simply had a slot). This replaces `portavaRank`'s fixed every-7th exploration slot on
  this surface — a fixed slot leaves no record of *why* an item was surfaced.
- **Observe vs apply:** with the flag off the governor runs in `apply=false` — it computes the
  full allocation and reason counts, records them in the impression feature vector
  (`lib/discoveryPde.ts`), and returns the **input order unchanged**. So the allocation is
  observable in `rank_events` **before** it is ever applied — analytics visible either way.

## What is NOT built / NOT enabled

- **Nothing above is enabled.** The flag is OFF; enabling it is an owner decision (ranker HOLD).
- **No learned residual (step 9).** It requires trustworthy outcomes, which require Event Truth
  and traffic — neither exists (`04`).
- **DRS constants / `creatorId` activation** stay **HELD** (Blocker 4,
  `docs/fact-layer-20260810/DECISIONS.md`); unit D3 did not touch them.
