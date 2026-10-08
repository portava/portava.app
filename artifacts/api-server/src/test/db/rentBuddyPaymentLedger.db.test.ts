/**
 * The Rent-a-Buddy payment slice's postings EXECUTED against PR #598's real
 * `payment_post_transaction` (3821-3823) on a throwaway PostgreSQL — CI's
 * `api-server-local-db` job (baseline restore + full chain replay). The real
 * adapter (services/payments/bookingPayments/ledgerAdapter.ts) runs over
 * `creatorLedgerPsqlClient`, i.e. as service_role through the SQL functions,
 * exactly as the API does.
 *
 * NEVER EXECUTED BY ITS AUTHOR: written on a machine with no PostgreSQL. It
 * skips without LOCAL_DB_URL and is picked up by scripts/local-db/run-tests.sh
 * (every src/test/db/*.db.test.ts), which refuses a run that skips anything.
 *
 *   P1  quote -> capture: the planned capture posts, balances, and the buddy's
 *       payable holds service - commission + tip
 *   P2  the same posting again REPLAYS (same key, same content) — webhooks re-deliver
 *   P3  a partial refund posts and the payable falls by refund - fee refunded
 *   P4  the provider's fee posts as its own `fee` transaction
 *   P5  the monthly payout posts and clears exactly the payable
 *   P6  a payout larger than what is payable is REFUSED by the balance floor
 *       (3822 PL402) and books nothing — #598 owner question 2, not decided here
 *   P7  no text the ledger stored names the buddy's profile
 *   P8  after the buddy's identity is removed (retain), a refund still posts to
 *       the pseudonymous party's existing account
 *
 * SYNTHETIC DATA ONLY: one seeded buddy, scope `test-rabpay-<run>`, platform and
 * processor labels `t_…_<run>`; after() removes every row this suite wrote.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, seedUser } from "./localDb.js";
import { creatorPsqlClient } from "./creatorLedgerPsqlClient.js";
import { paymentLedgerPurgeSql } from "./paymentLedgerFixture.js";
import { ensurePaymentAccount, removePaymentIdentity } from "../../services/payments/PaymentLedger.js";
import { paymentLedgerAdapter } from "../../services/payments/bookingPayments/ledgerAdapter.js";
import { planPaymentPostings, planPayoutPaidPosting, planProviderFeePosting } from "../../services/payments/bookingPayments/ledgerPostings.js";
import { commissionMinor } from "../../services/payments/bookingPayments/commissionPolicy.js";

const RUN = randomUUID().slice(0, 8);
const SCOPE = `test-rabpay-${RUN}`;
const PLATFORM = `t_rabplat_${RUN}`;
const PROCESSOR = `t_rabproc_${RUN}`;
const sc = creatorPsqlClient();
const port = paymentLedgerAdapter(sc, { scope: SCOPE, platformLabel: PLATFORM });

let buddy = "";
let party = "";
let payable = "";
const users: string[] = [];
const accounts: string[] = [];

const BOOKING = randomUUID();
const PAYMENT = randomUUID();
// 4000 service + 1000 tip + 400 platform-remitted tax; commission 10% of the service.
const COMMISSION = commissionMinor(4000, 1000);
const payment = () => ({
  id: PAYMENT, bookingId: BOOKING, provider: PROCESSOR, intentRef: `fake_pi_${RUN}`,
  recipientPartyId: party, amount: { amountMinor: 5400, currency: "USD" },
  components: { serviceMinor: 4000, payerFeeMinor: 0, tipMinor: 1000, taxMinor: 400 },
  platformFee: { commissionMinor: COMMISSION, payerFeeMinor: 0, taxMinor: 400 },
});
const zero = { capturedMinor: 0, refundedMinor: 0, feeCollectedMinor: 0, feeRefundedMinor: 0 };
const captured = { ...zero, capturedMinor: 5400, feeCollectedMinor: COMMISSION + 400 };

const balanceOf = (accountId: string): number =>
  Number(scalar(`SELECT coalesce((SELECT balance_minor FROM public.payment_account_balances WHERE account_id = '${accountId}'), 0)`));

describe("Rent-a-Buddy payment postings on the real ledger (3821-3823 via ledgerAdapter.ts)", { skip: !HAVE_DB }, () => {
  before(async () => {
    buddy = seedUser("rabpaybuddy");
    users.push(buddy);
    const r = await ensurePaymentAccount(sc, { owner: { kind: "user", profileId: buddy }, accountType: "user_payable", currency: "USD" });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    party = r.partyId;
    payable = r.accountId;
    accounts.push(payable);
  });

  after(() => {
    const extra = scalar(`SELECT string_agg(a.id::text, ',') FROM public.payment_accounts a JOIN public.payment_parties p ON p.id = a.owner_id WHERE p.label IN ('${PLATFORM}', '${PROCESSOR}')`);
    exec(paymentLedgerPurgeSql({
      accountIds: [...accounts, ...(extra ? extra.split(",") : [])],
      profileIds: users,
      partyLabels: [PLATFORM, PROCESSOR],
      scope: SCOPE,
    }));
  });

  test("P1 capture posts, balances, and credits the buddy service - commission + tip", async () => {
    const [p] = planPaymentPostings(payment(), zero, captured, new Date().toISOString());
    const r = await port.post(p!);
    assert.deepEqual(r, { ok: true, replayed: false });
    assert.equal(balanceOf(payable), 4000 - COMMISSION + 1000);
    const sums = scalar(`SELECT count(*) FROM (SELECT t.id FROM public.payment_transactions t JOIN public.payment_ledger_entries e ON e.transaction_id = t.id WHERE t.scope = '${SCOPE}' GROUP BY t.id HAVING sum(e.amount_minor) <> 0) x`);
    assert.equal(sums, "0", "every transaction sums to zero");
  });

  test("P2 the same capture again REPLAYS and books nothing more", async () => {
    const [p] = planPaymentPostings(payment(), zero, captured, new Date().toISOString());
    const r = await port.post(p!);
    assert.deepEqual(r, { ok: true, replayed: true });
    assert.equal(balanceOf(payable), 4000 - COMMISSION + 1000);
  });

  test("P3 a partial refund (1100, fee refunded 100) lowers the payable by 1000", async () => {
    const [p] = planPaymentPostings(payment(), captured, { ...captured, refundedMinor: 1100, feeRefundedMinor: 100 }, new Date().toISOString());
    const r = await port.post(p!);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(balanceOf(payable), 4000 - COMMISSION + 1000 - 1000);
  });

  test("P4 the provider's fee is its own `fee` transaction", async () => {
    const r = await port.post(planProviderFeePosting(payment(), 0, 160, new Date().toISOString())!);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(scalar(`SELECT kind FROM public.payment_transactions WHERE scope = '${SCOPE}' AND idempotency_key LIKE '%:providerfee:160'`), "fee");
    assert.equal(balanceOf(payable), 4000 - COMMISSION + 1000 - 1000 - 160);
  });

  test("P6 a payout LARGER than what is payable is refused by the floor and books nothing", async () => {
    const before = balanceOf(payable);
    const r = await port.post(planPayoutPaidPosting({ id: randomUUID(), recipientPartyId: party, provider: PROCESSOR, payoutRef: `fake_po_${RUN}x`, currency: "USD", amountMinor: before + 1 }, new Date().toISOString()));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /insufficient_balance/);
    assert.equal(balanceOf(payable), before);
  });

  test("P5 the monthly payout clears exactly the payable", async () => {
    const amount = balanceOf(payable);
    const r = await port.post(planPayoutPaidPosting({ id: randomUUID(), recipientPartyId: party, provider: PROCESSOR, payoutRef: `fake_po_${RUN}`, currency: "USD", amountMinor: amount }, new Date().toISOString()));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(balanceOf(payable), 0);
  });

  test("P7 no text the ledger stored names the buddy's profile", () => {
    const hits = scalar(
      `SELECT count(*) FROM public.payment_transactions WHERE scope = '${SCOPE}' AND ` +
      `(idempotency_key || cause_id || subject_id || coalesce(external_ref, '')) LIKE '%${buddy}%'`,
    );
    assert.equal(hits, "0");
  });

  test("P8 after the identity is removed (retained), a posting to the pseudonymous party's existing account still books", async () => {
    const rm = await removePaymentIdentity(sc, buddy, { onOpenBalance: "retain" });
    assert.equal(rm.ok, true, JSON.stringify(rm));
    assert.ok(!scalar(`SELECT profile_id FROM public.payment_parties WHERE id = '${party}'`), "the identity link is gone");
    const [p] = planPaymentPostings({ ...payment(), id: randomUUID() }, zero, captured, new Date().toISOString());
    const r = await port.post(p!);
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});
