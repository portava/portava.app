-- 2265: purpose-limited ExperienceSession and explicit outcome/memory boundary.
-- These tables contain recommendation lifecycle records, never raw sensing,
-- movement history, anonymous contributors, or social presence.
CREATE TABLE IF NOT EXISTS public.experience_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL,
  item_id text NOT NULL,
  item_type text NOT NULL,
  purpose text NOT NULL DEFAULT 'recommendation'
    CHECK (purpose IN ('recommendation','world_moment','forecast')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','abandoned','expired')),
  projection_version text NOT NULL DEFAULT 'experience-session-v1',
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, recommendation_id)
);
CREATE INDEX IF NOT EXISTS experience_sessions_user_idx ON public.experience_sessions(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.experience_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.experience_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL, item_id text NOT NULL, item_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('went','stayed','liked','invited','made_memory','returned')),
  significance text NOT NULL DEFAULT 'routine' CHECK (significance IN ('routine','significant')),
  memory_eligible boolean NOT NULL DEFAULT false,
  calibration_version text NOT NULL DEFAULT 'calibration-v1',
  projection_version text NOT NULL DEFAULT 'experience-session-v1',
  occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, outcome),
  CONSTRAINT experience_outcomes_memory_gate CHECK (NOT memory_eligible OR significance = 'significant')
);
CREATE INDEX IF NOT EXISTS experience_outcomes_user_time_idx ON public.experience_outcomes(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS experience_outcomes_memory_idx ON public.experience_outcomes(user_id, memory_eligible, occurred_at DESC);
ALTER TABLE public.experience_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experience_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users read own experience sessions" ON public.experience_sessions;
CREATE POLICY "users read own experience sessions" ON public.experience_sessions FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "users read own experience outcomes" ON public.experience_outcomes;
CREATE POLICY "users read own experience outcomes" ON public.experience_outcomes FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "service writes experience sessions" ON public.experience_sessions;
CREATE POLICY "service writes experience sessions" ON public.experience_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service writes experience outcomes" ON public.experience_outcomes;
CREATE POLICY "service writes experience outcomes" ON public.experience_outcomes FOR ALL TO service_role USING (true) WITH CHECK (true);