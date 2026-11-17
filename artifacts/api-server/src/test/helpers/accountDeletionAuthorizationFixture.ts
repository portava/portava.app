/** Unit transport fixture for an explicitly prepared admin deletion request.
 * The real authorization, concurrency and FK cascade contract is proved by
 * db/accountRecovery.db.test.ts. This fixture keeps legacy cascade assertions
 * exercising their domain writes rather than stopping at authorization. */
export const PERMANENT_DELETION_TEST_OPTIONS = {
  actorId: 'aaaaaaaa-0000-4000-8000-000000000001',
  generation: 'bbbbbbbb-0000-4000-8000-000000000001',
  reason: 'Synthetic admin-authorized permanent deletion',
};
type Row = Record<string, any>;
export function accountDeletionAuthorizationFixture(rows: Record<string, Row[]>, userId: string) {
  rows.user_deletion_requests ??= [{ user_id: userId, status: 'pending' }];
  for (const [index, row] of rows.user_deletion_requests.entries()) Object.assign(row, {
    deletion_request_id: row.deletion_request_id ?? `cccccccc-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    recovery_generation: row.recovery_generation ?? PERMANENT_DELETION_TEST_OPTIONS.generation,
    retry_count: row.retry_count ?? 0,
  });
  return (name: string, args: Row): { data: unknown; error: null } | undefined => {
    if (name === 'account_deletion_terminal_ready') return { data: true, error: null };
    if (name === 'claim_account_permanent_deletion') {
      const row = rows.user_deletion_requests!.find(row => row.user_id === args.p_user && row.recovery_generation === args.p_generation);
      if (args.p_protocol !== 1 || args.p_actor !== PERMANENT_DELETION_TEST_OPTIONS.actorId || !args.p_reason?.trim() || !row || !['pending','failed'].includes(row.status)) return { data: { ok: false, error: 'fixture_authorization_refused' }, error: null };
      Object.assign(row, { status: 'executing', execution_token: args.p_token, execution_started_at: row.execution_started_at ?? new Date().toISOString() });
      return { data: { ok: true, requestId: row.deletion_request_id, token: args.p_token }, error: null };
    }
    if (name === 'prepare_account_auth_deletion') {
      const row = rows.user_deletion_requests!.find(row => row.deletion_request_id === args.p_request && row.execution_token === args.p_token);
      if (!row || row.status !== 'executing' || row.execution_subject_id) return { data: false, error: null };
      Object.assign(row, { execution_subject_id: row.user_id, failure_code: 'auth_delete_dispatched',
        deleted_counts: args.p_deleted, tombstoned_counts: args.p_tombstoned,
        policy_version: args.p_policy, worker_version: args.p_worker });
      return { data: true, error: null };
    }
    if (name === 'settle_account_auth_deletion') {
      // Transport-only fixture: actual Auth absence, races and current admin
      // authority are proved by accountRecovery.db.test.ts.
      const row = rows.user_deletion_requests!.find(row => row.deletion_request_id === args.p_request);
      if (!row || row.status !== 'executing' || !row.execution_subject_id) return { data: { ok: false, error: 'terminal_dispatch_unverified' }, error: null };
      Object.assign(row, { status: 'completed', user_id: null, execution_subject_id: null, failure_code: 'auth_delete_confirmed' });
      return { data: { ok: true, completed: true, alreadyCompleted: false }, error: null };
    }
    if (name === 'finish_account_deletion_attempt') {
      const row = rows.user_deletion_requests!.find(row => row.deletion_request_id === args.p_request && row.execution_token === args.p_token);
      if (!row) return { data: false, error: null };
      if (args.p_success) return { data: row.status === 'completed' && row.user_id === null, error: null };
      if (row.status !== 'executing' || row.execution_subject_id) return { data: false, error: null };
      Object.assign(row, { status: 'failed', execution_token: null, retry_count: row.retry_count + 1 });
      return { data: true, error: null };
    }
    return undefined;
  };
}
