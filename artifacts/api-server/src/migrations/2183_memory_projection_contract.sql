-- 2183_memory_projection_contract.sql
--
-- Memory + Experience Intelligence Architecture — the projection CONTRACT.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS IS, AND WHY IT IS ADDITIVE ONLY
-- -----------------------------------------
-- The memory spec (owner's "Memory + Experience Intelligence Architecture") is
-- AUDIT-FIRST: §3/§22 require inventorying existing signals and PROJECTING
-- canonical facts, never duplicating them, and §24 forbids a second source of
-- truth. The 2026-08-28 audit found the architecture already largely exists
-- under "Compass" (populated Experience Graph = compass_graph_nodes/edges, the
-- governance layer, canonical facts). What it lacked was the unifying L2/L3
-- contract the spec calls memory_event (§4 Activity/Event Ledger) and
-- memory_item (§4 Memory Projection, §15).
--
-- This migration adds ONLY that contract — three new tables in `public`, RLS
-- deny-default, service_role-only, gated behind a flag seeded OFF. It CHANGES
-- NOTHING that exists: no column is added to a live table, no policy is
-- rewritten, nothing is dropped. Until a projector writes to these tables (a
-- later slice, born gated by the `memory_projection` flag) they are inert.
--
-- NAME COLLISION, RESOLVED (audit finding #4)
-- -------------------------------------------
-- The spec's derived `memory_item` name is NOT usable: `public.memory_items`
-- already exists as the media-slide table of the user-facing "Memories"
-- scrapbook (memory_id, media_url, caption, position). Reusing that name would
-- collide two unrelated concepts. The derived projection is therefore
-- `memory_projections`; the append ledger is `memory_events`; the unified
-- feedback signal is `memory_feedback`. `memory_items` is left untouched.
--
-- CONTRACT ↔ SPEC MAP
-- -------------------
--   memory_events      ← §15 memory_event   (append-oriented action ledger, §4 L2)
--   memory_projections ← §15 memory_item     (derived user memory, §4 L3, §5 taxonomy)
--   memory_feedback    ← §15 memory_feedback  (hide/forget/incorrect/not_interested/
--                                              already_known — the single signal the
--                                              audit found missing for New-to-Me §7)
--   experience_edge (§15) is NOT created here — it already exists and is
--   populated as compass_graph_edges (974 rows). This contract references the
--   graph; it does not restate it (§24).
--
-- APPEND-ONLY, PROVENANCE, RETENTION, VISIBILITY — all first-class, because the
-- spec makes them first-class (§16 provenance/confidence, §17 forget, §18
-- retention classes, §19 "projections inherit or narrow source visibility,
-- never broaden it").

BEGIN;

-- ── Preconditions — reuse existing canonical machinery, do not duplicate it ──
DO $$
BEGIN
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.set_updated_at() missing — expected from 0001_spine.sql.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags missing.';
  END IF;
END $$;

-- ── L2 · memory_events — the append-oriented action ledger (§4, §15) ─────────
-- One row per meaningful action, projected from canonical facts. Append-only:
-- corrections are new rows; a mistaken event is superseded, never rewritten.
CREATE TABLE IF NOT EXISTS public.memory_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL,
  event_type    TEXT        NOT NULL,          -- visited | saved_place | attended_event | asked_compass | contributed_observation | created_moment | ...
  occurred_at   TIMESTAMPTZ NOT NULL,          -- when the ACTION happened (not when projected)
  subject_type  TEXT,                          -- place | city | country | event | trip | post | venue | user | interest
  subject_id    TEXT,                          -- text, not uuid: the Experience Graph keys places/cities by name too
  -- §16 provenance source class: explicit user action | verified system fact | inferred behaviour | third-party/live
  source        TEXT        NOT NULL CHECK (source IN ('explicit','system','inferred','live')),
  -- §19: an event's visibility is the visibility of its canonical source; a projection may narrow it, never broaden.
  visibility    TEXT        NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','circle','public')),
  source_ref    JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { table, id } of the canonical row this projects from
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_events_user_time_idx
  ON public.memory_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_subject_idx
  ON public.memory_events (subject_type, subject_id);
-- Idempotent projection support: a given canonical row projects to at most one
-- event of a type. The projector upserts on this key (ON CONFLICT DO NOTHING),
-- so replay/backfill (§22 step 4) is deterministic and cannot double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS memory_events_dedupe_idx
  ON public.memory_events (user_id, event_type, subject_type, subject_id, occurred_at);

-- ── L3 · memory_projections — the derived, durable/expiring memory (§4, §5, §15)
-- MUTABLE by design (unlike the ledger): re-projection UPSERTS the current best
-- understanding of a fact. One row per (user, memory_type, subject).
CREATE TABLE IF NOT EXISTS public.memory_projections (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL,
  -- §5 taxonomy: Episodic | Semantic-preference | Social | Place | Intent
  memory_type      TEXT        NOT NULL CHECK (memory_type IN ('episodic','semantic','social','place','intent')),
  subject_type     TEXT,
  subject_id       TEXT,
  content          TEXT        NOT NULL,       -- human-readable: "visited Bangkok", "prefers walkable areas"
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to         TIMESTAMPTZ,               -- NULL = durable; set = expiring (intent decays aggressively, §9)
  confidence       REAL        NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  -- §16 provenance: which source event(s) produced this, and how it was derived.
  provenance       JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- { source_event_ids: [...], derivation: '...' }
  -- §19: sensitive location / social co-presence get stricter access + shorter retention.
  sensitivity      TEXT        NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive')),
  -- §17 user control: forget / hide without deleting the audit of why.
  state            TEXT        NOT NULL DEFAULT 'active' CHECK (state IN ('active','decayed','hidden','forgotten')),
  -- §18 retention classes — a projection is governed by the class of what it holds.
  retention_class  TEXT        NOT NULL DEFAULT 'derived_preference'
                     CHECK (retention_class IN ('ephemeral','short_lived','trip_context','durable_fact','derived_preference','historical_contribution')),
  last_supported_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- §16 "when was it last supported"
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent projection: re-running the projector updates the same row.
  CONSTRAINT memory_projections_unique UNIQUE (user_id, memory_type, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS memory_projections_user_type_state_idx
  ON public.memory_projections (user_id, memory_type, state);
CREATE INDEX IF NOT EXISTS memory_projections_subject_idx
  ON public.memory_projections (subject_type, subject_id);
-- Expiry sweeps read only the expiring rows.
CREATE INDEX IF NOT EXISTS memory_projections_expiry_idx
  ON public.memory_projections (valid_to)
  WHERE valid_to IS NOT NULL;

-- ── C5 · memory_feedback — the unified user-control signal (§15, §17) ─────────
-- The audit found feedback scattered across compass_feedback / discovery_place_reports
-- with no single `already_known` signal for New-to-Me (§7). This is that signal,
-- keyed to either a projection or an arbitrary recommended subject.
CREATE TABLE IF NOT EXISTS public.memory_feedback (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL,
  projection_id  UUID        REFERENCES public.memory_projections(id) ON DELETE CASCADE,
  subject_type   TEXT,       -- for feedback on a recommended subject that has no projection yet
  subject_id     TEXT,
  kind           TEXT        NOT NULL CHECK (kind IN ('hide','forget','incorrect','not_interested','already_known')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one standing signal of a kind per (user, projection|subject); re-sending updates the timestamp
  CONSTRAINT memory_feedback_target CHECK (projection_id IS NOT NULL OR subject_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS memory_feedback_user_kind_idx
  ON public.memory_feedback (user_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS memory_feedback_dedupe_idx
  ON public.memory_feedback (user_id, kind, coalesce(projection_id::text,''), coalesce(subject_type,''), coalesce(subject_id,''));

-- ── Triggers ─────────────────────────────────────────────────────────────────
-- memory_events is append-oriented: corrections are new rows, so UPDATE is
-- forbidden. But it must stay DELETABLE — account deletion cascades to it (2187)
-- and the retention sweep deletes expired rows. So it uses a memory-specific
-- guard that blocks ONLY update, NOT the shared intel_append_only() (which also
-- blocks delete unless an intel erasure flag is set — that would break the
-- deletion cascade auth.admin.deleteUser triggers).
CREATE OR REPLACE FUNCTION public.memory_events_no_update()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_events is append-only: UPDATE is not permitted. Corrections are new rows.';
END
$fn$;
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every NEW public function
-- to anon AND authenticated. That applies to trigger functions too, which is easy
-- to forget because they are never called by name. Impact here is small (the body
-- only RAISEs, so a direct anon call just errors) but the grant contradicts this
-- migration's own least-privilege stance, and a trigger function is still a
-- PostgREST-reachable RPC. Revoke it like any other.
--
-- Found 2026-08-28 while replaying these migrations onto production: CI had this
-- revoked by an ad-hoc fix that NO migration performed, so a clean replay produced
-- a different — and wrong — state. The revoke belongs here, at the point of
-- creation, or it does not really exist.
REVOKE ALL ON FUNCTION public.memory_events_no_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_memory_events_no_update ON public.memory_events;
CREATE TRIGGER trg_memory_events_no_update
  BEFORE UPDATE ON public.memory_events
  FOR EACH ROW EXECUTE FUNCTION public.memory_events_no_update();

-- memory_projections is mutable; keep updated_at honest via the shared trigger (0001).
DROP TRIGGER IF EXISTS trg_memory_projections_updated ON public.memory_projections;
CREATE TRIGGER trg_memory_projections_updated
  BEFORE UPDATE ON public.memory_projections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Authorization — least privilege (§19) ────────────────────────────────────
-- Derived internal projections, read by the API's service-role client exactly
-- like the intel_* tables.
--
-- ACCURACY NOTE (corrected 2026-08-28 after an audit): Supabase's ALTER DEFAULT
-- PRIVILEGES grants table-level privileges on NEW public tables to anon and
-- authenticated automatically, so these tables DO carry those default grants.
-- An earlier version of this comment claimed "no anon/authenticated grant",
-- which was false. What actually protects the data is RLS: it is enabled below
-- with ZERO policies, so every anon/authenticated read through PostgREST is
-- deny-default regardless of the grant. service_role bypasses RLS and holds the
-- explicit grants below. The grants are therefore inert, not absent — and the
-- distinction matters, because a future policy added to these tables would
-- immediately become reachable by those roles.
ALTER TABLE public.memory_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_feedback    ENABLE ROW LEVEL SECURITY;

-- memory_events: append + read + erasure-delete (no UPDATE — the trigger forbids it anyway).
GRANT INSERT, SELECT, DELETE ON public.memory_events      TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.memory_projections TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.memory_feedback    TO service_role;

-- ── Rollout gate (§22 step 7) ────────────────────────────────────────────────
-- Seeded OFF. The projector/retrieval slices read this; off ⇒ they are inert.
-- The CONTRACT (these tables) is safe to ship enabled — it is the WRITERS that
-- this gates.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'memory_projection',
    false,
    'Gates the memory projection pipeline (projector + retrieval over public.memory_events / memory_projections). Off = projector writes nothing and retrieval returns empty. The contract tables exist regardless; this gates the writers/readers, per the memory spec §22 rollout control.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Documentation ────────────────────────────────────────────────────────────
COMMENT ON TABLE public.memory_events IS
  'Memory spec §4/§15 memory_event: append-only ledger of meaningful user actions, projected from canonical facts. Corrections are new rows.';
COMMENT ON TABLE public.memory_projections IS
  'Memory spec §4/§5/§15 memory_item (renamed to avoid the memory_items scrapbook collision): derived, durable/expiring per-user memory. Mutable; re-projection upserts on (user_id, memory_type, subject_type, subject_id).';
COMMENT ON TABLE public.memory_feedback IS
  'Memory spec §15/§17 memory_feedback: unified hide/forget/incorrect/not_interested/already_known signal. already_known drives New-to-Me (§7).';
COMMENT ON COLUMN public.memory_projections.valid_to IS
  'NULL = durable memory. A timestamp = expiring; intent memories (memory_type=intent) decay aggressively per §9. Swept by retention_class per §18.';

-- ── Postcondition — prove the migration did what it claims ────────────────────
DO $$
BEGIN
  IF to_regclass('public.memory_events') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_events not created';
  END IF;
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_projections not created';
  END IF;
  IF to_regclass('public.memory_feedback') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_feedback not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_memory_events_no_update' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: append-only(UPDATE) trigger missing on memory_events';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='memory_projections' AND rowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on memory_projections';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_projection') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_projection flag not seeded';
  END IF;
  IF has_function_privilege('anon', 'public.memory_events_no_update()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_events_no_update()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_events_no_update() is executable by anon/authenticated — Supabase default grants apply to trigger functions too; re-REVOKE it';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DELETE FROM public.feature_flags WHERE flag = 'memory_projection';
--   DROP TABLE IF EXISTS public.memory_feedback;
--   DROP TABLE IF EXISTS public.memory_projections;
--   DROP TABLE IF EXISTS public.memory_events;
