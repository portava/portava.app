-- 2073_account_deletion_worker_flag.sql
-- Kill switch for the scheduled account-deletion worker
-- (lib/accountDeletionScheduler.ts, audit P1 item 7).
--
-- Starts DISABLED on purpose. The worker executes irreversible deletions with
-- no human in the loop: it removes posts and their media (DB rows + Storage
-- objects), message ciphertext, identity-verification rows, and the auth user
-- (the email address), then anonymises the profile into a "Deleted User"
-- tombstone. Nothing about that is recoverable.
--
-- The worker fails CLOSED — a missing row, an unreadable table, or enabled=false
-- all mean "do nothing" — so deploying the code before flipping this flag is
-- safe. Until it is enabled, POST /admin/deletion-requests/:id/execute remains
-- the only execution path; both paths share the same cascade in
-- services/accountDeletion/AccountDeletionService.ts, so enabling the flag
-- cannot introduce behaviour the manual path has not already exercised.
--
-- Before enabling in production:
--   1. Execute one real request through the admin endpoint and confirm the
--      returned `steps` array is all ok:true.
--   2. Confirm the auth user is gone (auth.admin.listUsers must not find the
--      email) — this is the GDPR claim the privacy policy makes.
--   3. Then: UPDATE feature_flags SET enabled = true
--            WHERE flag = 'account_deletion_worker_enabled';

INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  ('account_deletion_worker_enabled', false,
   'Scheduled worker that executes due user_deletion_requests. Irreversible; fails closed when off.',
   '{"rollout":"audit-p1-7","irreversible":true}')
ON CONFLICT (flag) DO UPDATE SET
  description = EXCLUDED.description,
  metadata    = EXCLUDED.metadata;
