-- 2700_layover_certified_feasibility.sql
--
-- Persist the certified feasibility computation so a layover answer can be
-- replayed instead of re-derived.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2700.
--
-- WHAT: creates `layover_certified_computations`, an append-only record of
-- every certified feasibility computation (engine version, record-shape
-- version, a hash over the exact named inputs, the inputs themselves, the
-- verdict, the deadline and the buffer breakdown), owner-readable and
-- service-role-written. It creates ONE new object and alters nothing that
-- exists.
--
-- WHY. Spec §2.1: "Every consequential recommendation is versioned,
-- explainable and replayable." Census L5 scores that NOT-BUILT for the
-- storage half and states the reason exactly: `layover_recommendations` has
-- no version, snapshot, engine-version or input-hash column (0127:106-138),
-- and rows are deleted wholesale and re-inserted on read. Nothing can be
-- replayed. Census L1/L2 add that no output is persisted as a certified
-- computation at all.
--
-- The code half of that landed first and is what this schema is shaped for:
-- `services/airport/LayoverFeasibility.ts` returns a record carrying
-- `engineVersion`, `feasibilityVersion`, `inputHash`, the fully-named input
-- set, the verdict, the envelope, the buffer breakdown and the §6.2 estimates,
-- and `replayFeasibility(record.inputs)` reproduces it deep-equal (pinned by
-- src/test/layoverFeasibilityRecord.test.ts). The four route handlers that
-- publish feasibility now consult exactly one such record per request. What is
-- missing is somewhere to put it.
--
-- WHAT WAS MEASURED, and what it means for this table's size. Production
-- `ajrurzioarfkagpuxfnb` as of 2026-09-07: 5 layover sessions ever, from 2
-- users, 0 active; 30 `layover_recommendations` rows; 0 `layover_plan_stops`;
-- 38 `layover_events`; 3,206 `airport_profiles` of which 0 are verified and 0
-- carry a non-default buffer. This table is therefore empty on arrival and
-- will stay small. It is NOT free at scale — one row per feasibility request
-- would grow with dashboard loads — so the unique index below is doing real
-- work: an identical recomputation collides on (session_id, input_hash) and
-- does not add a row. Note the input hash covers `nowMs`, so two requests a
-- minute apart legitimately differ; a writer that wants one row per material
-- change, rather than one per request, must say so at the call site. THERE IS
-- NO WRITER YET (see ORDERING).
--
-- ORDERING — READ BEFORE LANDING A WRITER. No code writes this table today,
-- deliberately. supabase-js sends every key in the insert payload, so a writer
-- that names a column fails outright on any database that has not run this
-- migration — the same hazard 2410 documents and gates behind a flag. The
-- sequence is: apply this, confirm the postconditions, THEN land the writer.
-- Applying this migration alone changes no behaviour, moves no row, and alters
-- no existing object.
--
-- WHY A SEPARATE TABLE AND NOT MORE COLUMNS ON layover_recommendations.
-- Spec §4's implementation rule: "Use normalized operational tables plus
-- immutable/versioned snapshots. Avoid a single JSON blob as the source of
-- truth. JSON is acceptable for provenance/reason detail, not for fields used
-- in safety predicates or relational joins." So the fields a predicate or a
-- join would touch — verdict, confidence, hard_return_time, total_buffer_min,
-- engine_version, input_hash — are real typed columns; `inputs`, `breakdown`
-- and `estimates` are JSONB because they are provenance detail. A computation
-- is also not one-per-card: one record certifies the whole session at an
-- instant, and several cards cite it.
--
-- WRITE BOUNDARY. `authenticated` gets SELECT and nothing else, matching the
-- boundary 2335 established for `layover_recommendations` after that table's
-- certification fields (safety_rating, return_buffer_min, hard_return_time)
-- were shown to be client-forgeable on CI. Certification fields a traveller
-- can write are not certification. INSERT/UPDATE/DELETE are service-role only;
-- there is no owner write policy and no WITH CHECK to get wrong, because there
-- is no client-writable verb.
--
-- IMMUTABILITY is asserted by grant, not by trigger: nothing but service_role
-- can write, and the service path only ever inserts. A trigger forbidding
-- UPDATE would also block a future backfill and buys nothing over the absent
-- grant. Stated so a reader does not mistake the omission for an oversight.
--
-- REVERSIBLE BY:
--   DROP TABLE IF EXISTS public.layover_certified_computations;
-- One statement, and it is safe while no writer exists. Once a writer lands,
-- the DROP discards history — roll the writer back first.
--
-- NOT DONE HERE, and why:
--   - No `layover_snapshots` / constraint / time-budget tables (spec §4, §19
--     steps 2-4). Those are a domain model, not a place to put this record,
--     and building them unwritten would be more dead schema than this already
--     is. One table, one need.
--   - No backfill. The 30 existing recommendation rows were produced by engine
--     versions that predate the record; inventing an input hash for them would
--     fabricate a computation that never happened.
--   - NO CITATION COLUMNS ON `layover_recommendations`, and this is a measured
--     decision, not an oversight. The first draft of this migration added
--     nullable `engine_version` / `input_hash` columns to that table so a card
--     could name the computation that certified it. Running
--     `src/test/layoverCutover.test.ts` turned that into four RED tests:
--
--       ! UNCLASSIFIED CO-TOUCHER: unapplied migration
--         2700_layover_certified_feasibility mutates an object 2411 touches.
--         Whether apply order matters has not been decided in writing —
--         decide it in CO_TOUCHER_CLASSIFICATION rather than by ordering luck.
--
--     Migration 2411 (`layover_recommendation_rec_key_backfill`, unapplied and
--     under an explicit instruction not to apply) also writes
--     `layover_recommendations`, and the cutover checker requires any such
--     co-toucher to be classified in writing in
--     `src/scripts/lib/layoverCutoverEvaluate.ts` — a file this work does not
--     own. Getting past that check by ordering luck is exactly what it exists
--     to prevent. So this migration touches no existing object at all, the
--     checker stays green, and whether a card should cite its computation is
--     left as a separate decision with its own classification. The certified
--     record already carries `engine_version` and `input_hash` on the new
--     table; only the JOIN back to a card is deferred.
--   - No backfill of any kind: the 30 existing recommendation rows were
--     produced by engine versions that predate the record, and inventing an
--     input hash for them would fabricate a computation that never happened.

BEGIN;

-- ── the certified computation ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_certified_computations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,
  -- Denormalised owner, so a SELECT policy does not have to join through
  -- layover_sessions on every read. Set by the writer from the session row.
  user_id             UUID        NOT NULL,

  -- Identity of the computation.
  engine_version      TEXT        NOT NULL,   -- LAYOVER_ENGINE_VERSION (the arithmetic)
  feasibility_version TEXT        NOT NULL,   -- LAYOVER_FEASIBILITY_VERSION (the record shape)
  input_hash          TEXT        NOT NULL,   -- 'sha256:<64 hex>' over the named inputs
  computed_at         TIMESTAMPTZ NOT NULL,   -- the instant the record is FOR (inputs.nowMs)

  -- Fields a predicate or a join may touch: typed, not JSON.
  verdict             TEXT        NOT NULL
                        CHECK (verdict IN ('yes','tight','no','stay_airside')),
  confidence          TEXT        NOT NULL
                        CHECK (confidence IN ('INSUFFICIENT','LOW','MEDIUM','HIGH')),
  buffer_percentile   TEXT        NOT NULL DEFAULT 'p90'
                        CHECK (buffer_percentile IN ('p50','p75','p90')),
  cutoff_at           TIMESTAMPTZ NOT NULL,   -- boarding time, else departure time
  hard_return_time    TIMESTAMPTZ NOT NULL,   -- always cutoff_at - total_buffer_min
  total_buffer_min    INTEGER     NOT NULL CHECK (total_buffer_min >= 0),
  usable_minutes      INTEGER     NOT NULL CHECK (usable_minutes >= 0),

  -- Provenance / reason detail. JSON is the right shape for these and only
  -- these (spec §4 implementation rule).
  inputs              JSONB       NOT NULL,   -- the full named input set: replay feeds this back
  breakdown           JSONB       NOT NULL,   -- per-term buffer breakdown
  estimates           JSONB       NOT NULL,   -- §6.2 Estimate per term
  reason_codes        TEXT[]      NOT NULL DEFAULT '{}',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Newest computation for a session — the read every consumer wants.
CREATE INDEX IF NOT EXISTS layover_certcomp_session_idx
  ON layover_certified_computations(session_id, computed_at DESC);

-- The same inputs are the same computation. This is what keeps a dashboard
-- that reloads twice in one second from writing the row twice, and it is also
-- the constraint that makes `input_hash` an identity rather than a label.
CREATE UNIQUE INDEX IF NOT EXISTS layover_certcomp_session_hash_uidx
  ON layover_certified_computations(session_id, input_hash);

ALTER TABLE layover_certified_computations ENABLE ROW LEVEL SECURITY;

-- Owner may READ their own certified computations. No write policy exists,
-- and none should: see WRITE BOUNDARY above.
DROP POLICY IF EXISTS "layover_certcomp_owner_read" ON layover_certified_computations;
CREATE POLICY "layover_certcomp_owner_read"
  ON layover_certified_computations FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.layover_certified_computations FROM anon;
REVOKE ALL ON public.layover_certified_computations FROM authenticated;
GRANT SELECT ON public.layover_certified_computations TO authenticated;

-- ── postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  idx_unique BOOLEAN;
  policy_count INTEGER;
  writable_cols INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_certified_computations missing';
  END IF;

  -- RLS on, or the owner policy below is decoration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'layover_certified_computations'
      AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on layover_certified_computations';
  END IF;

  -- Exactly one policy, and it is SELECT-only. A second policy, or a FOR ALL
  -- one, would reopen the write boundary this migration exists to set.
  SELECT count(*) INTO policy_count FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'layover_certified_computations';
  IF policy_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 policy on layover_certified_computations, found %', policy_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'layover_certified_computations'
      AND policyname = 'layover_certcomp_owner_read' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_certcomp_owner_read is missing or is not FOR SELECT';
  END IF;

  -- No client-writable verb. This is the assertion 2335 had to add after the
  -- fact for layover_recommendations; it is cheaper to make it true on arrival.
  SELECT count(*) INTO writable_cols FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
      AND grantee IN ('anon','authenticated')
      AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');
  IF writable_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon/authenticated hold % non-SELECT grant(s) on layover_certified_computations', writable_cols;
  END IF;

  SELECT i.indisunique INTO idx_unique
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'layover_certcomp_session_hash_uidx';
  IF idx_unique IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_certcomp_session_hash_uidx missing or not UNIQUE';
  END IF;

  -- Asserted because this migration's whole safety argument is that it touches
  -- nothing that already exists: layover_recommendations must be exactly as it
  -- was. If a later edit adds a column here, the cutover checker's co-toucher
  -- rule applies and must be answered in writing first.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
      AND column_name IN ('engine_version','input_hash')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: this migration must not add citation columns to layover_recommendations -- see the CO-TOUCHER note in the header';
  END IF;
END $$;

COMMIT;
