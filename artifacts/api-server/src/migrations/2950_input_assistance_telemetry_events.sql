-- 2950_input_assistance_telemetry_events.sql
--
-- ⚠ NOT APPLIED ANYWHERE YET. This file is committed on a detached HEAD by the
--   Input Intelligence lane. It has NOT been applied to production
--   (ajrurzioarfkagpuxfnb) and, at the time of writing, NOT to portava-ci
--   (hwokxgbmezheskbzskfr) either. Until it is applied, every write this lane's
--   new code issues against this table fails at PostgREST and is answered as a
--   RETRYABLE REFUSAL -- never as a successful empty result. See
--   src/lib/inputAssistance/telemetry.ts.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Input
-- Intelligence lane, band 2950-2959.
--
-- ADDITIVE AND ISOLATED. One new table, three indexes, no function, no trigger
-- on any existing relation. It touches NO existing table and ships EMPTY.
-- Nothing in the product changes when this file lands.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT -- census G292 (census-input-intelligence:851), and the blocker named at
-- G263 / G306 / G355 / G365 / G366 / G367
-- ══════════════════════════════════════════════════════════════════════════════
-- §40 of the Global Input Intelligence spec names a `SuggestionTelemetryService`
-- among the server domain services. G292 grades it NOT-BUILT with the sentence:
--
--     "There is no server-side telemetry service, no serve log, no impression
--      record and no analytics write anywhere in lib/inputAssistance/."
--
-- That was true. The client half of §44 is real -- fourteen event names, nine of
-- them with live call sites in SmartInput -- and every one of those events is
-- handed to a sink that is `() => {}`. The census says so in §3.5 and repeats it
-- at G263: "Emission is not measurement: in production these events are now
-- produced and dropped." The reason given for not fixing it was explicit:
-- "inventing a transport inside this layer would have been the worse answer,
-- because the only honest destination is a server endpoint that does not exist
-- yet."
--
-- This table is that destination. It is the SERVE LOG G292 names.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY *NOT* IN THIS TABLE, AND WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- THERE IS NO user_id, viewer_id, actor_id OR ANY COLUMN THAT LINKS A ROW TO AN
-- ACCOUNT. That is a design decision, not an omission, and it has three
-- consequences worth stating up front because two of them are costs:
--
--   1. §44's rule is "measure usefulness without unnecessarily capturing raw
--      private text". Every metric §57 asks this table for -- valid entity
--      resolution rate, manual fallback rate, time to valid selection, P95
--      suggestion latency -- is a RATE or a QUANTILE over events, and none of
--      them needs to know whose events they are. An account id would therefore
--      be captured unnecessarily, which is the thing the section forbids.
--
--   2. COST: per-user cohort analysis is impossible against this table by
--      construction, and so is "which users are worst served". Anyone who wants
--      that has to change this schema and argue for it, which is the point.
--
--   3. COST/BENEFIT: because no row is user-linked, this table has no deletion
--      fate to declare -- `check:deletion-coverage` derives user-linkage from
--      FOREIGN KEYS to auth.users and finds none here. That is a real reduction
--      in obligation and also a real reduction in what can be answered. It is
--      recorded here so a later pass that adds a user column knows it must also
--      add a row to src/lib/deletionDispositions.ts.
--
-- `session_id` IS a pseudonymous identifier -- a client-generated, per-app-run
-- opaque id. It exists because G365 ("time to valid selection") cannot be
-- computed without correlating an `input_opened` with the `suggestion_selected`
-- that followed it. It is not derived from and cannot be resolved to an account
-- id by this schema. It is still a correlator, and this file does not pretend
-- otherwise.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THREE LINES OF DEFENCE AGAINST RAW TEXT, NOT ONE
-- ══════════════════════════════════════════════════════════════════════════════
-- §44 forbids capturing raw typed content for a field whose policy says so, and
-- §29/§47 make a private-message field the hard case: a caption or a Telegraph
-- message is exactly the text a funnel event must never carry.
--
--   1. CLIENT  -- services/inputTelemetry.ts scrubs `text`/`query`/`rawText`/
--                 `message` before the event leaves the device.
--   2. SERVER  -- lib/inputAssistance/telemetry.ts REBUILDS each event from a
--                 per-event-name allow-list of props. An unknown key cannot ride
--                 along under any name, so the denylist's completeness stops
--                 being load-bearing. (This is the posture routes/wallTelemetry.ts
--                 adopted for the same reason.)
--   3. DATABASE -- the CHECK constraint below. It is the line that still holds
--                 if somebody adds a fifteenth event name and forgets step 2.
--
-- The constraint is a KEY check, not a value check: it cannot tell prose from a
-- token, and it does not try. What it can do is refuse the four key names the
-- client scrubber knows about plus the label-shaped keys that would carry a
-- person's name, and it does that at the only point no application bug can
-- bypass.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY event_name IS A CHECKED TEXT COLUMN AND NOT AN ENUM
-- ══════════════════════════════════════════════════════════════════════════════
-- The repo's `check:enum-literals` guard reads declared enum types and compares
-- them against the literals the code writes. A pg ENUM here would put the
-- vocabulary in two places (the type and the TypeScript union) with an ALTER
-- TYPE between them. A CHECK over a literal list keeps the vocabulary in one
-- place per side and makes widening it a migration, which is what it should be.
--
-- The fourteen names below are exactly `InputTelemetryEventName`
-- (travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts)
-- and exactly INPUT_TELEMETRY_EVENT_NAMES in src/lib/inputAssistance/telemetry.ts.
-- There is no fifteenth server-only name: the suggest route's own latency
-- travels on the response envelope (`serverMs`) and returns on
-- `suggestion_request_completed`, so census G372's measurement has a PRODUCER
-- rather than another declared-and-never-emitted name.

BEGIN;

CREATE TABLE IF NOT EXISTS public.input_assistance_telemetry_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Pseudonymous correlator. Client-generated per app run; bounded so it cannot
  -- become a smuggling channel for prose.
  session_id     text        NOT NULL,

  -- The suggest response's own requestId, when the event is attributable to one
  -- serve. This is the §44 "action/result linkage" the census grades at G355:
  -- without it an impression cannot be joined to the selection that followed.
  request_id     text        NULL,

  event_name     text        NOT NULL,
  context        text        NOT NULL,
  field_id       text        NOT NULL,

  -- The field-policy registry version in force when the event was produced.
  -- A metric computed across a policy bump is comparing two different systems;
  -- this is what lets a reader notice.
  policy_version text        NOT NULL,

  -- When the client says it happened, and when we actually received it. Both,
  -- because a device clock is not trustworthy and a received_at-only table
  -- cannot measure a queue.
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),

  props          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT iate_session_id_bounded CHECK (length(session_id) BETWEEN 1 AND 64),
  CONSTRAINT iate_request_id_bounded CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 64),
  CONSTRAINT iate_context_bounded    CHECK (length(context)  BETWEEN 1 AND 64),
  CONSTRAINT iate_field_id_bounded   CHECK (length(field_id) BETWEEN 1 AND 128),
  CONSTRAINT iate_policy_version_bounded CHECK (length(policy_version) BETWEEN 1 AND 40),

  CONSTRAINT iate_event_name_known CHECK (event_name IN (
    'input_opened',
    'query_length_changed',
    'suggestion_request_started',
    'suggestion_request_completed',
    'suggestion_rendered',
    'suggestion_selected',
    'suggestion_dismissed',
    'raw_search_submitted',
    'manual_value_kept',
    'validation_shown',
    'correction_accepted',
    'disambiguation_selected',
    'action_completed',
    'downstream_task_completed'
  )),

  -- THE THIRD LINE OF DEFENCE (see the header). A key check, deliberately.
  CONSTRAINT iate_props_no_raw_text CHECK (
    jsonb_typeof(props) = 'object'
    AND NOT (props ?| ARRAY[
      'text', 'query', 'rawText', 'raw_text', 'message',
      'label', 'labels', 'name', 'handle', 'username', 'title', 'body', 'caption'
    ])
  ),

  -- A props blob is metadata. Anything approaching a kilobyte is prose that got
  -- past the allow-list under a permitted key name, and this refuses it.
  CONSTRAINT iate_props_bounded CHECK (length(props::text) <= 1024)
);

COMMENT ON TABLE public.input_assistance_telemetry_events IS
  'Global Input Intelligence §44 serve log. Deliberately carries NO account id: every §57 metric over it is a rate or a quantile. See migration 2950 for the full argument.';

-- The funnel is always read over a time window, and almost always for one event
-- name at a time (a rate is one name over another).
CREATE INDEX IF NOT EXISTS iate_occurred_at_idx
  ON public.input_assistance_telemetry_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS iate_event_name_occurred_at_idx
  ON public.input_assistance_telemetry_events (event_name, occurred_at DESC);
-- G365 "time to valid selection" walks one session's events in order.
CREATE INDEX IF NOT EXISTS iate_session_occurred_at_idx
  ON public.input_assistance_telemetry_events (session_id, occurred_at);

-- ── Client roles get NOTHING ──────────────────────────────────────────────────
-- Ingest is server-side only, through POST /api/input-assistance/telemetry,
-- which authenticates the caller with the service role behind it. A signed-in
-- client must not be able to read other people's funnel or forge rows directly.
ALTER TABLE public.input_assistance_telemetry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.input_assistance_telemetry_events FROM anon, authenticated;

DO $post$
DECLARE
  n int;
BEGIN
  -- POSTCONDITION 1: the table exists and carries no account link.
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'input_assistance_telemetry_events'
     AND column_name IN ('user_id', 'viewer_id', 'actor_id', 'profile_id', 'author_id');
  IF n <> 0 THEN
    RAISE EXCEPTION '2950: POSTCONDITION FAILED: this table must carry no account id (see header §"WHAT IS DELIBERATELY NOT IN THIS TABLE")';
  END IF;

  -- POSTCONDITION 2: the raw-text key check actually refuses. Asserted by
  -- behaviour on a real row, not by the constraint's existence -- a constraint
  -- that exists and does not fire is the failure mode this guards.
  BEGIN
    INSERT INTO public.input_assistance_telemetry_events
      (session_id, event_name, context, field_id, policy_version, occurred_at, props)
    VALUES ('postcondition', 'input_opened', 'global_search', 'global_search', 'postcondition',
            now(), '{"query":"where is the secret bar"}'::jsonb);
    RAISE EXCEPTION '2950: POSTCONDITION FAILED: a props blob carrying a raw `query` key was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- expected
  END;

  -- POSTCONDITION 3: an unknown event name is refused.
  BEGIN
    INSERT INTO public.input_assistance_telemetry_events
      (session_id, event_name, context, field_id, policy_version, occurred_at)
    VALUES ('postcondition', 'not_an_event', 'global_search', 'global_search', 'postcondition', now());
    RAISE EXCEPTION '2950: POSTCONDITION FAILED: an undeclared event name was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- expected
  END;

  -- POSTCONDITION 4: a legitimate row IS accepted -- otherwise the three checks
  -- above would pass on a table that refuses everything.
  INSERT INTO public.input_assistance_telemetry_events
    (session_id, event_name, context, field_id, policy_version, occurred_at, props)
  VALUES ('postcondition', 'suggestion_rendered', 'global_search', 'global_search', 'postcondition',
          now(), '{"count":5,"types":"entity,recent"}'::jsonb);

  DELETE FROM public.input_assistance_telemetry_events WHERE session_id = 'postcondition';

  SELECT count(*) INTO n FROM public.input_assistance_telemetry_events;
  IF n <> 0 THEN
    RAISE EXCEPTION '2950: POSTCONDITION FAILED: the table must ship EMPTY';
  END IF;
END
$post$;

COMMIT;

-- REVERSAL (exact, and lossless -- this file creates one table and nothing else):
--
--   DROP TABLE IF EXISTS public.input_assistance_telemetry_events;
--
-- NO EXISTING ROW OF ANY OTHER TABLE IS TOUCHED IN EITHER DIRECTION. Reversing
-- destroys the §44 serve log and nothing else; with no serve log, §57's funnel
-- metrics return to being uncomputable, which is the state this file found.
