-- 3691 — Input Intelligence: two capability flags, both seeded OFF.
-- Census-input-intelligence G303 (§43 `share_entity`, §21 "Share Event") and
-- G158 (§24 pasted event links).
--
-- ── input_telegraph_share_entity_enabled ──────────────────────────────────────
-- When ON, "meet at <text>" in a Telegraph message whose text names a PUBLIC,
-- upcoming event (as THIS sender's event search would show it — blocks, age
-- gate and host status applied by the gateway's own search) also offers
-- "Share Event: …" with a `share_entity` action. The composer asks the sender to
-- confirm, then sends through the existing POST /threads/:id/share, which
-- re-checks the sender's access and projects the event per recipient (§5.3).
-- Served only to a client that declares `share_entity`. OFF / absent: none.
--
-- ── input_paste_event_links_enabled ───────────────────────────────────────────
-- When ON, a pasted Portava event link (<web origin>/event/<uuid> or
-- travelbuddy://event/<uuid>) is read as that event — only as the viewer's own
-- event search would show it — and its city is resolved for the place field
-- like typed text, on the review screen. The link's share token is never read
-- or echoed; anything the viewer could not find is dropped without a trace.
-- OFF / absent: an event link is the unsupported link it always was.
--
-- Additive only: two rows in feature_flags. Rollback:
-- db/rollback/2026-10-10-3691-input-telegraph-share-entity-and-paste-event-links-flags-rollback.sql.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3691): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'input_telegraph_share_entity_enabled',
    false,
    'Input Intelligence §43 share_entity (census G303): "meet at <text>" in a Telegraph message naming a public upcoming event the sender can find offers "Share Event"; the composer confirms, then sends through POST /threads/:id/share (per-recipient projection). OFF / absent (the seed): none is offered.'
  ),
  (
    'input_paste_event_links_enabled',
    false,
    'Input Intelligence §24 pasted event links (census G158): a pasted Portava event link resolves, as the viewer''s own event search would show it, to the event''s city on the paste review screen; the share token is never read or echoed. OFF / absent (the seed): the link stays unsupported.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_telegraph_share_entity_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3691): input_telegraph_share_entity_enabled absent.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_paste_event_links_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3691): input_paste_event_links_enabled absent.';
  END IF;
END $post$;
