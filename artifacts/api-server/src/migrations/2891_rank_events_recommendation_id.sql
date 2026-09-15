-- 2891_rank_events_recommendation_id.sql
--
-- ⚠ STAGED AND REHEARSED. Applied by the lane that wrote it to portava-ci
--   (hwokxgbmezheskbzskfr) ONLY. NOT applied to production.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Discovery
-- MIGRATIONS lane, band 2890-2899. DEPENDS ON 2890 only for band ordering; the
-- two files touch different columns and apply in either order.
--
-- ADDITIVE. One nullable column, one CHECK, one UNIQUE index. No row is read,
-- written, moved or deleted. No existing insert can start failing — see "WHY
-- THIS CANNOT BREAK AN EXISTING WRITER".
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT — census DV-37 (census-discovery:1383), and DC-33's retry leg
-- ══════════════════════════════════════════════════════════════════════════════
-- DV-37 is `04` §3's "idempotent where retried". The census row states the two
-- acceptable settlements verbatim:
--
--   "a unique index over (user_id, item_id, session_id, served_at) on
--    rank_events, or an idempotency-token column — either is a migration"
--
-- THIS FILE TAKES THE SECOND, and the choice is the substantive decision in it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE TOKEN AND NOT THE FOUR-COLUMN UNIQUE KEY
-- ══════════════════════════════════════════════════════════════════════════════
-- Three reasons, in order of weight.
--
-- 1. THE FOUR-COLUMN KEY CAN FAIL ON PRODUCTION AND I CANNOT CHECK.
--    A UNIQUE index over (user_id, item_id, session_id, served_at) is built
--    over EXISTING ROWS. If production's rank_events holds two rows with that
--    tuple equal — two positions of the same item in one serve, a double-fired
--    client outcome, a replayed batch — the CREATE INDEX fails and the
--    migration aborts. Production has live rows and this lane is forbidden to
--    read it. portava-ci holds ZERO rank_events rows (measured below), so the
--    rehearsal would have proved the index buildable on an empty table and
--    nothing whatever about production. A migration whose success depends on a
--    distribution nobody has measured is not ready to hand to an integration
--    owner.
--
--    The unique index below is over (recommendation_id, outcome), where
--    recommendation_id was JUST CREATED and is NULL on every existing row. In a
--    multi-column unique index a row with NULL in any key column is never equal
--    to any other row (SQL NULLS DISTINCT, which is PostgreSQL's default and is
--    NOT overridden here), so every historical row is unique against every other
--    historical row no matter how many of them there are. The index therefore
--    cannot fail on existing data anywhere, by construction rather than by
--    measurement. This was verified empirically on portava-ci — see "WHAT THE
--    REHEARSAL CHANGED".
--
-- 2. THE FOUR-COLUMN KEY IS WRONG ABOUT session_id. `rank_events.session_id` is
--    NULLABLE (measured: is_nullable = YES on portava-ci, and the same 13-column
--    shape is reported for production). In a UNIQUE index NULLs are DISTINCT, so
--    every row written without a session — which is every row from a writer that
--    does not thread one — would be unique against every other such row and the
--    key would silently guarantee nothing for exactly the rows most likely to be
--    replayed. That is worse than no key: it looks like a guarantee.
--
-- 3. THE TOKEN ALREADY EXISTS AND IS ALREADY COMPUTED. lib/discoveryServeLog.ts
--    :420-424 already derives `recommendationId` for every row it builds, from
--    lib/discoveryRecommendationId.recommendationIdFor — a pure, total,
--    domain-separated sha256 over exactly (userId, sessionId, servedAt, surface,
--    position, itemId), base64url, 22 characters. It is written into
--    `features.recommendationId` (a JSONB key, which no index can arbitrate) and
--    nowhere else. This file gives that value a column and an arbiter. Nothing
--    has to be invented, and the token's derivation is already pinned by
--    lib/discoveryRecommendationId's own tests.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE REHEARSAL CHANGED — why this index is NOT partial
-- ══════════════════════════════════════════════════════════════════════════════
-- The first draft of this file created the index PARTIAL:
--
--     CREATE UNIQUE INDEX … ON public.rank_events (recommendation_id, outcome)
--       WHERE recommendation_id IS NOT NULL;
--
-- which is the obviously cheaper shape: historical and non-token rows would
-- impose no index maintenance at all. Rehearsing the actual retry against
-- portava-ci rejected it outright:
--
--     INSERT INTO public.rank_events (…, recommendation_id) VALUES (…)
--     ON CONFLICT (recommendation_id, outcome) DO NOTHING;
--
--     ERROR:  42P10: there is no unique or exclusion constraint matching the
--             ON CONFLICT specification
--
-- PostgreSQL will only infer a PARTIAL index as a conflict arbiter if the
-- statement REPEATS the index predicate — `ON CONFLICT (recommendation_id,
-- outcome) WHERE recommendation_id IS NOT NULL`. And the writer that has to
-- emit this is supabase-js, whose `onConflict` option takes A COMMA-SEPARATED
-- COLUMN LIST AND NOTHING ELSE: it is rendered by PostgREST into a bare
-- `ON CONFLICT (cols)` with no predicate. There is no spelling of
-- `.insert(rows, { onConflict: … })` that can name a partial index.
--
-- A partial index would therefore have been an idempotency guarantee THAT THE
-- ONLY WRITER IN THIS CODEBASE CANNOT INVOKE — the insert would fail 42P10,
-- the fire-and-forget handler would logger.warn, and the serve log would go
-- dark. That is a worse outcome than having no index, because it looks like a
-- guarantee. The index is full, and the cost of carrying the NULL rows is the
-- price of an arbiter the writer can actually name.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE UNIQUE KEY IS (recommendation_id, outcome) AND NOT recommendation_id
-- ══════════════════════════════════════════════════════════════════════════════
-- This is the correctness point that a naive single-column unique index gets
-- wrong, and it would get it wrong SILENTLY, months later.
--
-- rank_events records an exposure and its outcomes as SEPARATE ROWS on the same
-- item: routes/rankEvents.ts POST /rank-events/outcome inserts a NEW row
-- (outcome='tap'/'save'/…) rather than updating the impression row. The
-- impression row and the outcome row describe THE SAME EXPOSURE and would carry
-- THE SAME recommendation_id the moment a writer threads it through — that is
-- the entire point of a recommendation id, and `04` §10.6 explicitly asks for
-- "recommendation_id propagation" to be tested.
--
-- A UNIQUE(recommendation_id) would therefore reject the outcome row. The
-- outcome insert is fire-and-forget with a logger.warn, so the rejection would
-- be invisible and Portava would lose every tap and save it managed to attribute
-- — the exact silent-blackout failure class 2298 and 0202 were written against.
--
-- The correct grain of "idempotent where retried" is ONE ROW PER (EXPOSURE,
-- OUTCOME KIND):
--   (rec_id, 'impression') retried   → conflict → dedupe   ← what DV-37 wants
--   (rec_id, 'tap') after impression → distinct  → stored  ← what the funnel wants
--   (rec_id, 'tap') retried          → conflict → dedupe   ← a bonus, correctly
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS CANNOT BREAK AN EXISTING WRITER
-- ══════════════════════════════════════════════════════════════════════════════
-- Every insert in the tree omits `recommendation_id`. An omitted column takes
-- its default, which is NULL, and a unique index NEVER MATCHES TWO NULLS
-- (NULLS DISTINCT, PostgreSQL's default, not overridden here). So every writer
-- that works today writes exactly what it wrote yesterday and is arbitrated by
-- nothing — the index carries its row as a (NULL, outcome) entry that can
-- collide with nothing. The index only begins to BIND when a writer starts
-- supplying the token, which is a deliberate, reviewable code change.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED BEFORE WRITING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- portava-ci `hwokxgbmezheskbzskfr`, 2026-09-14:
--   rank_events                                     0 rows
--   rank_events.session_id                          uuid, NULLABLE
--   rank_events.user_id                             uuid, NOT NULL
--   rows where features ? 'recommendationId'        0   (no rows at all)
--   existing rank_events indexes                    no unique index on any
--                                                   subset of the serve tuple
-- Production was NOT read by this lane. The integration owner's reading of the
-- same day reports the same thirteen columns WITH live rows; the design above
-- is what makes that difference irrelevant to whether this file can apply.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- `10` §4 — EXPECTED CARDINALITY · INDEX RATIONALE · EXPLAIN (census DC-15)
-- ══════════════════════════════════════════════════════════════════════════════
-- EXPECTED CARDINALITY of rank_events_recommendation_idempotency_idx:
--   EXACTLY ONE ENTRY PER rank_events ROW — the index is not partial, so its
--   cardinality equals the table's, and its size grows with the table's. That
--   is the cost accepted in "WHAT THE REHEARSAL CHANGED".
--   Of those entries, the ARBITRATING ones — the (non-NULL, outcome) pairs that
--   can actually collide — number zero today, because no producer writes the
--   column. At steady state, once lib/discoveryServeLog threads the token: one
--   per served item per impression (the exposure denominator), plus one per
--   attributed outcome. Every other entry is a (NULL, outcome) pair that
--   arbitrates nothing.
--
-- INDEX RATIONALE — three jobs, all of which need this exact index:
--   (a) It is the CONFLICT ARBITER. `ON CONFLICT (recommendation_id, outcome)`
--       requires a unique index on precisely those columns with precisely this
--       predicate; without it PostgreSQL raises 42P10 and the insert fails.
--       This index IS the idempotency guarantee, not an accelerant for it.
--   (b) It answers `04` §10.6 recommendation_id propagation lookups —
--       "give me every row for this exposure" — as an index scan.
--   (c) NOT PARTIAL, deliberately — see "WHAT THE REHEARSAL CHANGED". The
--       cheaper partial form cannot be named by supabase-js's `onConflict`, so
--       it could not do job (a) at all. Historical and non-token rows enter the
--       index as (NULL, outcome) entries, each unique against every other by
--       NULLS DISTINCT; that is the accepted cost of an arbiter the writer can
--       invoke.
--
-- EXPLAIN VERIFICATION, run on portava-ci after applying this file:
--
--   EXPLAIN SELECT * FROM public.rank_events
--    WHERE recommendation_id = 'AAAAAAAAAAAAAAAAAAAAAA' AND outcome = 'impression';
--
--   Index Scan using rank_events_recommendation_idempotency_idx on rank_events
--     (cost=0.27..2.49 rows=1 width=304)
--     Index Cond: ((recommendation_id = 'AAAAAAAAAAAAAAAAAAAAAA'::text)
--                  AND (outcome = 'impression'::text))
--
--   The lookup is an INDEX SCAN on BOTH key columns, not a filter over a
--   sequential scan, which is what makes (a) and (b) above true rather than
--   hoped for. Taken with enable_seqscan = off so the planner could not prefer a
--   sequential scan of a small heap on cost alone: the claim being verified is
--   that the index is USABLE for this path, which is what ON CONFLICT
--   inference depends on. portava-ci held 239 rank_events rows at the time, all
--   seeded by this lane, so the COST AND ROW ESTIMATES are not evidence about
--   production's cardinality and no claim is made from them.
--
--   THE ARBITER WAS ALSO VERIFIED BEHAVIOURALLY, which matters more than the
--   plan (portava-ci, same session, full transcript in the runbook):
--     first insert with a token                                   → 1 row
--     same insert again, ON CONFLICT (recommendation_id, outcome)  → 0 rows
--     same insert again with NO ON CONFLICT                        → 23505
--     a 'tap' row carrying the SAME token                          → 1 row
--   The last line is the one a single-column unique key would have failed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT BUY — DV-37 IS NOT CLOSED BY THIS FILE
-- ══════════════════════════════════════════════════════════════════════════════
-- After this file lands, lib/discoveryServeLog.ts:444 is STILL a bare
-- `.insert(rows)` with no `onConflict` and no column write, so a retried batch
-- would still double-insert. A unique index is the half a migration can supply;
-- the other half is two lines in the writer:
--
--   recommendation_id: recommendationIdFor({…})      (in the row literal)
--   .upsert(rows, { onConflict: "recommendation_id,outcome", ignoreDuplicates: true })
--
-- and `onConflict` must name BOTH columns in that order. A bare
-- `onConflict: "recommendation_id"` raises 42P10 against this index, which the
-- fire-and-forget handler would only warn about.
--
-- Those belong to the Discovery instrumentation lane and are NOT made here.
-- Note further what the DV-37 census row says next: "no retry path exists today
-- — the writer is called once, void, after the response". So the clause is
-- currently unexercised as well as unimplemented, and DC-33's failing "retry"
-- leg (census-discovery:1926) cannot be tested until a retry path exists. The
-- honest verdict move this file supports is DV-37 N→W, not N→C. Graded by the
-- integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY — fully, cheaply, with no data loss
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   DROP INDEX IF EXISTS public.rank_events_recommendation_idempotency_idx;
--   ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_recommendation_id_shape_check;
--   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS recommendation_id;
--   COMMIT;
--
-- Nothing writes the column as of this file, so the DROP destroys no value.
-- EXPIRY CONDITION: once the writer above ships, dropping the column destroys
-- the only durable copy of the exposure token and REMOVES the idempotency
-- guarantee — a retry would then double-insert again. After that point the
-- reversal is a behaviour change, not a rollback. Reverse before the writer
-- ships, or not at all.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- LOCKING — the one production cost, stated plainly
-- ══════════════════════════════════════════════════════════════════════════════
-- CREATE INDEX (non-concurrent) takes a SHARE lock on rank_events: concurrent
-- SELECTs proceed, concurrent INSERTs BLOCK until it completes. Because the
-- index is NOT partial it is built over EVERY row of rank_events, so the build
-- time is proportional to production's row count — this is the real cost the
-- partial form would have avoided, and it is accepted because the partial form
-- does not work (see "WHAT THE REHEARSAL CHANGED"). rank_events writes are all
-- fire-and-forget and tolerate a brief block, but the size of that block was NOT
-- measured by this lane: portava-ci holds zero rows, so the rehearsal says
-- nothing about it. IF PRODUCTION rank_events IS LARGE, USE THE CONCURRENTLY
-- VARIANT IN THE RUNBOOK.
--
-- The runbook gives a CONCURRENTLY variant for exactly that case. It CANNOT be used from inside this
-- file — CREATE INDEX CONCURRENTLY may not run in a transaction block, and this
-- file must be transactional so a failed index cannot leave a committed column
-- with no arbiter. See docs/architecture/manual-production-migration-runbook.md,
-- "2891 — large-table variant".

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_type TEXT;
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2891): public.rank_events does not exist. Apply 0153_add_rank_events.sql first.';
  END IF;

  -- `outcome` is half the unique key, so its absence would make the arbiter
  -- undefinable.
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='outcome';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2891): rank_events.outcome is missing — it is half this file''s unique key.';
  END IF;

  -- If the column already exists it must be text, or the index this file names
  -- would be built over somebody else''s design.
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='recommendation_id';
  IF v_type IS NOT NULL AND v_type <> 'text' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2891): rank_events.recommendation_id already exists as % (expected text). Another migration defined it differently; resolve by hand.', v_type;
  END IF;

  -- REFUSE TO RUN IF A CONFLICTING UNIQUE KEY ALREADY EXISTS on the serve tuple.
  -- If some other lane took the four-column route, adding a second arbiter would
  -- give the table two different definitions of "the same exposure".
  PERFORM 1
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
   WHERE i.indrelid = 'public.rank_events'::regclass
     AND i.indisunique
     AND ic.relname <> 'rank_events_pkey'
     AND ic.relname <> 'rank_events_recommendation_idempotency_idx';
  IF FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2891): rank_events already carries a non-primary UNIQUE index. Two arbiters would mean two definitions of "the same exposure"; inspect it before applying 2891.';
  END IF;
END $$;

-- ── The idempotency token ────────────────────────────────────────────────────
ALTER TABLE public.rank_events
  ADD COLUMN IF NOT EXISTS recommendation_id text;

-- Shape check, mirroring lib/discoveryRecommendationId.recommendationIdFor:
-- sha256 → base64url → first 22 characters, so the alphabet is [A-Za-z0-9_-]
-- and the length is exactly 22. This is a CHEAP, HIGH-VALUE guard: it makes it
-- impossible for a writer to store a raw uuid, a client-supplied string, or —
-- the failure this is really aimed at — a value that is NOT domain-separated and
-- would therefore collide with a digest computed somewhere else over the same
-- six fields. NULL is always permitted; that is the historical state.
ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_recommendation_id_shape_check;
ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_recommendation_id_shape_check
  CHECK (recommendation_id IS NULL OR recommendation_id ~ '^[A-Za-z0-9_-]{22}$');

COMMENT ON COLUMN public.rank_events.recommendation_id IS
  '`04` §3 "idempotent where retried" / census DV-37. The opaque exposure token '
  'from lib/discoveryRecommendationId.recommendationIdFor — a domain-separated '
  'sha256 over (userId, sessionId, servedAt, surface, position, itemId), '
  'base64url, 22 chars. It is the CONFLICT ARBITER for retried event writes, '
  'paired with `outcome` so that an impression row and its tap/save rows share '
  'one token without colliding. NULL is the historical state and is never '
  'arbitrated. As of migration 2891 NOTHING writes this column: '
  'lib/discoveryServeLog.ts:422 computes the same value and writes it into '
  'features.recommendationId only, and its insert has no onConflict. Supplying '
  'the column and the onConflict clause is the code half of DV-37.';

-- ── The arbiter ──────────────────────────────────────────────────────────────
-- NOT PARTIAL — see "WHAT THE REHEARSAL CHANGED" in the header. Cannot fail on
-- existing data: recommendation_id is NULL on every pre-2891 row and NULLS are
-- DISTINCT in a unique index, so no two historical rows can collide however many
-- there are.
CREATE UNIQUE INDEX IF NOT EXISTS rank_events_recommendation_idempotency_idx
  ON public.rank_events (recommendation_id, outcome);

COMMENT ON INDEX public.rank_events_recommendation_idempotency_idx IS
  'Census DV-37. The ON CONFLICT (recommendation_id, outcome) arbiter — without '
  'this index that clause raises 42P10 and the insert fails, so the index IS '
  'the idempotency guarantee rather than an optimisation of it. Keyed on the '
  'OUTCOME too because rank_events stores an exposure and each of its outcomes '
  'as separate rows sharing one token (routes/rankEvents.ts inserts a new row '
  'per outcome); a single-column unique key would silently reject every tap and '
  'save. DELIBERATELY NOT PARTIAL: PostgreSQL only infers a partial index as an '
  'ON CONFLICT arbiter when the statement repeats the predicate, and '
  'supabase-js''s onConflict option takes a bare column list, so a partial index '
  'here would be an idempotency guarantee the only writer cannot name (42P10). '
  'Pre-2891 rows enter it as (NULL, outcome), each unique by NULLS DISTINCT.';

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  n       INT;
  v_null  TEXT;
  v_pred  BOOLEAN;
  v_uniq  BOOLEAN;
  v_cols  INT;
BEGIN
  -- 1. Column exists, is text, and is NULLABLE. Nullability is asserted because
  --    a NOT NULL recommendation_id would reject every insert from every
  --    existing writer — all of which omit it — and would do so as a 23502 that
  --    the fire-and-forget handlers only warn about.
  SELECT is_nullable INTO v_null FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='recommendation_id';
  IF v_null IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): rank_events.recommendation_id was not created.';
  END IF;
  IF v_null <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): recommendation_id must remain NULLABLE — every existing writer omits it, and NOT NULL would reject them all.';
  END IF;

  -- 2. NO EXISTING ROW WAS GIVEN A TOKEN. The data-preservation assertion in the
  --    other direction: this file must not have back-derived an id for history.
  --    Doing so would assert that two historical rows are "the same exposure"
  --    on the strength of a hash nobody witnessed being computed at serve time.
  SELECT count(*) INTO n FROM public.rank_events WHERE recommendation_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): % row(s) carry a recommendation_id after a migration that writes none.', n;
  END IF;

  -- 3. The shape CHECK exists.
  PERFORM 1 FROM pg_constraint c
    JOIN pg_class t      ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE ns.nspname='public' AND t.relname='rank_events'
     AND c.conname='rank_events_recommendation_id_shape_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): rank_events_recommendation_id_shape_check is absent.';
  END IF;

  -- 4. The index exists, is UNIQUE, is NOT PARTIAL, and covers exactly two
  --    columns. All three properties are load-bearing and each is asserted
  --    separately, so a future edit that quietly changes one fails here:
  --      not unique  → no arbiter at all
  --      partial     → supabase-js's bare-column-list onConflict cannot name it
  --                    and every insert raises 42P10 (this is not theoretical:
  --                    it is what the portava-ci rehearsal hit)
  --      one column  → every outcome row is rejected (see the header)
  SELECT i.indisunique,
         (i.indpred IS NOT NULL),
         i.indnatts
    INTO v_uniq, v_pred, v_cols
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace ns ON ns.oid = ic.relnamespace
   WHERE ns.nspname='public' AND ic.relname='rank_events_recommendation_idempotency_idx';

  IF v_uniq IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): rank_events_recommendation_idempotency_idx was not created.';
  END IF;
  IF NOT v_uniq THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): the idempotency index is not UNIQUE, so it cannot arbitrate ON CONFLICT.';
  END IF;
  IF v_pred THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): the idempotency index is PARTIAL. PostgreSQL will not infer a partial index as an ON CONFLICT arbiter unless the statement repeats the predicate, and supabase-js''s onConflict takes a bare column list — a partial index here makes every idempotent insert fail 42P10.';
  END IF;
  IF v_cols <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): the idempotency index covers % column(s); it must cover exactly (recommendation_id, outcome). A single-column key silently rejects every outcome row that shares a token with its impression.', v_cols;
  END IF;

  -- 5. The shape CHECK actually rejects a badly shaped token. Asserted
  --    behaviourally rather than by reading the definition string, because a
  --    regex that was accidentally loosened would still read plausibly.
  BEGIN
    INSERT INTO public.rank_events (id, user_id, item_id, features, outcome, served_at, surface, recommendation_id)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'postcondition-probe',
            '{}'::jsonb, 'impression', now(), 'discovery', 'not-a-valid-token');
    RAISE EXCEPTION 'POSTCONDITION FAILED (2891): a malformed recommendation_id was accepted by the shape CHECK.';
  EXCEPTION
    WHEN check_violation THEN
      NULL;  -- correct: the shape CHECK rejected it
    WHEN foreign_key_violation OR not_null_violation THEN
      -- The probe never reached the CHECK (user_id FK to auth.users). Do not
      -- claim the CHECK works on evidence that does not bear on it.
      RAISE WARNING 'POSTCONDITION (2891): shape-CHECK probe could not reach the constraint (blocked by an FK/NOT NULL first). The CHECK''s presence is still asserted structurally above.';
  END;
END $$;

COMMIT;
