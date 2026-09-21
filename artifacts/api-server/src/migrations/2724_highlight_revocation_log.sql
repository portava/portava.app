-- 2724_highlight_revocation_log.sql
--
-- WHAT: one new table, public.highlight_revocation_log — one row per
-- (revocation attempt, destination), recording what a §21 operation reached and
-- what it did not. Nothing existing is altered.
--
-- WHY. Highlights/Memories Development Architecture Spec v1 §21, last sentence:
--
--     "Deletion should be observable, retryable, and dead-lettered if a
--      downstream cleanup repeatedly fails."
--
-- and the sentence before it, which is the checklist this table records against:
--
--     "Revocation propagation must cover public projection, search index,
--      semantic embedding, profile Highlight, Trip story derivative, Passport
--      reference, cached narrative, and any share link."
--
-- MEASURED BEFORE WRITING THIS.
--   * DELETE /highlights/:id set `deleted_at` and stopped. It did not even
--     invalidate the Compass cache, which POST /highlights/:id/report already
--     did for a weaker reason ("their feed should not continue to surface
--     content they reported"). So a DELETED Highlight could outlive its own
--     deletion in a cached feed while a REPORTED one could not. Fixed in
--     routes/highlights.ts alongside this migration; the cache is the ONE §21
--     destination this repository can actually reach.
--   * Census H193 records per-Memory deletion as having "no step, no report, no
--     retry, no dead letter" — the named, reported steps it contrasts with are
--     AccountDeletionService's, which is account deletion, a different thing.
--   * AccountDeletionService reaches NO highlight table at all (grepped), and
--     the FK cascade from profiles never fires because the profiles tombstone
--     survives — its own header says so. All four highlight tables sit in
--     lib/deletionDispositions.ts UNCLASSIFIED_BACKLOG, defined there as "the
--     data survives deletion and no one has said whether it should" (owner
--     decision D6). This table does not change that and does not decide it; it
--     is the record that would make the gap visible per deletion instead of
--     only in a manifest.
--
-- WHY ONE ROW PER DESTINATION AND NOT ONE PER DELETION WITH A jsonb BLOB.
-- Dead-lettering is per destination: "the cached narrative failed four times in
-- a row for four different Highlights" is the signal, and it is a GROUP BY on a
-- column, not a scan over JSON. Retry is also per destination — re-running a
-- whole revocation to reach one destination re-attempts seven that already
-- succeeded. And `status` as a column with a CHECK is what stops
-- `not_implemented` from being quietly written as `revoked` by a caller in a
-- hurry, which is the failure this whole table exists to make impossible.
--
-- WHY `not_applicable` AND `not_implemented` ARE BOTH STATUSES.
--   not_applicable  — no such destination exists in this repository. There is
--                     no search index fed from `highlights`; there is nothing
--                     to revoke from, and there never will be until one is
--                     built. Recording it as `revoked` would be a fabrication;
--                     recording it as `failed` would imply a retry could help.
--   not_implemented — the destination EXISTS and nothing reaches it. This is
--                     the status that must never be omitted from a report,
--                     because omission is exactly how a revocation record
--                     starts claiming more than it did.
--
-- WHY IT IS INSERT-ONLY (no UPDATE policy, no updated_at). A revocation record
-- is a claim about what happened at a point in time. A retry produces a NEW row
-- with a new attempted_at; editing the old one in place would erase the
-- evidence that the first attempt failed, which is the evidence dead-lettering
-- depends on.
--
-- WHY THERE IS NO FOREIGN KEY TO `highlights`. A revocation record must survive
-- the thing it revoked — including a future hard delete of the row, which is
-- what D6 may eventually rule. An ON DELETE CASCADE would erase the audit trail
-- at exactly the moment it becomes the only remaining evidence, and ON DELETE
-- SET NULL would erase which Highlight it was about. `subject_id` is a plain
-- UUID, deliberately.
--
-- REVERSIBLE BY:
--   DROP TABLE IF EXISTS public.highlight_revocation_log;
-- The route's revocation report keeps working — it is returned and logged
-- structurally by services/highlights/highlightRevocation.ts whether or not
-- this table exists — it simply stops being persisted. Nothing else is touched.
--
-- NOT APPLIED BY THIS LANE. Written only.

CREATE TABLE IF NOT EXISTS public.highlight_revocation_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Groups the rows of one attempt, so a report can be reassembled and a retry
  -- can be told apart from the attempt it retries.
  attempt_id    UUID NOT NULL,

  -- §21's six operations. ARCHIVE and the two retain-but-suppress controls are
  -- included because they are revocations too — MAKE_PRIVATE "revokes public
  -- derivatives and public indexing" — and because a log that only records
  -- deletions cannot show that the four operations stayed separate.
  operation     TEXT NOT NULL
                  CHECK (operation IN (
                    'ARCHIVE',
                    'DO_NOT_RESURFACE',
                    'DO_NOT_PERSONALIZE',
                    'MAKE_PRIVATE',
                    'DELETE_HIGHLIGHT',
                    'DELETE_MEDIA_ASSET'
                  )),

  -- The Highlight. NOT a foreign key; see the header.
  subject_id    UUID NOT NULL,
  -- Who performed it. FK to profiles is safe: the actor's identity is not the
  -- audit's subject, and an account deletion that removes the profile is
  -- entitled to remove the actor link.
  actor_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- The eight destinations §21 names, verbatim and in the spec's order.
  destination   TEXT NOT NULL
                  CHECK (destination IN (
                    'public_projection',
                    'search_index',
                    'semantic_embedding',
                    'profile_highlight',
                    'trip_story_derivative',
                    'passport_reference',
                    'cached_narrative',
                    'share_link'
                  )),

  status        TEXT NOT NULL
                  CHECK (status IN ('revoked', 'failed', 'not_applicable', 'not_implemented')),

  -- The evidence: what was attempted and what came back. Free text on purpose —
  -- it carries an error message, or the reason a destination does not exist.
  detail        TEXT NOT NULL DEFAULT '',

  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Has this destination failed repeatedly?" — the dead-letter question.
CREATE INDEX IF NOT EXISTS highlight_revocation_failed_idx
  ON public.highlight_revocation_log (destination, attempted_at DESC)
  WHERE status = 'failed';

-- "What happened to this Highlight?" — the per-subject audit.
CREATE INDEX IF NOT EXISTS highlight_revocation_subject_idx
  ON public.highlight_revocation_log (subject_id, attempted_at DESC);

-- "Reassemble this one attempt."
CREATE INDEX IF NOT EXISTS highlight_revocation_attempt_idx
  ON public.highlight_revocation_log (attempt_id);

ALTER TABLE public.highlight_revocation_log ENABLE ROW LEVEL SECURITY;

-- No policy for `authenticated` at all, in any verb.
--
-- This is deliberate and it is not an omission. With RLS enabled and no policy,
-- every end-user token is denied by default. The log is written by the server
-- through the service role, which bypasses RLS, and it is read by operators.
-- A user-facing "what did my deletion reach" surface is a product decision
-- nobody has made; when it is made, it gets a SELECT policy scoped to
-- actor_id = auth.uid() and the decision is visible in that migration rather
-- than pre-granted here.
--
-- §23: "Service roles performing projections must be scoped and audited." This
-- table is part of the audit half; the scoping half is not this migration's.

COMMENT ON TABLE public.highlight_revocation_log IS
  'Highlights/Memories spec v1 §21: deletion observable, retryable, dead-lettered. One row per '
  '(attempt, destination). INSERT-ONLY — a retry writes a new row rather than editing the record '
  'of the attempt that failed. status not_implemented and not_applicable are first-class: a '
  'destination that was not reached must be recorded as not reached, never omitted.';
