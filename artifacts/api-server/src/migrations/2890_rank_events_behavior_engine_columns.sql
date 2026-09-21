-- 2890_rank_events_behavior_engine_columns.sql
--
-- ⚠ STAGED AND REHEARSED. Applied by the lane that wrote it to portava-ci
--   (hwokxgbmezheskbzskfr) ONLY. NOT applied to production.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Discovery
-- MIGRATIONS lane, reserved band 2890-2899 so concurrent lanes cannot collide;
-- the highest existing migration is 2880.
--
-- PURELY ADDITIVE AND IDEMPOTENT. Five new columns on public.rank_events, two
-- column CHECKs and one pairing CHECK. It drops nothing, rewrites no row, moves
-- no data, creates no index, flips no flag and changes no reader. Nothing in
-- the tree writes any of these columns as of this file — see "WHAT THIS DOES
-- NOT BUY".
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT, AND WHICH CENSUS ROW EACH COLUMN ANSWERS
-- ══════════════════════════════════════════════════════════════════════════════
--   schema_version  smallint NOT NULL DEFAULT 1   → DV-38 (census-discovery:2189)
--   privacy_class   text     NOT NULL DEFAULT …   → DV-39 (census-discovery:914)
--   retention_tier  text     NOT NULL DEFAULT …   → DV-39
--   dwell_ms        integer  NULL                 → DV-41 (census-discovery:916)
--   dwell_kind      text     NULL                 → DV-41
--
-- `04` §6 names seventeen fields the behaviour store must be able to represent
-- and says, in the same section: "If the current table cannot represent this
-- safely, EXTEND IT BY MIGRATION rather than introducing a competing event
-- store." This file is that extension for the three §6 fields whose absence is
-- the whole of DV-38/39/41. It deliberately does NOT add the other §6 names
-- (trail_id, place_id, trip_id, completion_pct, source_type/source_id) — those
-- have no census row open against them, no writer, and adding a column with no
-- producer is the defect class docs/architecture/trust-unproduced-vocabulary.md
-- exists to track. Five columns that three open rows name is the whole scope.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED BEFORE WRITING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- portava-ci `hwokxgbmezheskbzskfr`, 2026-09-14, read before any write:
--
--   rank_events columns (13):
--     id uuid NOT NULL · user_id uuid NOT NULL · item_id text NOT NULL ·
--     item_kind text NULL · position smallint NULL · features jsonb NOT NULL ·
--     outcome text NOT NULL · served_at timestamptz NOT NULL ·
--     outcome_at timestamptz NULL · surface text NOT NULL ·
--     session_id uuid NULL · event_type text NULL · content_type text NULL
--   rank_events row count: 0
--
-- Production `ajrurzioarfkagpuxfnb` was read by the integration owner the same
-- day and reported the SAME thirteen columns — but WITH LIVE ROWS. This file
-- was therefore written to be correct on a populated table, and rehearsed on an
-- empty one. That asymmetry is stated rather than hidden: the rehearsal proves
-- the DDL is valid and the postconditions hold, and proves NOTHING about how
-- long the ALTER takes on production's row count.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY DEFAULT AND NOT BACKFILL (the two NOT NULL columns)
-- ══════════════════════════════════════════════════════════════════════════════
-- A NOT NULL column added to a populated table needs a DEFAULT or a backfill.
-- Both NOT NULL columns here take a DEFAULT, for two independent reasons:
--
--   1. CORRECTNESS. The default is TRUE of every existing row, not a
--      placeholder.
--
--      schema_version = 1 — `DISCOVERY_EVENT_SCHEMA_VERSION` in
--      lib/discoveryServeLog.ts:178 is the literal 1, and it is the ONLY value
--      the tree has ever produced. Every row already in the table was written
--      in shape 1. Stamping 1 on them records what happened; it does not guess.
--
--      privacy_class = 'raw_behavioral_event' — `DISCOVERY_EVENT_PRIVACY_CLASS`
--      in lib/discoveryServeLog.ts:196. Every row in rank_events is, by the
--      table's definition, one raw behavioural event: an impression or an
--      outcome attributable to one user on one surface. There is no row in this
--      table that is anything else, so the class is not an assumption about the
--      rows — it is a restatement of what the table is.
--
--      retention_tier = 'raw_recent' — `04` §11's first layer, "raw recent
--      events". Same argument: rank_events IS the raw recent layer. The other
--      three layers (durable aggregates, audit/security, anonymised long-term)
--      live in other stores; see 2892_place_momentum.sql for the second.
--
--   2. COST. PostgreSQL 11+ stores a non-volatile ADD COLUMN … DEFAULT in the
--      catalogue (pg_attribute.atthasmissing / attmissingval) and does NOT
--      rewrite the heap. On production's populated rank_events this is a
--      catalogue update and a brief ACCESS EXCLUSIVE lock, not a table rewrite.
--      A backfill UPDATE would touch every row, double the table's size before
--      the next vacuum, and be interrupted by the serve path's own inserts —
--      for a value that is constant.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY dwell_ms IS NULLABLE, AND WHY IT MUST NOT GET A DEFAULT
-- ══════════════════════════════════════════════════════════════════════════════
-- `04` §7: "Do not infer interest from a phone sitting untouched." That rule
-- can only be applied if the row can distinguish
--
--     "the viewer dwelled for zero milliseconds"   (dwell_ms = 0)
--     "nobody measured dwell on this row"          (dwell_ms IS NULL)
--
-- A DEFAULT 0 would collapse those two into one value and every existing row —
-- none of which carries a dwell measurement — would assert a measured zero. The
-- §7 rule would then be operating on a fiction. So dwell_ms is NULL by default
-- and NULL means UNMEASURED, permanently. Every reader must treat NULL as
-- "no evidence", never as 0.
--
-- dwell_kind carries §7's three-way distinction (active / passive-foreground /
-- idle) and is NULL for the same reason. The pairing CHECK below refuses a kind
-- without a duration: "this dwell was idle, for an unknown length of time" is
-- not a measurement, it is a label with nothing under it.
--
-- The reverse pairing (a duration with no kind) IS permitted, and deliberately:
-- a client that can time a view but cannot yet classify its quality should be
-- able to record the number honestly rather than be forced to invent a kind.
-- Such a row is §6-complete and §7-incomplete, and a reader can tell.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- `10` §4 — EXPECTED CARDINALITY · INDEX RATIONALE · EXPLAIN (census DC-15)
-- ══════════════════════════════════════════════════════════════════════════════
-- `10` §4 requires every NEW QUERY PATH to state expected cardinality, index
-- rationale, and EXPLAIN verification where meaningful.
--
--   NEW QUERY PATHS INTRODUCED BY THIS FILE: NONE. Five columns, no reader.
--   INDEXES CREATED BY THIS FILE: NONE, and that is the considered answer, not
--   an omission. An index exists to serve a query; there is no query. A
--   `WHERE dwell_ms IS NOT NULL` index added now would be dead weight on every
--   INSERT the serve path makes, to accelerate a read nobody performs. The
--   index belongs in the migration that lands the first dwell reader, where its
--   rationale can be stated against a real plan.
--
--   EXPECTED CARDINALITY, for whoever writes that migration:
--     rank_events grows at one row per served item per impression, plus one row
--     per outcome. dwell_ms will be non-NULL on the ATTENTION subset only —
--     `04` §4 puts active_dwell in the Attention category, which is a small
--     fraction of Exposure rows. A partial index `WHERE dwell_ms IS NOT NULL`
--     is therefore the right shape when the time comes, not a full index.
--
--   EXPLAIN: not meaningful for a file that adds no query path. The EXPLAIN
--   evidence `10` §4 asks for is recorded in 2891 and 2892, which DO add index-
--   backed paths, against portava-ci.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT BUY
-- ══════════════════════════════════════════════════════════════════════════════
-- After this file lands, ALL FIVE COLUMNS ARE STILL UNWRITTEN.
--
--   * lib/discoveryServeLog.ts writes `features.schemaVersion` and
--     `features.privacyClass` into the JSONB blob (:430, :431) and does NOT
--     write the new COLUMNS. DV-38 asks for the column; this file supplies it;
--     the writer change that populates it is a CODE change in the Discovery
--     instrumentation lane, not this one.
--   * NO client emits a dwell distinction at all, so dwell_ms/dwell_kind have
--     no producer anywhere in the tree. DV-41 is TWO defects — "no dwell
--     column" and "no client emits a dwell distinction" — and this file closes
--     exactly the first.
--   * retention_tier labels a layer; it does NOT enforce one. No sweeper, no
--     horizon, no expiry column. `04` §11 ends "Exact retention must be decided
--     with privacy/legal review", and a migration that invented a horizon would
--     be pre-empting that review with an engineer's guess. The column records
--     WHICH LAYER a row belongs to so that the review has something to attach a
--     number to.
--
-- So the honest verdict move this file supports is DV-38 W→W (half discharged,
-- reason superseded: the column exists, the writer does not) and DV-41 N→W
-- (the schema half exists; no emitter does). It does not close any row on its
-- own. That is graded by the integration owner, not asserted here.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY — fully, cheaply, with no data loss
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_dwell_pairing_check;
--   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS dwell_kind;
--   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS dwell_ms;
--   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS retention_tier;
--   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS privacy_class;
--   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS schema_version;
--   COMMIT;
--
-- DROP COLUMN destroys only values written INTO these five columns. Nothing
-- writes them as of this file, so at the moment of writing the reversal is
-- total and loses nothing. EXPIRY CONDITION: once a writer populates dwell_ms
-- or dwell_kind, dropping the column destroys measurements that exist nowhere
-- else, and the reversal stops being free. Reverse before the writer ships, or
-- not at all.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TRANSACTION
-- ══════════════════════════════════════════════════════════════════════════════
-- Required. Five ALTERs plus a CHECK that revalidates every existing row. If
-- the pairing CHECK failed after the columns were committed, the table would be
-- left half-extended with no record of why. One transaction, all or nothing.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  col TEXT;
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2890): public.rank_events does not exist. Apply 0153_add_rank_events.sql first.';
  END IF;

  -- The thirteen-column shape this file extends. If any of these is missing the
  -- database is older than the writer and the new columns would sit beside a
  -- schema that cannot produce them.
  FOREACH col IN ARRAY ARRAY['user_id','item_id','features','outcome','served_at','surface','session_id'] LOOP
    PERFORM 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='rank_events' AND column_name=col;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (2890): rank_events.% is missing; this database is older than the 13-column shape 2890 extends.', col;
    END IF;
  END LOOP;

  -- Refuse to run against a database that already carries a DIFFERENTLY-TYPED
  -- column of one of these names — that would mean another lane got here first
  -- with a different design, and ADD COLUMN IF NOT EXISTS would silently accept
  -- their shape while this file's postconditions claimed ours.
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events'
     AND column_name='schema_version' AND data_type <> 'smallint';
  IF FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2890): rank_events.schema_version exists with a type other than smallint. Another migration defined it differently; resolve by hand.';
  END IF;

  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events'
     AND column_name='dwell_ms' AND data_type <> 'integer';
  IF FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2890): rank_events.dwell_ms exists with a type other than integer. Another migration defined it differently; resolve by hand.';
  END IF;
END $$;

-- ── DV-38 · `04` §6 schema_version ───────────────────────────────────────────
ALTER TABLE public.rank_events
  ADD COLUMN IF NOT EXISTS schema_version smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.rank_events.schema_version IS
  '`04` §6 / census DV-38. The event-shape version this row was written in. '
  'DEFAULT 1 is not a placeholder: DISCOVERY_EVENT_SCHEMA_VERSION '
  '(lib/discoveryServeLog.ts:178) is 1 and is the only value the tree has ever '
  'produced, so every pre-2890 row genuinely is shape 1. As of migration 2890 '
  'NOTHING writes this column — lib/discoveryServeLog.ts writes the same value '
  'into features.schemaVersion instead. Bump the constant and this column '
  'together, never one alone.';

-- ── DV-39 · `04` §3 privacy classification + §11 retention layer ─────────────
ALTER TABLE public.rank_events
  ADD COLUMN IF NOT EXISTS privacy_class text NOT NULL DEFAULT 'raw_behavioral_event';

ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_privacy_class_check;
ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_privacy_class_check
  CHECK (privacy_class = ANY (ARRAY[
    -- What rank_events holds today, and the only value with a producer.
    'raw_behavioral_event',
    -- Reserved for a row derived from behaviour rather than observed directly;
    -- named here so a future writer cannot invent a spelling for it.
    'derived_behavioral_feature',
    -- `04` §11's third layer: an event kept for audit/security rather than for
    -- ranking, and therefore on a different retention clock.
    'audit_security_event'
  ]::text[]));

COMMENT ON COLUMN public.rank_events.privacy_class IS
  '`04` §3 "privacy-classified" / census DV-39. The privacy class of the row '
  'itself — the LABEL that DV-39 found missing beside a rule that was already '
  'enforced (lib/rankLog.ts:9-12 strips precise coordinates before insert). '
  'DEFAULT ''raw_behavioral_event'' is true of every existing row by the '
  'definition of the table: every rank_events row is one observed user action '
  'on one surface. As of migration 2890 nothing writes this column; '
  'lib/discoveryServeLog.ts:431 writes the same value into '
  'features.privacyClass.';

ALTER TABLE public.rank_events
  ADD COLUMN IF NOT EXISTS retention_tier text NOT NULL DEFAULT 'raw_recent';

ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_retention_tier_check;
ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_retention_tier_check
  CHECK (retention_tier = ANY (ARRAY[
    -- `04` §11's four suggested layers, in the specification's own order.
    'raw_recent',
    'durable_aggregate',
    'audit_security',
    'anonymized_longterm'
  ]::text[]));

COMMENT ON COLUMN public.rank_events.retention_tier IS
  '`04` §11 retention layer / census DV-39. WHICH of §11''s four layers this '
  'row belongs to. DEFAULT ''raw_recent'' because rank_events IS the raw recent '
  'layer. This column LABELS a layer and ENFORCES NOTHING: there is no horizon '
  'column, no sweeper and no expiry, because §11 ends "Exact retention must be '
  'decided with privacy/legal review" and a migration that invented a number '
  'would pre-empt that review. The label exists so the review has something to '
  'attach a number to.';

-- ── DV-41 · `04` §6 dwell_ms + §7 dwell quality ──────────────────────────────
-- NULLABLE ON PURPOSE. NULL = NOT MEASURED. See the header: a DEFAULT 0 would
-- make every existing row assert a measured zero-millisecond dwell and §7's
-- "do not infer interest from a phone sitting untouched" would then be reading
-- a fiction.
ALTER TABLE public.rank_events
  ADD COLUMN IF NOT EXISTS dwell_ms integer;

ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_dwell_ms_check;
ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_dwell_ms_check
  CHECK (dwell_ms IS NULL OR dwell_ms >= 0);

COMMENT ON COLUMN public.rank_events.dwell_ms IS
  '`04` §6 dwell_ms / census DV-41. Milliseconds of dwell attributed to this '
  'row. NULL MEANS NOT MEASURED AND NEVER MEANS ZERO — the distinction is the '
  'whole point of the column, because §7 forbids inferring interest from an '
  'untouched phone and that rule needs "no evidence" to be expressible. Every '
  'reader must treat NULL as absence of evidence. As of migration 2890 no '
  'client in the tree emits a dwell measurement at all.';

ALTER TABLE public.rank_events
  ADD COLUMN IF NOT EXISTS dwell_kind text;

ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_dwell_kind_check;
ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_dwell_kind_check
  CHECK (dwell_kind IS NULL OR dwell_kind = ANY (ARRAY[
    -- `04` §7's three, in the specification's own order.
    'active',
    'passive_foreground',
    'idle'
  ]::text[]));

COMMENT ON COLUMN public.rank_events.dwell_kind IS
  '`04` §7 dwell quality / census DV-41. active | passive_foreground | idle. '
  'NULL means the dwell was timed but not classified, which is permitted: a '
  'client that can measure a duration but cannot yet judge its quality should '
  'record the number honestly rather than invent a kind. The reverse — a kind '
  'with no duration — is refused by rank_events_dwell_pairing_check.';

-- A kind with no duration is a label with nothing under it. Revalidates every
-- existing row; all existing rows have both columns NULL, so it cannot fail on
-- them.
ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_dwell_pairing_check;
ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_dwell_pairing_check
  CHECK (dwell_kind IS NULL OR dwell_ms IS NOT NULL);

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  n       INT;
  v_null  TEXT;
  v_type  TEXT;
BEGIN
  -- 1. All five columns exist, with the intended nullability.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events'
     AND column_name IN ('schema_version','privacy_class','retention_tier','dwell_ms','dwell_kind');
  IF n <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): expected 5 new columns on rank_events, found %.', n;
  END IF;

  SELECT is_nullable INTO v_null FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='schema_version';
  IF v_null <> 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): schema_version must be NOT NULL.';
  END IF;

  SELECT is_nullable INTO v_null FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='privacy_class';
  IF v_null <> 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): privacy_class must be NOT NULL.';
  END IF;

  SELECT is_nullable INTO v_null FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='retention_tier';
  IF v_null <> 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): retention_tier must be NOT NULL.';
  END IF;

  -- 2. dwell_ms must be NULLABLE. Asserted explicitly because a future edit
  --    that "tidied" it to NOT NULL DEFAULT 0 would destroy the measured-zero
  --    vs never-measured distinction §7 depends on, and would do it silently.
  SELECT is_nullable INTO v_null FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='dwell_ms';
  IF v_null <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): dwell_ms must remain NULLABLE. NULL means NOT MEASURED; a NOT NULL dwell_ms would make every unmeasured row claim a measured value and break `04` §7.';
  END IF;

  SELECT is_nullable INTO v_null FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='dwell_kind';
  IF v_null <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): dwell_kind must remain NULLABLE.';
  END IF;

  -- 3. dwell_ms must have NO default, for the same reason.
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events'
     AND column_name='dwell_ms' AND column_default IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): dwell_ms acquired a DEFAULT. It must have none — a default would turn "not measured" into a measurement.';
  END IF;

  -- 4. Every existing row carries the intended defaults, and no row was left
  --    behind by the catalogue-stored default.
  SELECT count(*) INTO n FROM public.rank_events WHERE schema_version IS DISTINCT FROM 1;
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): % existing row(s) do not read schema_version = 1.', n;
  END IF;
  SELECT count(*) INTO n FROM public.rank_events WHERE privacy_class IS DISTINCT FROM 'raw_behavioral_event';
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): % existing row(s) do not read privacy_class = raw_behavioral_event.', n;
  END IF;
  SELECT count(*) INTO n FROM public.rank_events WHERE retention_tier IS DISTINCT FROM 'raw_recent';
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): % existing row(s) do not read retention_tier = raw_recent.', n;
  END IF;

  -- 5. NO EXISTING ROW GAINED A DWELL MEASUREMENT. This is the data-preservation
  --    assertion: the file must not have invented attention data.
  SELECT count(*) INTO n FROM public.rank_events WHERE dwell_ms IS NOT NULL OR dwell_kind IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): % row(s) carry a dwell value after a migration that writes none. A dwell measurement was invented.', n;
  END IF;

  -- 6. The three CHECKs and the pairing CHECK are present.
  FOREACH v_type IN ARRAY ARRAY[
    'rank_events_privacy_class_check',
    'rank_events_retention_tier_check',
    'rank_events_dwell_ms_check',
    'rank_events_dwell_kind_check',
    'rank_events_dwell_pairing_check'
  ] LOOP
    PERFORM 1 FROM pg_constraint c
      JOIN pg_class t     ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname='public' AND t.relname='rank_events' AND c.conname = v_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2890): constraint % is absent.', v_type;
    END IF;
  END LOOP;

  -- 7. The pre-existing thirteen columns are all still there. A migration that
  --    extends a table must never have narrowed it.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events'
     AND column_name IN ('id','user_id','item_id','item_kind','position','features',
                         'outcome','served_at','outcome_at','surface','session_id',
                         'event_type','content_type');
  IF n <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2890): expected the original 13 rank_events columns intact, found %.', n;
  END IF;
END $$;

COMMIT;
