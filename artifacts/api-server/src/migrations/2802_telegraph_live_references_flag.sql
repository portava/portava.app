-- 2802_telegraph_live_references_flag.sql
-- Seeds `telegraph_live_references_enabled` FALSE — the capability gate for
-- Sensing §12's canonical live references in Telegraph:
--   POST /api/telegraph/threads/:threadId/live-references
--   GET  /api/telegraph/live-references/:messageId
-- (routes/telegraphLiveReferences.ts; lib/liveReference.ts,
-- lib/liveReferenceMessages.ts).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2802.
--
-- WHAT THE FLAG GATES. A conversation shares a REFERENCE to a server-built
-- live object — the ExperienceState of a place, a WorldMoment at it, a
-- SafetyNotice on it — as a `card` message of subtype `live_reference` whose
-- body holds subject, kind, per-claim snapshot id / version id / value at
-- share time and the §5.1 truth block, never the state's prose. Reading a
-- reference resolves it against the CURRENT state through lib/liveClaimRead
-- (the one gated path) and answers whether the state changed since sharing.
-- The write is the service client's, after membership is established by the
-- predicate authz.is_active_thread_member uses, because public.messages
-- carries msg_insert WITH CHECK (false). No DDL on messages; no new table.
--
-- Seeded FALSE. Read fail-closed by lib/featureFlags.isFlagEnabled: absent,
-- false or unreadable all mean both routes answer feature_disabled. Enabling
-- is an owner decision — it opens a new user-facing surface that writes
-- messages — and the postcondition below refuses to commit this file if the
-- row reads TRUE.
--
-- Additive: one INSERT ... ON CONFLICT DO NOTHING. No DDL, no other row. It
-- does NOT self-register in schema_migration_ledger (the apply tooling's job).
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF to_regclass('public.messages') IS NULL OR to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages / public.message_thread_members do not exist; a live reference is a messages row.';
  END IF;
  -- NOTE, not a failure: version pinning reads 2273. Absent here means the
  -- reference carries versionId NULL and the answer says versionsPinned false.
  IF to_regclass('public.intel_state_snapshot_versions') IS NULL THEN
    RAISE NOTICE '2802: intel_state_snapshot_versions (2273) is not present on this database; references written here pin no version id until it is applied.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('telegraph_live_references_enabled', false,
   'Sensing §12: Telegraph shares CANONICAL REFERENCES to server-built live objects (ExperienceState / WorldMoment / SafetyNotice of a place) as card messages of subtype live_reference — snapshot id, version id, value at share time and the truth block, never copied prose — and GET resolves a reference against the current state through lib/liveClaimRead with changedSinceShare on the answer (null, never false, when the current state cannot be read). Writes one messages row per share as the service client after membership is established. FALSE / absent / unreadable (the seed): both routes answer feature_disabled. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'telegraph_live_references_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_live_references_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_live_references_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a surface an owner has not enabled.';
  END IF;
END $$;

COMMIT;
