-- 2090_discovery_serve_log_flag.sql
-- Seed the P1 Stage 0 discovery serve-point instrumentation flag, DISABLED.
--
-- WHAT THE FLAG GATES
-- ===================
-- `lib/discoveryServeLog.ts` writes one `rank_events` impression row per served
-- item, at every one of the nine discovery serve points. Before Stage 0 only ONE
-- of them wrote anything (routes/discovery.ts:1433, the cold-fetch legacy-rank
-- path), and the live corpus shows the consequence: `surface='discovery'` holds
-- ZERO rows, against 179 775 pulse / 12 556 compass / 5 200 events.
-- See docs/algorithm/discovery-impression-gap.md.
--
-- WHY IT IS SEEDED FALSE
-- ======================
-- This migration must be behaviour-preserving at introduction. Seeding `false`
-- writes a row that changes nothing: `isFlagEnabled` already returns false for a
-- MISSING row, so before and after this migration the instrumentation is equally
-- inert. What the row adds is that the switch now EXISTS, is visible in the
-- admin flag list, and is recorded in the repository rather than being created
-- by hand in production later — which is precisely the drift
-- docs/ops/flag-disposition.md was written to stop.
--
-- ENABLING IT — a separate, deliberate, reversible step
-- ====================================================
--   UPDATE feature_flags SET enabled = true WHERE flag = 'discovery_serve_log_enabled';
--
-- ⚠ What enabling does, stated plainly:
--
--   1. It STARTS PRODUCTION WRITES. One `rank_events` row per served item per
--      authenticated discovery request, across nine serve points. Volume rises
--      by roughly the cache-hit multiplier — the whole point, since those serves
--      are currently invisible, but it is not a small number.
--
--   2. It BREAKS THE adminRankingMetrics SERIES for surface='discovery', on the
--      day it is switched on. That surface goes from empty to populated. No
--      back-fill is possible. Operator ruling D8=A accepted this explicitly, on
--      the grounds that a series describing one unrepresentative serve point is
--      worth less than the blindness it preserves. The cutover date must be
--      recorded where metrics are read; a dated block already sits at the top of
--      routes/adminRankingMetrics.ts.
--
--   3. It makes engagement measurable on cache-served traffic for the first
--      time, because outcomes attach to impression rows
--      (routes/rankEvents.ts:132).
--
-- Reversal is `SET enabled = false`. Rows already written stay; they are
-- distinguishable by `features.servePoint`.
--
-- WHAT IT DOES NOT DO
-- ===================
-- No ranker, boost, cap, allocator or affinity signal reads impression rows, so
-- enabling this CANNOT change what any ranker produces or what any user is
-- served. Verified reader by reader in
-- docs/algorithm/discovery-impression-gap.md § "Blast radius — verified, not
-- assumed". It also cannot record anonymous traffic at all: `rank_events.user_id`
-- is NOT NULL (0153_add_rank_events.sql), so every figure it produces is a share
-- of AUTHENTICATED serves.
--
-- Polarity: read through `isFlagEnabled` (lib/featureFlags.ts:14), which returns
-- false on any error. A database problem therefore silences instrumentation
-- rather than enabling it — the safe direction for a capability flag, and the
-- reason this is NOT a kill switch and must not be read as one.

INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  ('discovery_serve_log_enabled', false,
   'P1 Stage 0: write a rank_events impression row at every discovery serve point, including the cached and unranked ones. Establishes the baseline for DISCOVERY_ENGINE_MODE. Enabling starts production writes and breaks the adminRankingMetrics discovery series at the cutover date.',
   '{"rollout":"p1-discovery-stage-0","ruling":"D8=A","starts_writes_when_enabled":true,"breaks_metric_series":"surface=discovery"}')
ON CONFLICT (flag) DO UPDATE SET
  description = EXCLUDED.description,
  metadata    = EXCLUDED.metadata;
