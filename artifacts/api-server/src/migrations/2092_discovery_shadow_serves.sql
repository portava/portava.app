-- 2092_discovery_shadow_serves.sql
-- P1 Stage 2: the shadow observation table. Operator ruling D7=A.
--
-- WHAT SHADOW MODE IS
-- ===================
-- `DISCOVERY_ENGINE_MODE = shadow` serves the user the LEGACY result, byte for
-- byte, and then — after the response has been flushed — computes what the PDE
-- engine would have returned for the same request over the same candidates.
-- Both orders are written here. Nothing a user receives depends on this table
-- or on anything that writes to it.
--
-- WHY A NEW TABLE AND NOT rank_events — D7=A, verbatim ground
-- ==========================================================
-- `rank_events` is mutable state with a client-input surface: outcomes arrive
-- from clients and UPDATE existing rows (routes/rankEvents.ts). One contaminated
-- row corrupting the comparison funnel is disqualifying, and the funnel is the
-- entire deliverable. So the comparison lives in its own table, append-only by
-- construction, and no client route can reach it.
--
-- APPEND-ONLY BY CONSTRUCTION — WHAT THAT MEANS HERE, EXACTLY
-- ==========================================================
-- Three separate mechanisms, because each covers a hole the others leave:
--
--   1. GRANTS. service_role receives INSERT and SELECT and nothing else.
--      anon and authenticated receive nothing at all. This is the layer that
--      actually binds the application: service_role has BYPASSRLS in Supabase,
--      so RLS policies alone would constrain nothing that writes here.
--
--      ⚠ CORRECTION, 2026-08-15 — THIS FILE DID NOT ACHIEVE (1). Read 2093.
--
--      Applied to production, this file left service_role holding DELETE,
--      INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE and UPDATE — verified
--      against the live catalog, not inferred. The revokes below name PUBLIC,
--      anon and authenticated, and those DID land (anon and authenticated hold
--      nothing). What is missing is a revoke from service_role: Supabase's
--      default privileges on the public schema grant ALL to service_role at
--      CREATE TABLE time, so the GRANT below added nothing already held and
--      established no limit.
--
--      Consequences worth stating plainly rather than filing away:
--        - Mechanism (1) was absent from the moment this was applied. The
--          append-only property held on mechanism (3), the UPDATE triggers,
--          alone — belt missing, braces holding, nothing able to say so.
--        - TRUNCATE was reachable, and TRUNCATE fires neither UPDATE trigger.
--          2092 did not consider it at all. 2093 revokes it AND adds a
--          BEFORE TRUNCATE trigger.
--        - Every gate went green, and NOT because audit:schema ignores grants
--          -- it does model them. It parses the GRANT statements a migration
--          writes and checks each is PRESENT. 2092 claimed service_role.insert
--          and service_role.select, and both were present, so there was nothing
--          to report. What no claim model here can express is EXCESS privilege,
--          and REVOKE is not modelled at all. An audit that confirms what you
--          claimed cannot tell you what else you hold.
--          `pnpm run audit:shadow-append-only` asserts the EXACT set instead.
--
--      This text is a correction, not a rewrite: the DDL below is what was
--      applied to production and must keep saying so. 2093 is the repair.
--
--   2. RLS, still enabled and still deny-by-default for anon/authenticated.
--      Belt to the grants' braces, and it is what makes a future route that
--      reaches this table with a user JWT fail loudly rather than quietly read
--      other users' rows.
--
--   3. A BEFORE UPDATE TRIGGER that raises. Grants can be re-granted by a
--      migration that means well; the trigger makes an UPDATE fail at the point
--      of the statement regardless of who issues it, superuser included.
--
-- WHY THE TRIGGER DOES NOT ALSO BLOCK DELETE
-- ==========================================
-- Deliberate, and the one place "append-only" is knowingly not absolute.
--
-- user_id carries ON DELETE CASCADE to auth.users. If the trigger raised on
-- DELETE, deleting an account would fail — the cascade would hit this table and
-- abort the whole transaction. An observability table must not be able to hold
-- a user's account-deletion request hostage. Privacy wins that trade.
--
-- The cascade is also the ONLY deletion that can occur: no role is granted
-- DELETE, and cascade deletes run under the constraint rather than the caller's
-- privileges. So the reachable operations are exactly INSERT, SELECT, and
-- erasure-on-account-deletion.
--
-- What D7=A was protecting against is UPDATE — a row that says something
-- different later than it said when it was written. That is fully blocked.
--
-- RETENTION — 90 days, and no code path deletes
-- =============================================
-- Covered by the retention window in force from 2026-08-14
-- (docs/ops/retention-policy.md). Consistent with that policy, this migration
-- creates no reaper, no cron and no TTL: at window end, deletion is a scheduled
-- decision taken by a person against the evidence the window produced. There is
-- deliberately no code path in this repository that would make it automatic.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- ===============================
-- It does not enable anything. `DISCOVERY_ENGINE_MODE` is unchanged and still
-- resolves to `legacy`, so nothing writes a row here until the mode is
-- deliberately moved to `shadow`. Applying this migration is behaviour-
-- preserving: it creates an empty table that nothing currently reaches.

CREATE TABLE IF NOT EXISTS discovery_shadow_serves (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at   timestamptz NOT NULL DEFAULT now(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id    text,

  -- ── The request, as the engine saw it ──────────────────────────────────────
  -- Enough to group comparable serves. destination/category/radius_km are the
  -- Cache A key components, so a reader can ask "how did this key behave across
  -- its whole TTL" — which is the question the caches-in-series finding is about.
  destination   text        NOT NULL,
  category      text        NOT NULL,
  radius_km     numeric     NOT NULL,
  page          smallint    NOT NULL,
  page_size     smallint    NOT NULL,
  sort_by       text,

  -- ── What LEGACY actually served ────────────────────────────────────────────
  -- serve_point is the load-bearing column. Divergence on serve point 6 (a cold
  -- fetch, where legacy DID rank) means the two rankers disagree. Divergence on
  -- serve points 1-3 (cache A, where legacy ran NO ranker) means PDE reached
  -- traffic legacy never ranked at all. Those are different findings and must
  -- never be summed.
  serve_point   smallint    NOT NULL CHECK (serve_point BETWEEN 1 AND 9),
  cache_level   text,
  legacy_ids    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  legacy_total  integer     NOT NULL,
  legacy_ms     integer,

  -- ── What PDE WOULD have served ─────────────────────────────────────────────
  pde_ids       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  pde_total     integer     NOT NULL,
  pde_ms        integer,
  -- Which ranking stages ran. A shadow row whose DRS stage did not run is not
  -- evidence about DRS, and without this column it would look identical to one
  -- where DRS ran and changed nothing.
  pde_stages    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Writes the shadow run attempted and had intercepted. Expected to be > 0 on
  -- most rows: DiscoveryRankingService emits its own rank_events rows and cannot
  -- be asked not to, so they are suppressed at the client. A sudden zero means
  -- the suppressor stopped being reached, not that the run became clean.
  pde_suppressed_writes integer NOT NULL DEFAULT 0,

  -- ── The comparison, computed once at write time ────────────────────────────
  -- Precomputed so that every reader answers the funnel the same way. Leaving it
  -- to query time invites two analyses that disagree and no way to tell which
  -- was run.
  overlap_count  smallint   NOT NULL,   -- ids present in both served pages
  displaced_count smallint  NOT NULL,   -- shared ids that changed position
  top_changed    boolean    NOT NULL,   -- did position 0 change

  -- ── Provenance ─────────────────────────────────────────────────────────────
  -- mode_reason distinguishes "shadow by configuration" from a fallback. Without
  -- it, a resolver that had been silently failing would look exactly like one
  -- working correctly.
  engine_mode   text        NOT NULL,
  mode_reason   text        NOT NULL
);

-- Per-key chronology: the natural unit of the caches-in-series question.
CREATE INDEX IF NOT EXISTS discovery_shadow_serves_key_observed_at
  ON discovery_shadow_serves (destination, category, radius_km, observed_at DESC);

-- Serve-point slicing, which every read of this table starts from.
CREATE INDEX IF NOT EXISTS discovery_shadow_serves_serve_point_observed_at
  ON discovery_shadow_serves (serve_point, observed_at DESC);

-- Account-deletion cascade support.
CREATE INDEX IF NOT EXISTS discovery_shadow_serves_user_id
  ON discovery_shadow_serves (user_id);

-- ── Row-level security ────────────────────────────────────────────────────────

ALTER TABLE discovery_shadow_serves ENABLE ROW LEVEL SECURITY;

-- No policy for anon or authenticated. RLS denies by default, and that default
-- is the intended state: this table has no client surface, by design.

CREATE POLICY "service_role_insert_discovery_shadow_serves"
  ON discovery_shadow_serves
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "service_role_read_discovery_shadow_serves"
  ON discovery_shadow_serves
  FOR SELECT
  TO service_role
  USING (true);

-- ── Privileges — the layer that actually binds ────────────────────────────────

REVOKE ALL ON discovery_shadow_serves FROM PUBLIC;
REVOKE ALL ON discovery_shadow_serves FROM anon;
REVOKE ALL ON discovery_shadow_serves FROM authenticated;
GRANT INSERT, SELECT ON discovery_shadow_serves TO service_role;

-- ── Append-only enforcement ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION discovery_shadow_serves_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'discovery_shadow_serves is append-only (operator ruling D7=A): % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS discovery_shadow_serves_no_update ON discovery_shadow_serves;
CREATE TRIGGER discovery_shadow_serves_no_update
  BEFORE UPDATE ON discovery_shadow_serves
  FOR EACH ROW
  EXECUTE FUNCTION discovery_shadow_serves_append_only();

-- And again at statement level. Not redundant: a FOR EACH ROW trigger fires only
-- for rows the statement actually matches, so `UPDATE ... WHERE false` would
-- succeed silently against the row-level trigger alone.
--
-- That matters for a reason beyond tidiness. The append-only property is the
-- entire ground of D7=A, and a property that can only be verified by writing a
-- row into production is a property nobody will verify. With this trigger, the
-- check is a single statement that touches nothing:
--
--   UPDATE discovery_shadow_serves SET category = 'x' WHERE false;
--   -- expect: ERROR ... is append-only
--
DROP TRIGGER IF EXISTS discovery_shadow_serves_no_update_stmt ON discovery_shadow_serves;
CREATE TRIGGER discovery_shadow_serves_no_update_stmt
  BEFORE UPDATE ON discovery_shadow_serves
  FOR EACH STATEMENT
  EXECUTE FUNCTION discovery_shadow_serves_append_only();

COMMENT ON TABLE discovery_shadow_serves IS
  'P1 Stage 2 shadow observations: what legacy served vs what PDE would have served, per request. Append-only (D7=A); UPDATE blocked by trigger; DELETE reachable only via the auth.users cascade. 90-day retention window, no automatic reaper.';
