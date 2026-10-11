-- 3690 — Input Intelligence: two capability flags, both seeded OFF.
-- Census-input-intelligence G46 (§7 `structured_value`) and G229 (§35
-- "previously successful query completions").
--
-- ── input_structured_values_enabled ────────────────────────────────────────────
-- When ON, the event title field is offered the date, time window, length and
-- party size its own text names ("Rooftop drinks Fri 8-11pm for 6 people"),
-- parsed with fixed rules (lib/inputAssistance/structuredValues.ts — no model,
-- no provider, nothing stored). The create screen applies a value only when the
-- person taps it. OFF / absent: no structured value is served.
--
-- ── input_previous_queries_enabled ────────────────────────────────────────────
-- When ON, the search field offers back the person's OWN earlier successful
-- searches that start with what they are typing, read owner-scoped from the
-- search_history they already own and erase through
-- DELETE /api/me/search-history (lib/inputAssistance/previousQueries.ts). No new
-- store; a query carrying an email, a long digit run or a coordinate pair is
-- never shown back. OFF / absent: the history is not read.
--
-- Additive only: two rows in feature_flags, nothing else. Rollback:
-- db/rollback/2026-10-10-3690-input-structured-values-and-previous-queries-flags-rollback.sql.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3690): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'input_structured_values_enabled',
    false,
    'Input Intelligence §7 structured values (census G46): the event title field is offered the date, time window, length and party size its own text names, parsed with fixed rules (no model); the create screen applies one only on a tap. OFF / absent (the seed): none is served.'
  ),
  (
    'input_previous_queries_enabled',
    false,
    'Input Intelligence §35 previous successful searches (census G229): the search field offers back the viewer''s own earlier successful searches that start with what they type, read owner-scoped from their search_history (which they erase via DELETE /api/me/search-history). OFF / absent (the seed): the history is not read.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_structured_values_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3690): input_structured_values_enabled absent.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_previous_queries_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3690): input_previous_queries_enabled absent.';
  END IF;
END $post$;
