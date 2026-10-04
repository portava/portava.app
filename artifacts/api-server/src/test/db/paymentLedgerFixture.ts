/**
 * paymentLedgerFixture — cleanup for the payment-ledger database suites. Not a
 * test file.
 *
 * The ledger refuses every DELETE, from every role — that refusal is what it is
 * for (3821, `09` §5.3 I2) — so a suite cannot remove its own synthetic rows the
 * ordinary way. This returns SQL for an after() hook on the THROWAWAY harness
 * that switches `session_replication_role` to `replica` for the deletes
 * (superuser-only; Supabase's service_role cannot), which also skips foreign-key
 * cascades, so children go first and `origin` is restored before anything else
 * runs. It then removes the synthetic profiles.
 *
 * It selects by what the suite created — its accounts, its profiles, its party
 * labels and its transaction scope — and never by a table-wide predicate.
 */
const ids = (xs: readonly string[]) =>
  (xs.length ? xs : ["00000000-0000-0000-0000-000000000000"]).map((x) => `'${x}'`).join(",");

export function paymentLedgerPurgeSql(input: {
  accountIds: readonly string[];
  profileIds: readonly string[];
  partyLabels: readonly string[];
  /** Transactions whose scope is this value or starts with it. */
  scope: string;
}): string {
  if (!/^[a-z0-9][a-z0-9:._/-]{3,119}$/.test(input.scope)) throw new Error(`paymentLedgerPurgeSql: refusing scope ${JSON.stringify(input.scope)}`);
  for (const l of input.partyLabels) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(l)) throw new Error(`paymentLedgerPurgeSql: refusing label ${JSON.stringify(l)}`);
  }
  const labels = input.partyLabels.length ? input.partyLabels.map((l) => `'${l}'`).join(",") : "''";
  return (
    "SET session_replication_role = replica; " +
    `CREATE TEMP TABLE payb_parties AS SELECT DISTINCT owner_id AS id FROM public.payment_accounts WHERE id IN (${ids(input.accountIds)}) ` +
    `  UNION SELECT id FROM public.payment_parties WHERE profile_id IN (${ids(input.profileIds)}) OR label IN (${labels}); ` +
    "CREATE TEMP TABLE payb_accounts AS SELECT id FROM public.payment_accounts WHERE owner_id IN (SELECT id FROM payb_parties); " +
    `CREATE TEMP TABLE payb_tx AS SELECT id FROM public.payment_transactions WHERE scope = '${input.scope}' OR left(scope, ${input.scope.length + 1}) = '${input.scope}-' ` +
    "  UNION SELECT transaction_id FROM public.payment_ledger_entries WHERE account_id IN (SELECT id FROM payb_accounts); " +
    "DELETE FROM public.payment_account_balances WHERE account_id IN (SELECT id FROM payb_accounts); " +
    "DELETE FROM public.payment_ledger_entries WHERE transaction_id IN (SELECT id FROM payb_tx) OR account_id IN (SELECT id FROM payb_accounts); " +
    "DELETE FROM public.payment_transactions WHERE id IN (SELECT id FROM payb_tx); " +
    "DELETE FROM public.payment_accounts WHERE id IN (SELECT id FROM payb_accounts); " +
    "DELETE FROM public.payment_parties WHERE id IN (SELECT id FROM payb_parties); " +
    "DROP TABLE payb_tx; DROP TABLE payb_accounts; DROP TABLE payb_parties; " +
    "SET session_replication_role = origin; " +
    `DELETE FROM public.profiles WHERE id IN (${ids(input.profileIds)}); ` +
    `DELETE FROM auth.users WHERE id IN (${ids(input.profileIds)});`
  );
}
