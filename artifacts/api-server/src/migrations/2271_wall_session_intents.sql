-- 2271_wall_session_intents.sql
-- Portava Wall — temporary typed session-intent store (spec §17 / TABLE 3).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Wall band 2271.
--
-- Additive + idempotent. Safe to re-run. One row per user holds their CURRENT,
-- session-scoped Wall intent — a temporary typed steer for For You that does NOT
-- change any saved preference (spec §17). POST /wall/session-intent upserts it,
-- DELETE /wall/session-intent removes it, and GET /wall reads it (a per-request
-- `session_intent` query param overrides it without persisting). "Temporary
-- typed Wall intent" is Wall-owned state (spec TABLE 3), which is why it lives
-- here and not in the Global Input Intelligence layer that PARSED it.
--
-- The stored value is the STRUCTURED intent (canonical filters + residual
-- keywords), never a full transcript of raw typed text beyond the short echo the
-- client needs — consistent with the analytics rule "do not log unnecessary raw
-- typed content" (spec §32). This is not a preference table and never feeds
-- long-term personalization.
--
-- RUNTIME EFFECT: NONE until wall_enabled AND wall_input_intelligence_enabled are
-- pressed. No client grant: the service role reads/writes on the caller's behalf
-- through the route (server-side eligibility is authoritative, spec §37).

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
END $$;

-- ── Table: one current intent per user ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wall_session_intents (
  user_id           uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Structured intent: { filters:[{kind,entityId,label,value}], keywords:[...],
  -- sessionScoped:true, createdAt }. Canonical filters, not raw strings (§17).
  structured_intent jsonb NOT NULL,
  -- Short echo of what the user typed, for the client to show ("Steering: ...").
  -- Capped by the route; never a full private transcript (§32).
  raw_text          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── RLS + grants (deny-default; service role only) ───────────────────────────
-- Internal only: the route authenticates the caller and the service role
-- reads/writes their single row. No anon/authenticated policy — this is not a
-- client-writable table.
ALTER TABLE public.wall_session_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wall_session_intents FROM PUBLIC;
REVOKE ALL ON public.wall_session_intents FROM anon;
REVOKE ALL ON public.wall_session_intents FROM authenticated;
REVOKE ALL ON public.wall_session_intents FROM service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.wall_session_intents TO service_role;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.wall_session_intents') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: wall_session_intents not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.wall_session_intents'::regclass AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on wall_session_intents';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.wall_session_intents;
