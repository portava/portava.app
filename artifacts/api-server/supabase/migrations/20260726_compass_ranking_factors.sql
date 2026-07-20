-- Phase 7 — Formal Recommendation Engine
-- Stores the grounded ranking snapshot ({ compassMatch, communityScore, factors })
-- alongside each served recommendation so /compass/why can return a
-- factor-grounded explanation tied to the actual delivery event.

ALTER TABLE compass_served_recommendations
  ADD COLUMN IF NOT EXISTS ranking_factors JSONB;
