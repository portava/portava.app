-- 3469_compass_graph_decay_flag.sql
-- The graph-decay capability flag, seeded OFF (census-discovery DV-51, §56.9
-- Q6, §81; register D-W10S2-10).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-S2,
-- 3465-3469). APPLIED TO NO SHARED DATABASE; rehearsed on the local
-- PostgreSQL 16 harness only.
--
-- ── WHAT IT GATES ───────────────────────────────────────────────────────────
-- `compass_graph_decay_enabled` — compass/CompassGraphEngine.ts
-- `readGraphDecayPolicy`. ON: the scheduled rebuild writes each edge's derived
-- strength (frequency, diversity, recency, and a half-life set by whether its
-- support is a confirmed experience) as `weight` instead of its count, does
-- not re-create an edge below 1/8, and the support reconcile retires a stored
-- edge whose COMPLETE, anchored support is below 1/8 and rewrites the others'
-- weights. OFF / absent / unreadable (the seed): `weight = observed_count`
-- and the reconcile only retires unsupported edges — byte-identical to §67.
-- No column is added: `weight` (numeric) already exists beside
-- `observed_count`, and no reader in the tree reads `weight`.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
--
-- Rollback: db/rollback/2026-09-28-3469-compass-graph-decay-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3469): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'compass_graph_decay_enabled',
    false,
    'Graph decay (census-discovery DV-51, §81, D-W10S2-10): the rebuild writes each edge''s derived strength (log2(1+days) + ½·log2(count/days), halved every 365 days for a confirmed experience or 14 for an intent signal; structural edges not decayed) and retires an edge below 1/8 judged on its complete anchored support. OFF / absent (the seed): weight = observed_count. Turning it ON in production is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'compass_graph_decay_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3469): compass_graph_decay_enabled absent.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'compass_graph_decay_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3469): compass_graph_decay_enabled is ON — it must ship OFF';
  END IF;
END $post$;
