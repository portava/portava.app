-- 2730_memory_derivative_registry.sql
--
-- WHAT: create public.memory_derivative_registry - one row per built derivative
-- of the Memory domain, carrying the five fields the Highlights/Memories spec
-- section 18 requires of every derivative (source Memory version, type,
-- destination, generatedAt, revocation state) plus the projected payload itself.
-- RLS enabled, deny by default, service_role only. Nothing else is touched: no
-- column is added to a live table, no policy is rewritten, nothing is dropped.
--
-- WHY. Spec section 18 "Projections and Derived Artifact Registry":
--
--     "Keep canonical truth small and durable. Everything else should be
--      rebuildable. ... Every derivative is registered with source Memory
--      version, type, destination, generatedAt, and revocation state. This
--      gives deletion and privacy changes an explicit cleanup graph."
--
-- and section 28.12 "Always make derived projections rebuildable", section 28.8
-- "Never keep deleted Memories in embeddings, public caches, Highlights,
-- Passport, or Compass projections."
--
-- WHAT WAS MEASURED, this session, before writing this file:
--
--   * The repository census (docs/architecture/census-highlights-memories.md,
--     section 18) grades the twelfth row of the spec's table NOT-BUILT with the
--     note "`memory_derivative_registry` absent; nothing records where a
--     derivative went." `grep -rn memory_derivative_registry` over
--     artifacts/api-server/src returned only the files added alongside this
--     migration.
--   * The existing memory projection family (migrations 2183-2214) was built
--     for a DIFFERENT specification - the owner's "Memory + Experience
--     Intelligence Architecture", as 2183's own header says. Its
--     `memory_projections` table is keyed UNIQUE (user_id, memory_type,
--     subject_type, subject_id) and holds derived PREFERENCES ("prefers walkable
--     areas") with a retention class. It has no destination, no source version,
--     no revocation state and no payload, and its uniqueness key cannot express
--     "the same projection built for a different audience". It is a derived-fact
--     store, not a registry of generated artifacts. This migration therefore
--     builds BESIDE it rather than overloading it, and does not modify it.
--   * The canonical source this registry versions is `memories` (docs/migrations
--     /0067_memories.sql plus 0148_memories_location.sql). Its `updated_at`
--     column is what `source_version` digests; every write path in
--     src/routes/memories.ts sets it.
--
-- PAYLOAD, AND WHY IT IS STORED. Spec section 15 requires public retrieval to
-- query "only a public index or equivalent prefiltered derivative", and
-- section 28.6 forbids answering public search from canonical rows plus
-- post-filtering. A registry that recorded only metadata would leave public
-- search with nothing to read but canonical `memories`. `payload_json` is that
-- prefiltered derivative. It is written by the projection builders, which apply
-- a field whitelist per audience, so the public payload contains city/country
-- and never a coordinate.
--
-- REVERSIBLE BY:
--   BEGIN;
--   DROP TABLE IF EXISTS public.memory_derivative_registry;
--   COMMIT;
-- The table is new and nothing else references it, so the drop is total. No
-- canonical row is created, altered or deleted by this migration, and every
-- derivative it holds is rebuildable from `memories` by design - which is the
-- point of section 18 - so dropping it destroys no truth.
--
-- NOT APPLIED. This file was written without touching any database. It must not
-- be applied until the apply gate has reviewed it.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.set_updated_at() missing - expected from 0001_spine.sql.';
  END IF;
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.memories missing - expected from 0067_memories.sql.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.memory_derivative_registry (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID        NOT NULL,

  -- Section 18 "type": which of the eleven named projections this row is.
  projection_id       TEXT        NOT NULL,
  -- Identity of one built artifact: projection + the scope it was built for
  -- (owner, viewer, trip, place, person). Built by scopeKeyOf() in
  -- src/services/memoryProjections/projectionRegistry.ts.
  scope_key           TEXT        NOT NULL,
  -- Section 18 "Audience" column, denormalized so a cleanup sweep can select by
  -- audience without knowing the builder.
  audience            TEXT        NOT NULL,
  -- Section 18 "destination": where this derivative was delivered.
  destination         TEXT        NOT NULL,

  -- Section 28.13: the engine version that produced it.
  builder_version     TEXT        NOT NULL,
  -- What it derives from. Declared, not guessed: a projection that cannot name
  -- its sources cannot be told it is stale.
  source_tables       TEXT[]      NOT NULL DEFAULT '{}',

  -- Section 18 "source Memory version".
  source_memory_ids   UUID[]      NOT NULL DEFAULT '{}',
  source_version      TEXT        NOT NULL,          -- digest over (memory id, updated_at)
  source_version_json JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { memory_id: updated_at }

  -- The prefiltered derivative itself (see PAYLOAD above). Emptied on revocation.
  payload_json        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  row_count           INTEGER     NOT NULL DEFAULT 0,

  -- Section 18 "generatedAt".
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Section 18 "revocation state" - the cleanup graph's own state machine.
  --   ACTIVE  : current
  --   STALE   : sources moved; rebuild before serving
  --   REVOKED : privacy change or deletion withdrew it; payload emptied
  --   PURGED  : storage reclaimed; the row survives as an audit record only
  revocation_state    TEXT        NOT NULL DEFAULT 'ACTIVE'
                        CHECK (revocation_state IN ('ACTIVE','STALE','REVOKED','PURGED')),
  revoked_at          TIMESTAMPTZ,
  revocation_reason   TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A revoked row must carry the reason it was revoked: an unexplained
  -- revocation is as unauditable as an unrecorded one.
  CONSTRAINT memory_derivative_registry_revocation_explained
    CHECK (revocation_state NOT IN ('REVOKED','PURGED')
           OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)),
  -- A revoked derivative holds no content.
  CONSTRAINT memory_derivative_registry_revoked_is_empty
    CHECK (revocation_state NOT IN ('REVOKED','PURGED') OR row_count = 0)
);

-- One registration per built artifact; a rebuild upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS memory_derivative_registry_artifact_idx
  ON public.memory_derivative_registry (projection_id, scope_key);

-- The cleanup graph is walked by memory id (deletion, privacy change).
CREATE INDEX IF NOT EXISTS memory_derivative_registry_source_memories_idx
  ON public.memory_derivative_registry USING GIN (source_memory_ids);

-- "What does this owner have derived, and is any of it stale?"
CREATE INDEX IF NOT EXISTS memory_derivative_registry_owner_state_idx
  ON public.memory_derivative_registry (owner_id, revocation_state, projection_id);

-- Sweeps read only the live rows.
CREATE INDEX IF NOT EXISTS memory_derivative_registry_generated_idx
  ON public.memory_derivative_registry (generated_at DESC)
  WHERE revocation_state = 'ACTIVE';

DROP TRIGGER IF EXISTS memory_derivative_registry_set_updated_at ON public.memory_derivative_registry;
CREATE TRIGGER memory_derivative_registry_set_updated_at
  BEFORE UPDATE ON public.memory_derivative_registry
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: deny by default and DO NOT add a policy. This table holds derivatives of
-- several audiences side by side, including public payloads and owner-private
-- timelines; a single "owner may read their rows" policy would be the wrong
-- shape for the public ones and too wide for the private ones. Reads go through
-- the projection service on the service role, which applies the section 15
-- namespace rule before any row is returned. A policy may be added later only
-- alongside the surface that needs it.
ALTER TABLE public.memory_derivative_registry ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.memory_derivative_registry FROM PUBLIC;
REVOKE ALL ON public.memory_derivative_registry FROM anon;
REVOKE ALL ON public.memory_derivative_registry FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_derivative_registry TO service_role;

COMMENT ON TABLE public.memory_derivative_registry IS
  'Highlights/Memories spec v1 section 18: registry of derived Memory artifacts. '
  'One row per (projection, scope) with the source Memory version it was built from, '
  'its destination, generatedAt and revocation state, plus the prefiltered payload. '
  'Every row is rebuildable from public.memories; deleting a row destroys no truth.';

COMMIT;
