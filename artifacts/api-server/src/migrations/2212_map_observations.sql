-- 2212_map_observations.sql
--
-- Map Contributions (Map spec §22) — the FLAG, and nothing else.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY THIS MIGRATION CREATES NO TABLE
-- ===================================
-- §22 calls the map "a low-friction capture surface" whose contributions are
-- "observations, not immediate truth". An observation store that already
-- satisfies exactly that already exists: `public.intel_observations`, created by
-- 2130_intel_storage.sql, which brings with it
--
--   • append-only triggers (no UPDATE, no DELETE — a correction is a NEW row);
--   • RLS enabled, with INSERT/SELECT granted to service_role only;
--   • the UNIQUE (actor_id, idempotency_key) index the ingest dedupes on;
--   • subject_id FK → public.places, so an unknown subject is a clean refusal;
--   • the D4 consent join partner `intel_contribution_consent` (2172) and the
--     enforced 180-day retention sweep (2173) that already covers these rows;
--   • the group_key / party_size_bucket columns the k-anonymity gate counts.
--
-- A `map_observations` table would have to reproduce every one of those, and the
-- first one to drift would be consent — the only one whose absence is invisible
-- from the outside. Worse, a parallel table would be invisible to
-- lib/intelProjectionAggregator.ts, so a map contribution would never become a
-- map change: the §22 pipeline would terminate at storage. Reuse is not the
-- cheap option here, it is the only one that connects.
--
-- WHAT THE ROUTE STORES, AND WHERE
-- ================================
-- routes/mapObservations.ts is a façade over
-- services/intel/IntelCaptureService.writeObservation, with
-- capture_surface = 'quick_signal' — a §22 map prompt IS a quick signal: one
-- contextual question, one enumerated answer, mapped server-side to a canonical
-- claim type. The CHECK on intel_observations.capture_surface is deliberately
-- NOT widened with a 'map' value: adding an enum member that no writer emits is
-- dead schema, and the surface that a contribution came from is already
-- observable through the §35 `contribution_submitted` telemetry event
-- (2202_map_telemetry.sql) without weakening a constraint.
--
-- WHAT IS DELIBERATELY ABSENT
-- ===========================
-- No claim table, no confidence column, no snapshot, and no reward linkage.
--   • A claim is created by the claim system, and a live value is written by
--     lib/intelProjection.ts, which is the SOLE writer of intel_state_snapshot.
--     §22's pipeline ends at "Map changes" precisely because everything between
--     Observation and Projection is allowed to refuse.
--   • §22/§37: "Rewards may incentivize participation but must never increase
--     factual confidence merely because the contribution was paid." There is
--     therefore NO column, foreign key or view joining `intel_reward_ledger` to
--     `intel_observations` — not in this migration and not anywhere. The
--     evidence path reads actor_id, presence_level, source_class, group_key,
--     observed_at and moderation_state; the reward ledger is not reachable from
--     any of them. That absence IS the guarantee, and adding a join later would
--     be the moment the guarantee is lost.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags must exist.';
  END IF;
  -- The ingest has nowhere to write without this. Fail loudly at deploy time
  -- rather than at the first contribution.
  IF to_regclass('public.intel_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_observations (2130_intel_storage.sql) must exist — map contributions are stored there, not in a table of their own.';
  END IF;
  -- Capture is refused without valid consent; if the consent table is absent the
  -- gate cannot be evaluated and the route would be permanently fail-closed.
  IF to_regclass('public.intel_contribution_consent') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_contribution_consent (2172) must exist — it is the D4 lawful-basis gate for every capture surface.';
  END IF;
END $$;

-- ── Flag ──────────────────────────────────────────────────────────────────────
--
-- OFF by default. With it off the route answers { ok: true, accepted: 0,
-- enabled: false } and stores nothing.
--
-- NOTE THE SECOND GATE. This flag opens the MAP door only. The capture itself
-- still runs behind `intel_capture_quick_signal` inside IntelCaptureService, so
-- switching this on does not switch capture on: a map contribution cannot reach
-- storage by a route the intel capture gate has not opened.

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('map_contributions_enabled', FALSE,
   'Map Contributions ingest (spec §22): POST /api/map/observations records a map prompt answer as an intel_observations row via IntelCaptureService. Contributions are observations, never live truth; rewards never affect confidence. Capture ALSO requires intel_capture_quick_signal.')
ON CONFLICT (flag) DO NOTHING;

COMMENT ON COLUMN public.intel_observations.capture_surface IS
  'Which capture surface produced this observation. Map Contributions (spec §22, routes/mapObservations.ts) arrive as ''quick_signal'': a map prompt is one contextual question with one enumerated answer, mapped server-side to a canonical claim type, and is subject to the identical consent, presence, group and validation gates as any other quick signal.';

COMMIT;
