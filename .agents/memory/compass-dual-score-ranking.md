---
name: Compass dual-score ranking invariants
description: Invariants for Compass Match vs Community Score and factor-grounded "Why this?" explanations
---

# Rules
- **Compass Match** (personal fit) must contain ZERO popularity inputs; **Community Score** (popularity) must contain ZERO viewer inputs. Tests assert independence in both directions — adding a shared signal to either breaks them.
- "Why this?" text may only be built from stored `RankingFactor[]` (grounded in actual signals). Sensitive keys (via `isSensitiveKey` / factor keys like risk/report/spam) must never surface.
- The served-recommendation row stores the `{compassMatch, communityScore, factors}` snapshot at delivery time (`ranking_factors` JSONB); /compass/why reads that snapshot — never recompute or let the model generate the reason.
- Chat search tools rank via `runPipeline` and must fall back to the raw DB list when ranking fails — never return empty because the ranker errored, and never let the model reorder or invent scores.
- Memory-derived preference boost on finalScore is bounded (≤5 points) so remembered preferences nudge, not dominate.

**Why:** keeps the two surfaced signals honest and independent, and guarantees recommendations are provably pipeline-sourced.
**How to apply:** any change to Compass scoring, tool search, or the why route — run compass-recommendation-engine, compass-tools, and compass-hardening tests.
