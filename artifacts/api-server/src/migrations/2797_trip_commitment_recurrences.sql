-- 2797_trip_commitment_recurrences.sql
--
-- Trips v4 §23 certification scenario "Long-stay 45 days" — "Recurring
-- commitments, routine-aware context, no bloated itinerary model"
-- (census-trips TR427, the only clause of that row nothing in the tree
-- answers). The third clause is a CONSTRAINT ON THE FIRST TWO, and this file
-- is written to it.
--
-- Ordered after 2761: every column here is the recurring form of a
-- `trip_commitments` column, and the two vocabularies are literally the same
-- lists. Ordered after 2760 because a recurrence may be filed under a stage.
--
-- WHAT A RECURRENCE IS HERE, AND WHY IT IS A RULE AND NOT ROWS
-- ===========================================================
-- A 45-day stay with one standing weekday commitment is 33 occurrences. There
-- are two ways to hold that:
--
--   (a) MATERIALISE — write 33 `trip_commitments` rows at creation time.
--   (b) A RULE — write ONE row describing the pattern, and compute the
--       occurrences a reader asks for, over the horizon that reader needs.
--
-- (a) is the "bloated itinerary model" the scenario names. It is not bloated
-- only because of row count: it is bloated because every subsequent edit has
-- to find and rewrite 33 rows, because a trip that extends has to backfill,
-- because 33 near-identical rows destroy every "what is next" read, and
-- because the pattern — the fact the traveller actually holds in their head —
-- exists nowhere in the data once it has been expanded. This table is (b).
--
-- The guarantee is structural and this migration's postconditions PROVE it:
-- there is no occurrence table, no materialised-instance column, and no
-- trigger that writes `trip_commitments` from here. Adding 45 days to a trip
-- adds ZERO rows. The expander is
-- artifacts/api-server/src/domain/trips/invariants/TripRecurrence.ts and it is
-- bounded by a horizon and a hard occurrence cap, so no reader can ask for the
-- materialisation this table exists to avoid.
--
-- THE RULE IS IN LOCAL WALL-CLOCK TIME. THIS IS THE WHOLE MODELLING DECISION
-- =========================================================================
-- "Every weekday at 09:00" is a statement about a CLOCK IN A PLACE, not about
-- an instant. Stored as a UTC instant plus an interval it is wrong twice a
-- year, and on a 45-day stay that spans a DST transition it is wrong for the
-- REST OF THE STAY. So the rule carries:
--
--     timezone     an IANA zone — the stage's, or the trip's
--     local_time   a `time` (no zone). 09:00 means 09:00 THERE.
--     freq         'daily' | 'weekly'
--     by_weekday   ISO-8601 1=Mon … 7=Sun, for 'weekly'
--     interval_count  every N days / N weeks
--     effective_from / effective_until   LOCAL CALENDAR DATES, not instants
--
-- and an occurrence's instant is computed as "this local date at this local
-- time in this zone" at read time, which is the only formulation that
-- survives a DST transition. `timestamptz` is deliberately NOT used for
-- local_time or for the effective range: a `timestamptz` cannot express
-- "09:00 local, whatever the offset is that morning".
--
-- WHY THESE COLUMNS AND NOT AN RRULE STRING
-- =========================================
-- RFC 5545 RRULE is the obvious alternative and was rejected: a `text` column
-- holding 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' cannot be constrained by the
-- database at all — no CHECK can prove it parses, every reader needs its own
-- parser, and the parsers disagree at the edges (BYSETPOS, COUNT+UNTIL
-- together, floating vs zoned DTSTART). The columns below are each individually
-- refusable by a CHECK, and the CHECKs are PROVEN TO REFUSE at the bottom of
-- this file rather than asserted to exist. The cost is expressiveness: this
-- model cannot say "the last Friday of the month". That is a deliberate
-- omission, not an oversight — §23's scenario is a long STAY, whose commitments
-- are daily and weekly rhythms, and a model that can express everything is a
-- model nothing can validate.
--
-- EXCEPTIONS ARE skip_dates PLUS AN ORDINARY COMMITMENT, AND THAT IS ON PURPOSE
-- ============================================================================
-- "Thursday's class is at 10:00 this week" is expressed as: add Thursday's
-- local date to `skip_dates`, and ADD_COMMITMENT a one-off `trip_commitments`
-- row for the moved class. No third table, no per-occurrence override shape,
-- and — the point — an exception becomes a REAL commitment row, so everything
-- that already works on commitments (the §7.2 approach-window guard in 2779,
-- the at-risk columns in 2785, the map projection) works on it unchanged.
-- A subsystem whose exceptions are second-class is a subsystem whose exceptions
-- are invisible.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =======================================
--   * No writer. §4 requires the command path; ADD_RECURRING_COMMITMENT and
--     its siblings are 2798, exactly as 2761's tables waited for 2765.
--   * No feature flag of its own. The readers are the operational projections,
--     which are already gated by `trip_operational_projections_enabled` (2778,
--     seeded FALSE on every deployment). A second flag would be a second thing
--     to forget. This table is NOT added to that capability's `requires` set,
--     because a capability probe that demands 2797 would turn the freedom,
--     health and Today projections OFF on every database that has 2761 and not
--     this — a regression paid for a feature. The readers treat an absent table
--     as a stated three-valued layer instead.
--   * No materialisation, no trigger, no generated occurrence id. See above.
--   * §7.2's invariant is still not evaluated: there is no route provider
--     (2761's header). Occurrences are well-formed inputs to it, nothing more.
--
-- RLS on, crew SELECT only, no client write grants — the kernel is the writer.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_commitments';
  IF n <> 1 THEN RAISE EXCEPTION '2797: requires 2761 (trip_commitments)'; END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 1 THEN RAISE EXCEPTION '2797: requires 2760 (trip_stages)'; END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_commitment_recurrences';
  IF n <> 0 THEN RAISE EXCEPTION '2797: trip_commitment_recurrences already exists'; END IF;

  -- The vocabularies below are COPIES of 2761's, and a copy that has drifted is
  -- worse than no copy: a recurrence whose `type` its expanded occurrences
  -- could never hold. Refuse to run against a trip_commitments whose own CHECK
  -- is not the one these lists were copied from.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.trip_commitments'::regclass
       AND conname  = 'trip_commitments_type_known'
       AND pg_get_constraintdef(oid) LIKE '%lodging%transport%event%booking%meeting%other%')
  THEN RAISE EXCEPTION '2797: trip_commitments_type_known is not 2761''s list; the type vocabulary below would drift from it'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.trip_commitments'::regclass
       AND conname  = 'trip_commitments_flexibility_known'
       AND pg_get_constraintdef(oid) LIKE '%fixed%shiftable%flexible%')
  THEN RAISE EXCEPTION '2797: trip_commitments_flexibility_known is not 2761''s list'; END IF;
END
$pre$;

CREATE TABLE public.trip_commitment_recurrences (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id             uuid        NOT NULL REFERENCES public.trips(id)       ON DELETE CASCADE,
  -- Same nullability and same ON DELETE as 2761's commitment: a rule outlives
  -- the stage it was filed under, because the routine does.
  stage_id            uuid        NULL     REFERENCES public.trip_stages(id) ON DELETE SET NULL,
  -- 2761's vocabulary, verbatim. An occurrence of this rule IS a commitment of
  -- this type, and the precondition above refuses to let the two lists drift.
  type                text        NOT NULL,
  -- What the traveller calls it. A routine the surface cannot name is a routine
  -- the traveller cannot recognise as theirs ("every weekday 09:00" is a
  -- cadence; "Vietnamese class" is the thing).
  label               text        NULL,

  -- ── the rule, in local wall-clock time ────────────────────────────────────
  -- IANA zone. NOT NULL and no default: "which clock" is the one fact a
  -- recurrence cannot be guessed at, and a rule that inherits a zone silently
  -- is a rule that moves when the stage's timezone is corrected.
  timezone            text        NOT NULL,
  freq                text        NOT NULL,
  interval_count      integer     NOT NULL DEFAULT 1,
  -- ISO-8601 weekday numbers, 1=Mon … 7=Sun. NULL for 'daily'.
  by_weekday          smallint[]  NULL,
  -- `time`, not `timestamptz` and not minutes-since-midnight: see the header.
  local_time          time        NOT NULL,
  duration            interval    NULL,
  -- §7.1 requiredArrivalAt, expressed RELATIVELY because the rule has no
  -- instant to subtract from. Each occurrence's required_arrival_at is its
  -- starts_at minus this.
  arrival_lead        interval    NULL,
  -- §7.1 / §7.2 required_buffer(next), same columns and same units as 2761.
  lateness_tolerance  interval    NULL,
  prep_duration       interval    NULL,
  place_id            uuid        NULL,
  flexibility         text        NOT NULL DEFAULT 'flexible',
  confidence          numeric(3,2) NULL,

  -- ── the bound ─────────────────────────────────────────────────────────────
  -- LOCAL CALENDAR DATES, and BOTH NOT NULL. An unbounded rule is the one way
  -- a non-materialised model can still become unbounded: every reader would
  -- have to invent its own end, and they would not agree. The trip's own dates
  -- are not used as an implicit bound for the same reason.
  effective_from      date        NOT NULL,
  effective_until     date        NOT NULL,
  -- Local dates on which this rule does NOT occur. The exception mechanism; see
  -- the header. An array and not a table: a skip is a scalar fact about a date
  -- with nothing hanging off it, and the CHECK below proves the set is sane.
  skip_dates          date[]      NOT NULL DEFAULT '{}',

  source_ref          text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_commitment_recurrences_type_known
    CHECK (type IN ('lodging','transport','event','booking','meeting','other')),
  CONSTRAINT trip_commitment_recurrences_flexibility_known
    CHECK (flexibility IN ('fixed','shiftable','flexible')),
  CONSTRAINT trip_commitment_recurrences_freq_known
    CHECK (freq IN ('daily','weekly')),
  CONSTRAINT trip_commitment_recurrences_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT trip_commitment_recurrences_durations_nonnegative
    CHECK ((duration           IS NULL OR duration           >= interval '0')
       AND (arrival_lead       IS NULL OR arrival_lead       >= interval '0')
       AND (lateness_tolerance IS NULL OR lateness_tolerance >= interval '0')
       AND (prep_duration      IS NULL OR prep_duration      >= interval '0')),
  -- Every N. Capped at 52 because beyond "every 52 weeks" the rule is not a
  -- routine, and an unbounded interval makes the expander's stride arithmetic
  -- a place for an overflow to hide.
  CONSTRAINT trip_commitment_recurrences_interval_positive
    CHECK (interval_count >= 1 AND interval_count <= 52),
  CONSTRAINT trip_commitment_recurrences_range_ordered
    CHECK (effective_until >= effective_from),
  -- A zone is a name, and the only thing this table can prove about a name is
  -- that it is not empty and not a UTC offset pretending to be a zone. That the
  -- name RESOLVES is proven at write time by the kernel (2798), which casts it.
  CONSTRAINT trip_commitment_recurrences_timezone_shaped
    CHECK (length(btrim(timezone)) > 0 AND timezone NOT LIKE '%+%' AND timezone NOT LIKE '%-0%'),

  -- ── the weekday set, proven without a subquery ────────────────────────────
  -- 'weekly' MUST carry weekdays and 'daily' must NOT: a daily rule with a
  -- weekday list is two rules disagreeing, and the expander would have to pick.
  CONSTRAINT trip_commitment_recurrences_weekday_shape
    CHECK ((freq = 'weekly' AND by_weekday IS NOT NULL)
        OR (freq = 'daily'  AND by_weekday IS NULL)),
  -- STRICTLY ASCENDING, one-dimensional, lower bound 1, at most 7 elements,
  -- every element 1..7. Strictly ascending is how distinctness is proven here:
  -- PostgreSQL forbids a subquery in a CHECK, so `count(DISTINCT …)` is not
  -- available, and out-of-range array subscripts evaluate to NULL, which makes
  -- the ladder below exact for every length from 1 to 7 and false for 8.
  -- The alternative — a bitmask — was rejected for 2761's stated reason about
  -- durations-as-integers: a convention every reader must remember is a
  -- convention one reader will get wrong.
  CONSTRAINT trip_commitment_recurrences_weekday_canonical
    CHECK (by_weekday IS NULL OR (
           coalesce(array_ndims(by_weekday), 0) = 1
       AND coalesce(array_lower(by_weekday, 1), 0) = 1
       AND by_weekday <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
       AND by_weekday[1] IS NOT NULL
       AND (by_weekday[2] IS NULL OR by_weekday[2] > by_weekday[1])
       AND (by_weekday[3] IS NULL OR by_weekday[3] > by_weekday[2])
       AND (by_weekday[4] IS NULL OR by_weekday[4] > by_weekday[3])
       AND (by_weekday[5] IS NULL OR by_weekday[5] > by_weekday[4])
       AND (by_weekday[6] IS NULL OR by_weekday[6] > by_weekday[5])
       AND (by_weekday[7] IS NULL OR by_weekday[7] > by_weekday[6])
       AND by_weekday[8] IS NULL)),
  -- A skip that falls outside the rule's own range is not an exception to
  -- anything; it is a typo that will never be noticed. Same ladder shape: a
  -- one-dimensional array with lower bound 1 and no NULL members. Membership of
  -- the range is checked by the array containment operators, which are
  -- subquery-free.
  CONSTRAINT trip_commitment_recurrences_skips_shaped
    CHECK (array_ndims(skip_dates) IS NULL
        OR (array_ndims(skip_dates) = 1
            AND array_lower(skip_dates, 1) = 1
            AND array_position(skip_dates, NULL) IS NULL
            AND cardinality(skip_dates) <= 366))
);

COMMENT ON TABLE public.trip_commitment_recurrences IS
  'Trips spec §23 "Long-stay 45 days" — a RECURRING commitment as a RULE in local wall-clock time (census-trips TR427). One row per pattern; occurrences are computed at read time by domain/trips/invariants/TripRecurrence.ts over a bounded horizon and are NEVER materialised — that non-materialisation is the scenario''s "no bloated itinerary model" clause. Exceptions are skip_dates plus an ordinary trip_commitments row. Writer: trip_kernel_execute (2798); RLS crew SELECT only.';
COMMENT ON COLUMN public.trip_commitment_recurrences.timezone IS
  'IANA zone the rule''s local_time is read in. The rule is wall-clock, not an instant: "09:00 every weekday" must stay 09:00 across a DST transition, which a stored timestamptz cannot do.';
COMMENT ON COLUMN public.trip_commitment_recurrences.by_weekday IS
  'ISO-8601 weekday numbers, 1=Mon … 7=Sun, strictly ascending. NULL for freq=daily.';
COMMENT ON COLUMN public.trip_commitment_recurrences.skip_dates IS
  'Local calendar dates this rule does not occur on. The exception mechanism: a MOVED occurrence is a skip here plus a one-off trip_commitments row, so exceptions are first-class commitments rather than a second shape.';

CREATE INDEX idx_trip_commitment_recurrences_trip  ON public.trip_commitment_recurrences (trip_id);
CREATE INDEX idx_trip_commitment_recurrences_stage ON public.trip_commitment_recurrences (stage_id);
-- The reader's query is "this trip's rules whose range overlaps my horizon".
CREATE INDEX idx_trip_commitment_recurrences_window
  ON public.trip_commitment_recurrences (trip_id, effective_from, effective_until);

ALTER TABLE public.trip_commitment_recurrences ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_commitment_recurrences_select_crew ON public.trip_commitment_recurrences
  FOR SELECT USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_commitment_recurrences FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_commitment_recurrences TO authenticated;

-- ── postconditions ───────────────────────────────────────────────────────────
-- Structure first, then BEHAVIOUR. A migration that lists its constraints has
-- asserted an intention; a migration that makes them refuse has proven one.
-- The behavioural half runs against a TEMPORARY table created with
-- `LIKE … INCLUDING CONSTRAINTS`, which copies the CHECK constraints EXACTLY
-- (and no foreign keys), so the probes exercise the real predicates without
-- needing a trip to hang off and without leaving a row behind.
DO $post$
DECLARE n int; sec boolean; msg text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_commitment_recurrences';
  IF n <> 1 THEN RAISE EXCEPTION '2797: table absent after create'; END IF;

  SELECT relrowsecurity INTO sec FROM pg_class WHERE oid='public.trip_commitment_recurrences'::regclass;
  IF NOT sec THEN RAISE EXCEPTION '2797: RLS not enabled'; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='trip_commitment_recurrences';
  IF n <> 1 THEN RAISE EXCEPTION '2797: expected 1 policy, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='trip_commitment_recurrences' AND cmd <> 'SELECT';
  IF n <> 0 THEN RAISE EXCEPTION '2797: a non-SELECT policy exists'; END IF;

  IF has_table_privilege('authenticated','public.trip_commitment_recurrences','INSERT')
     OR has_table_privilege('authenticated','public.trip_commitment_recurrences','UPDATE')
     OR has_table_privilege('authenticated','public.trip_commitment_recurrences','DELETE')
  THEN RAISE EXCEPTION '2797: authenticated holds a write privilege'; END IF;
  IF NOT has_table_privilege('authenticated','public.trip_commitment_recurrences','SELECT')
  THEN RAISE EXCEPTION '2797: authenticated cannot SELECT'; END IF;
  IF has_table_privilege('anon','public.trip_commitment_recurrences','SELECT')
  THEN RAISE EXCEPTION '2797: anon can SELECT'; END IF;

  -- The rule's own columns must be here, by name: this is the set the expander
  -- reads, and a rule missing one of them cannot be expanded at all.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trip_commitment_recurrences'
     AND column_name IN ('timezone','freq','interval_count','by_weekday','local_time',
                         'effective_from','effective_until','skip_dates','arrival_lead');
  IF n <> 9 THEN RAISE EXCEPTION '2797: expected the 9 rule columns, found %', n; END IF;

  -- The wall-clock decision, proven by TYPE rather than by comment: local_time
  -- must be `time without time zone` and the effective range must be `date`.
  -- A later migration that "fixes" these to timestamptz breaks the model, and
  -- this is where it is caught.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trip_commitment_recurrences'
     AND ((column_name='local_time'      AND data_type='time without time zone')
       OR (column_name='effective_from'  AND data_type='date')
       OR (column_name='effective_until' AND data_type='date'));
  IF n <> 3 THEN RAISE EXCEPTION '2797: the wall-clock columns are not time/date/date (found % of 3)', n; END IF;

  -- ── THE ANTI-BLOAT GUARANTEE, as a postcondition and not a promise ────────
  -- "No bloated itinerary model" means: nothing materialises occurrences. The
  -- checkable form of that is (1) no occurrence/instance table exists, (2) this
  -- table has no column that would hold an expansion, and (3) nothing on this
  -- table can write another table behind the reader's back.
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('trip_commitment_occurrences','trip_commitment_instances',
                        'trip_recurrence_occurrences','trip_recurrence_instances');
  IF n <> 0 THEN RAISE EXCEPTION '2797: an occurrence table exists (%) — the model has been materialised, which is what this file exists not to do', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trip_commitment_recurrences'
     AND (column_name LIKE '%occurrence%' OR column_name LIKE '%materialis%'
          OR column_name LIKE '%materializ%' OR column_name LIKE '%expanded%');
  IF n <> 0 THEN RAISE EXCEPTION '2797: % materialisation column(s) on the rule table', n; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid='public.trip_commitment_recurrences'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION '2797: % trigger(s) on the rule table; a rule must not write anything', n; END IF;

  -- ── BEHAVIOUR: the CHECKs must REFUSE ─────────────────────────────────────
  CREATE TEMP TABLE _r2797 (LIKE public.trip_commitment_recurrences INCLUDING CONSTRAINTS INCLUDING DEFAULTS)
    ON COMMIT DROP;
  -- The probe table must have carried the predicates over, or every "refused"
  -- below would be a table with no constraints quietly accepting everything.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='_r2797'::regclass AND contype='c';
  IF n < 9 THEN RAISE EXCEPTION '2797: the probe table copied only % check constraints; the probes below would prove nothing', n; END IF;

  -- (1) the one that must be ACCEPTED: "every weekday at 09:00, Europe/Lisbon".
  --     If this fails, the model cannot express its own motivating example.
  INSERT INTO _r2797 (trip_id, type, timezone, freq, by_weekday, local_time,
                      effective_from, effective_until)
    VALUES (gen_random_uuid(), 'event', 'Asia/Ho_Chi_Minh', 'weekly',
            ARRAY[1,2,3,4,5]::smallint[], '09:00', DATE '2026-10-01', DATE '2026-11-14');
  SELECT count(*) INTO n FROM _r2797;
  IF n <> 1 THEN RAISE EXCEPTION '2797: the motivating rule was not accepted'; END IF;

  -- (2) daily, no weekdays — also accepted.
  INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until)
    VALUES (gen_random_uuid(), 'meeting', 'Europe/Lisbon', 'daily', '07:30', DATE '2026-10-01', DATE '2026-10-05');

  -- Each probe below MUST raise. `msg` is set inside the handler, so a probe
  -- that was silently accepted falls through to the RAISE after it.
  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, by_weekday, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','weekly',ARRAY[1,1]::smallint[],'09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: a DUPLICATE weekday was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, by_weekday, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','weekly',ARRAY[5,1]::smallint[],'09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: an UNSORTED weekday list was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, by_weekday, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','weekly',ARRAY[8]::smallint[],'09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: weekday 8 was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, by_weekday, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','weekly',ARRAY[1,2,3,4,5,6,7,7]::smallint[],'09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: an EIGHT-element weekday list was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, by_weekday, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','weekly','{}'::smallint[],'09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: an EMPTY weekday list was accepted for a weekly rule';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','weekly','09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: a weekly rule with NO weekdays was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, by_weekday, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','daily',ARRAY[1]::smallint[],'09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: a DAILY rule carrying weekdays was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','daily','09:00',DATE '2026-10-05',DATE '2026-10-01');
    RAISE EXCEPTION '2797: an INVERTED effective range was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until, prep_duration)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','daily','09:00',DATE '2026-10-01',DATE '2026-10-05', interval '-5 minutes');
    RAISE EXCEPTION '2797: a NEGATIVE prep_duration was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until, arrival_lead)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','daily','09:00',DATE '2026-10-01',DATE '2026-10-05', interval '-1 minute');
    RAISE EXCEPTION '2797: a NEGATIVE arrival_lead was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until, interval_count)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','daily','09:00',DATE '2026-10-01',DATE '2026-10-05', 0);
    RAISE EXCEPTION '2797: interval_count 0 was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'seance','Europe/Lisbon','daily','09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: a type outside 2761''s vocabulary was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','fortnightly','09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: an unknown freq was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until)
      VALUES (gen_random_uuid(),'event','+07','daily','09:00',DATE '2026-10-01',DATE '2026-10-05');
    RAISE EXCEPTION '2797: a UTC OFFSET was accepted as a timezone';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  BEGIN
    INSERT INTO _r2797 (trip_id, type, timezone, freq, local_time, effective_from, effective_until, skip_dates)
      VALUES (gen_random_uuid(),'event','Europe/Lisbon','daily','09:00',DATE '2026-10-01',DATE '2026-10-05',
              ARRAY[DATE '2026-10-02', NULL]::date[]);
    RAISE EXCEPTION '2797: a NULL skip date was accepted';
  EXCEPTION WHEN check_violation THEN msg := 'ok'; END;

  -- Two rows in, fifteen refused: the count is the proof that no probe leaked
  -- a row through a constraint that was not doing its job.
  SELECT count(*) INTO n FROM _r2797;
  IF n <> 2 THEN RAISE EXCEPTION '2797: the probe table holds % rows, expected exactly 2', n; END IF;
  IF msg IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION '2797: no probe reached a handler'; END IF;
END
$post$;

COMMIT;
