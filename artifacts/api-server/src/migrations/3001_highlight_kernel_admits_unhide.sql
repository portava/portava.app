-- 3001_highlight_kernel_admits_unhide.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band).
--
-- ═══════════════════════════════════════
-- WHY THIS FILE EXISTS, AND WHY IT COULD NOT HAVE BEEN WRITTEN YESTERDAY
-- ═══════════════════════════════════════
-- 2993 created `highlight_kernel_execute` and REFUSES `UNHIDE_HIGHLIGHT` by
-- name: its vocabulary gate lists PIN / UNPIN / HIDE and nothing else, so an
-- un-hide arrives as MEMORY_COMMAND_UNKNOWN_TYPE. Meanwhile the TypeScript side
-- already declares the command in full — `memoryCommandBus.ts` has it in the
-- vocabulary, maps it to the `highlight` subject, to the `highlight.hidden`
-- event and to `owner` authority, and `highlightEventReplay.ts` asserts the
-- state it must leave behind. census-highlights-memories §W.3 recorded the
-- resulting contradiction and drew the conclusion out loud:
--
--     "2993 must admit UNHIDE_HIGHLIGHT before any route dispatches it …
--      The amendment is the next step and it is engineering work, not a
--      deployment blocker."
--
-- It then recorded why the amendment had nowhere to live:
--
--     "There is also no room above it: the canonical 4-digit band is 2100-2999,
--      every prefix from 2995 to 2999 is taken … A migration that runs AFTER
--      2993 cannot currently be numbered."
--
-- That is no longer true. PR #527 extended `NEW_NUMERIC_PREFIX_RE` to
-- /^(?:2[1-9]\d{2}|3\d{3})_/ — "3000-3999, ADDED 2026-09-23 BECAUSE 2100-2999
-- RAN OUT" — and 3000 is its own. 3001 is the first free slot above 2993, so
-- the amendment is an ordinary follow-up migration.
--
-- ═══════════════════════════════════════
-- WHY A FOLLOW-UP AND NOT AN EDIT TO 2993
-- ═══════════════════════════════════════
-- 2993 is unapplied on every database, so editing it in place would be legal.
-- It is deliberately NOT done, for a reason outside this file: a byte-identical
-- copy of 2993 is under review on the migration-bootstrap PR, whose whole claim
-- is that its three files are byte-identical to this branch's and were
-- rehearsed as such. Editing 2993 would invalidate that rehearsal and force it
-- to be redone. A follow-up leaves the bootstrap PR untouched and orders
-- correctly on every database, applied or not.
--
-- ═══════════════════════════════════════
-- WHAT CHANGES, EXACTLY
-- ═══════════════════════════════════════
-- The function body below is 2993's, DERIVED FROM IT MECHANICALLY rather than
-- retyped, with exactly two differences:
--
--   1. the vocabulary gate gains 'UNHIDE_HIGHLIGHT';
--   2. a `WHEN 'UNHIDE_HIGHLIGHT'` branch is added after HIDE's.
--
-- Everything else — the idempotency receipt, the owner re-check under lock, the
-- event/outbox/receipt/audit quartet in one transaction, the §23 payload filter,
-- the §24 reason codes, the service_role-only grant — is 2993's text unchanged.
--
-- NO EVENT NAME IS INVENTED. `highlight.unhidden` does not exist: 2710's type
-- CHECK admits five highlight names without it, §17 does not name it, and three
-- suites already assert its absence. UNHIDE emits `highlight.hidden` and is told
-- apart by `command_type` in the payload — the precedent PIN/UNPIN already set.
--
-- NO TABLE, COLUMN, POLICY, INDEX OR GRANT is created or altered here. This file
-- replaces one function body and nothing else.

BEGIN;

-- ── PRECONDITION: 2993 must already be applied ───────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.highlight_kernel_execute(jsonb)') IS NULL THEN
    RAISE EXCEPTION '3001 requires 2993: highlight_kernel_execute(jsonb) does not exist. Apply 2993 first.';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.highlight_kernel_execute(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_highlight_id uuid;
  v_actor        uuid;
  v_cmd_id       uuid;
  v_corr         uuid;
  v_key          text;
  v_type         text;
  v_payload      jsonb;
  v_observed     timestamptz;
  v_now          timestamptz;
  v_seq          bigint;
  v_event_id     uuid;
  v_event_type   text;
  v_result       jsonb;
  v_receipt      public.memory_command_receipts%ROWTYPE;
  v_owner        uuid;
  v_deleted      timestamptz;
  v_archived     timestamptz;
  v_pinned       timestamptz;
  v_expires      timestamptz;
  v_from         text;
  v_to           text;
BEGIN
  -- ONE CLOCK. Bound once and derived from everywhere below, so the state the
  -- row is written with, the state the event says it moved to and the event's
  -- occurred_at cannot disagree by however long the function took to run.
  v_now := now();

  -- ── envelope ───────────────────────────────────────────────────────────────
  BEGIN
    v_highlight_id := (p_command->>'highlight_id')::uuid;
    v_actor        := (p_command->>'actor_user_id')::uuid;
    v_cmd_id       := (p_command->>'command_id')::uuid;
    v_corr         := (p_command->>'correlation_id')::uuid;
    v_key          := p_command->>'idempotency_key';
    v_type         := p_command->>'type';
    v_payload      := coalesce(p_command->'payload', '{}'::jsonb);
    v_observed     := (p_command->>'client_observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                              'detail', SQLERRM, 'contract_version', 1);
  END;

  IF v_actor IS NULL OR v_cmd_id IS NULL OR v_type IS NULL OR v_key IS NULL
     OR char_length(v_key) < 1 OR char_length(v_key) > 200
     OR jsonb_typeof(v_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END IF;

  -- PUBLISH_HIGHLIGHT is absent from this list ON PURPOSE. See the header: the
  -- schema has no storable representation of "published" that differs from
  -- what creation already does, so this function refuses the name rather than
  -- accepting it and doing something else.
  IF v_type NOT IN ('PIN_HIGHLIGHT', 'UNPIN_HIGHLIGHT', 'HIDE_HIGHLIGHT', 'UNHIDE_HIGHLIGHT') THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_UNKNOWN_TYPE');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_UNKNOWN_TYPE',
                              'detail', v_type, 'contract_version', 1);
  END IF;

  -- ── idempotency (§19) ──────────────────────────────────────────────────────
  -- The SAME table and the SAME key as memory_kernel_execute, so one actor
  -- cannot reuse one operation id across the two aggregates either.
  SELECT * INTO v_receipt FROM public.memory_command_receipts
   WHERE actor_user_id = v_actor AND idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.command_type IS DISTINCT FROM v_type THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'MEMORY_IDEMPOTENCY_KEY_REUSED');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_IDEMPOTENCY_KEY_REUSED',
                                'detail', format('key already used for %s', v_receipt.command_type),
                                'contract_version', 1);
    END IF;
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, event_id)
    VALUES (v_cmd_id, v_type, NULL, v_receipt.highlight_id, v_actor, v_key, 'duplicate', v_receipt.event_id);
    -- The ORIGINAL result_json, not a recomputed one. A replay that recomputed
    -- would return a body describing a different world than the first call did.
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'highlight_id', v_receipt.highlight_id, 'event_id', v_receipt.event_id,
      'event_type', v_receipt.event_type, 'result', v_receipt.result_json,
      'contract_version', 1);
  END IF;

  IF v_highlight_id IS NULL THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, NULL, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_MALFORMED');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                              'detail', 'highlight_id required', 'contract_version', 1);
  END IF;

  -- ── the aggregate, its owner and its state (§23) ───────────────────────────
  -- The row is read and LOCKED before any check, and the lock is what makes the
  -- sequence allocation below safe: two concurrent commands against one
  -- Highlight serialize here, so `max(sequence) + 1` cannot be read twice.
  --
  -- OWNERSHIP IS RE-CHECKED HERE and the caller is not trusted, exactly as
  -- memory_kernel_execute re-checks `memories.owner_id`. The application also
  -- checks it; this is the defence-in-depth half.
  SELECT owner_id, deleted_at, archived_at, pinned_at, expires_at
    INTO v_owner, v_deleted, v_archived, v_pinned, v_expires
    FROM public.highlights WHERE id = v_highlight_id
    FOR UPDATE;

  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'HIGHLIGHT_NOT_FOUND');
    RETURN jsonb_build_object('ok', false, 'reason', 'HIGHLIGHT_NOT_FOUND', 'contract_version', 1);
  END IF;

  IF v_owner IS DISTINCT FROM v_actor THEN
    -- The AUDIT records that this was an ownership refusal, not an absence.
    -- The HTTP layer deliberately answers 404 for both — see
    -- src/lib/memoryCommandBus.ts sendMemoryCommandRejection, which explains
    -- why the outside answer must not distinguish what the inside must.
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'HIGHLIGHT_AUTH_NOT_OWNER');
    RETURN jsonb_build_object('ok', false, 'reason', 'HIGHLIGHT_AUTH_NOT_OWNER', 'contract_version', 1);
  END IF;

  -- ── §5 Highlight lifecycle, DERIVED and labelled as derived ────────────────
  -- `highlights.lifecycle_state` is NULL on every row this deployment has ever
  -- written (nothing writes it), so the state is derived from the columns that
  -- do carry facts, in the same precedence order as
  -- src/services/highlights/highlightLifecycle.ts describeHighlightLifecycle:
  -- archived -> HIDDEN, pinned -> PINNED, expired -> EXPIRED, else ACTIVE.
  -- The event payload marks this `derived` so a §18 consumer never mistakes it
  -- for a stored state. No lifecycle_state is WRITTEN here: writing one would
  -- replace every reader's derived answer with a stored one, which is a
  -- behaviour change and not this command's business.
  v_from := CASE
    WHEN v_archived IS NOT NULL THEN 'HIDDEN'
    WHEN v_pinned   IS NOT NULL THEN 'PINNED'
    WHEN v_expires IS NOT NULL AND v_expires <= v_now THEN 'EXPIRED'
    ELSE 'ACTIVE' END;

  -- ══ APPLY. Every check above has passed; the first write happens here. ══
  CASE v_type

    WHEN 'PIN_HIGHLIGHT' THEN
      -- §12 manual_pin. `pinned_at` ONLY. Deliberately not lifecycle_state —
      -- routes/highlights.ts records the reason at length: §5 draws no
      -- PINNED -> ACTIVE edge, so a stored PINNED could never be undone
      -- without an illegal transition, while §17 names UNPIN_HIGHLIGHT, which
      -- says it must be undoable. Writing the column keeps unpin a reversal of
      -- a fact rather than an illegal move in a state machine.
      UPDATE public.highlights SET pinned_at = v_now WHERE id = v_highlight_id;
      v_event_type := 'highlight.pinned';
      v_result := jsonb_build_object('id', v_highlight_id, 'pinned_at', v_now);
      v_to := CASE WHEN v_archived IS NOT NULL THEN 'HIDDEN' ELSE 'PINNED' END;

    WHEN 'UNPIN_HIGHLIGHT' THEN
      UPDATE public.highlights SET pinned_at = NULL WHERE id = v_highlight_id;
      -- §17 lists no `highlight.unpinned`. The event is highlight.pinned and
      -- the payload carries `command_type` and the resulting `pinned` state —
      -- the precedent 2711 already set, where ADD_MEDIA and REMOVE_MEDIA both
      -- emit memory.corrected and the payload distinguishes them. Inventing an
      -- event name the spec does not list would give a consumer a name nobody
      -- agreed on.
      v_event_type := 'highlight.pinned';
      v_result := jsonb_build_object('id', v_highlight_id, 'pinned_at', NULL);
      v_to := CASE
        WHEN v_archived IS NOT NULL THEN 'HIDDEN'
        WHEN v_expires IS NOT NULL AND v_expires <= v_now THEN 'EXPIRED'
        ELSE 'ACTIVE' END;

    WHEN 'HIDE_HIGHLIGHT' THEN
      -- §21: Archive is the REVERSIBLE removal from browsing and is a
      -- different operation from Delete. This writes `archived_at`, which
      -- DELETE /highlights/:id/archive clears. It does NOT write `deleted_at`:
      -- that column is terminal, no route clears it, and §5 puts HIDDEN inside
      -- the reversible cycle (PINNED -> HIDDEN -> EXPIRED).
      UPDATE public.highlights SET archived_at = v_now WHERE id = v_highlight_id;
      v_event_type := 'highlight.hidden';
      v_result := jsonb_build_object('id', v_highlight_id, 'archived_at', v_now);
      v_to := 'HIDDEN';

    WHEN 'UNHIDE_HIGHLIGHT' THEN
      -- ADDED BY 3001. The inverse of the branch above: it CLEARS `archived_at`
      -- and writes nothing else. `deleted_at` is untouched here exactly as it is
      -- untouched there — a hidden highlight and a deleted one are different
      -- facts, and un-hiding must not resurrect a deletion.
      UPDATE public.highlights SET archived_at = NULL WHERE id = v_highlight_id;
      -- SAME EVENT NAME AS HIDE, AND THAT IS NOT A SHORTCUT. 2710's type CHECK
      -- admits five highlight names and `highlight.unhidden` is not among them
      -- (2710:167). §17 does not name it either. The PIN/UNPIN pair already
      -- resolved this: both emit `highlight.pinned` and are told apart by
      -- `command_type` in the payload, which this function writes for every
      -- command. `memoryCommandBus.ts` maps UNHIDE_HIGHLIGHT to
      -- "highlight.hidden" for the same reason, so the applier and the bus agree
      -- by construction rather than by coincidence.
      v_event_type := 'highlight.hidden';
      v_result := jsonb_build_object('id', v_highlight_id, 'archived_at', NULL);
      -- NOT 'ACTIVE' unconditionally. Un-hiding an expired highlight returns it
      -- to EXPIRED, not to the feed: §5's cycle is PINNED -> HIDDEN -> EXPIRED
      -- and expiry is a fact about the clock, not about archiving. Derived the
      -- same way the UNPIN branch above derives it.
      v_to := CASE
        WHEN v_expires IS NOT NULL AND v_expires <= v_now THEN 'EXPIRED'
        ELSE 'ACTIVE' END;

  END CASE;

  -- ── Event + outbox + receipt + audit. Same transaction as the change. ──────
  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq
    FROM public.memory_domain_events WHERE highlight_id = v_highlight_id;

  INSERT INTO public.memory_domain_events (
    memory_id, highlight_id, sequence, type, actor_user_id, causation_id,
    correlation_id, payload_json, schema_version, occurred_at)
  VALUES (
    NULL, v_highlight_id, v_seq, v_event_type, v_actor, v_cmd_id, v_corr,
    -- §23 PRIVACY-FILTERED PAYLOAD. Ids, the command name and the §5
    -- vocabulary — never the caption, the media URL, the filter or the place.
    -- A §18 consumer that needs the body reads the canonical row under its own
    -- authorization; it does not learn it by subscribing.
    jsonb_build_object(
      'command_type',     v_type,
      'from_state',       v_from,
      'to_state',         v_to,
      -- Says out loud that the two states above were DERIVED from
      -- archived_at/pinned_at/expires_at and not read from lifecycle_state,
      -- so a consumer cannot mistake an inference for a stored fact.
      'state_provenance', 'derived',
      -- The resulting pin state, which is what makes highlight.pinned readable
      -- without a second query for the UNPIN case.
      'pinned',           (v_type = 'PIN_HIGHLIGHT'),
      'visibility',       NULL,
      'refs', jsonb_build_object(
        'highlight_id',  v_highlight_id,
        'memory_id',     NULL,
        'actor_user_id', v_actor)),
    1, coalesce(v_observed, v_now))
  RETURNING event_id INTO v_event_id;

  INSERT INTO public.memory_event_outbox (event_id, memory_id, highlight_id, type)
  VALUES (v_event_id, NULL, v_highlight_id, v_event_type);

  INSERT INTO public.memory_command_receipts (
    actor_user_id, idempotency_key, command_id, command_type, memory_id,
    highlight_id, event_id, event_type, result_json)
  VALUES (v_actor, v_key, v_cmd_id, v_type, NULL, v_highlight_id, v_event_id, v_event_type, v_result);

  INSERT INTO public.memory_command_audit (
    command_id, command_type, memory_id, highlight_id, actor_user_id,
    idempotency_key, outcome, event_id)
  VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'accepted', v_event_id);

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'highlight_id', v_highlight_id, 'event_id', v_event_id, 'event_type', v_event_type,
    'sequence', v_seq, 'result', v_result, 'contract_version', 1);
END;
$fn$;

-- ── POSTCONDITIONS ──────────────────────────────────────────────────────────
-- Written in 2993's own idiom, deliberately: that file's postconditions probe
-- REJECTION paths and the installed catalog, and create no fixture rows. A
-- first draft of this file did create one, and the throwaway-database rehearsal
-- refused it — `highlights.media_url` is NOT NULL, `owner_id` references
-- `profiles`, and `profiles.id` references `auth.users`, so a "simple" probe
-- row is a three-table fixture. It is not needed: everything this migration
-- changes is observable without one.
DO $post$
DECLARE
  v jsonb;
  v_def text;
BEGIN
  -- 1. THE NAME IS ADMITTED. Before this file the same call answered
  --    MEMORY_COMMAND_UNKNOWN_TYPE; that is the defect being closed. The
  --    highlight id is random and therefore absent, so the expected answer is
  --    HIGHLIGHT_NOT_FOUND — which proves the command got PAST the vocabulary
  --    gate and reached the lookup. Asserting the positive answer, not merely
  --    "not unknown", so that a gate that accepted everything would still fail.
  v := public.highlight_kernel_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'highlight_id', gen_random_uuid(),
        'idempotency_key', '3001-postcondition-unhide', 'type', 'UNHIDE_HIGHLIGHT',
        'payload', '{}'::jsonb));
  IF (v->>'reason') = 'MEMORY_COMMAND_UNKNOWN_TYPE' THEN
    RAISE EXCEPTION 'POSTCONDITION 1 FAILED: UNHIDE_HIGHLIGHT is still refused by name: %', v;
  END IF;
  IF (v->>'reason') IS DISTINCT FROM 'HIGHLIGHT_NOT_FOUND' THEN
    RAISE EXCEPTION 'POSTCONDITION 1 FAILED: UNHIDE_HIGHLIGHT on an absent Highlight returned %', v;
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = '3001-postcondition-unhide';

  -- 2. NEGATIVE CONTROL. Widening the gate to accept every name would satisfy
  --    postcondition 1. PUBLISH_HIGHLIGHT must still be refused BY NAME, for
  --    the reason 2993 gives: the schema has no storable "published".
  v := public.highlight_kernel_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'highlight_id', gen_random_uuid(),
        'idempotency_key', '3001-postcondition-publish', 'type', 'PUBLISH_HIGHLIGHT',
        'payload', '{}'::jsonb));
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_UNKNOWN_TYPE' THEN
    RAISE EXCEPTION 'POSTCONDITION 2 FAILED: PUBLISH_HIGHLIGHT is no longer refused by name: %', v;
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = '3001-postcondition-publish';

  -- 3. THE BRANCH CLEARS THE COLUMN, read off the INSTALLED function rather
  --    than off this file — pg_get_functiondef returns what the database now
  --    has, so this cannot pass by the text merely being present in the file.
  --    A branch that is reached but writes nothing would pass 1 and fail here.
  v_def := pg_get_functiondef('public.highlight_kernel_execute(jsonb)'::regprocedure);
  IF v_def !~ 'WHEN ''UNHIDE_HIGHLIGHT'' THEN' THEN
    RAISE EXCEPTION 'POSTCONDITION 3 FAILED: the installed function has no UNHIDE_HIGHLIGHT branch';
  END IF;
  IF v_def !~ 'SET archived_at = NULL' THEN
    RAISE EXCEPTION 'POSTCONDITION 3 FAILED: the UNHIDE branch does not clear archived_at';
  END IF;

  -- 4. NO EVENT NAME WAS INVENTED. 2710's type CHECK admits no
  --    `highlight.unhidden`; emitting one would fail at INSERT time for every
  --    un-hide of a real Highlight, which no unit test over a fake client can
  --    catch. Asserted here because this is the one place with the catalog.
  --    Matched on the ASSIGNMENT, not on the bare name: the UNHIDE branch's own
  --    comment explains why `highlight.unhidden` is not used, and
  --    pg_get_functiondef returns comments too. A first draft matched the name
  --    and failed on its own explanation — a false positive the rehearsal
  --    caught, and the reason this assertion is written narrowly.
  IF v_def ~ 'v_event_type\s*:=\s*''highlight\.unhidden''' THEN
    RAISE EXCEPTION 'POSTCONDITION 4 FAILED: the function emits highlight.unhidden, which 2710''s CHECK rejects';
  END IF;
  --    And the UNHIDE branch does emit the name it is supposed to.
  IF v_def !~ 'v_event_type\s*:=\s*''highlight\.hidden''' THEN
    RAISE EXCEPTION 'POSTCONDITION 4 FAILED: no highlight.hidden assignment survives in the function';
  END IF;

  -- 5. HIDE STILL HIDES. The edit sits directly beside that branch, so its
  --    survival is asserted rather than assumed. Same absent-Highlight probe:
  --    reaching the lookup proves the branch is still wired.
  v := public.highlight_kernel_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'highlight_id', gen_random_uuid(),
        'idempotency_key', '3001-postcondition-hide', 'type', 'HIDE_HIGHLIGHT',
        'payload', '{}'::jsonb));
  IF (v->>'reason') IS DISTINCT FROM 'HIGHLIGHT_NOT_FOUND' THEN
    RAISE EXCEPTION 'POSTCONDITION 5 FAILED: HIDE_HIGHLIGHT regressed: %', v;
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = '3001-postcondition-hide';

  -- 6. THIS MIGRATION TURNS NOTHING ON. 2993 asserts the same thing and the
  --    reason is unchanged: admitting a command name is not enabling a kernel.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
                  WHERE flag = 'memory_kernel_enabled' AND enabled = false) THEN
    RAISE EXCEPTION 'POSTCONDITION 6 FAILED: memory_kernel_enabled is missing or not false';
  END IF;

  RAISE NOTICE '3001 postconditions 1-6 passed.';
END
$post$;

COMMIT;
