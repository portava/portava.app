/**
 * The payment slice bound to PR #598's ledger, and what it stores about people.
 *
 *   LB  ledgerAdapter.ts — the planner's postings become exactly the
 *       `payment_post_transaction` payloads 3822 accepts: credit-positive signs,
 *       the original amount tied to the credits (PL007), 3821's account owners
 *       (user_payable by PARTY, clearing by PROCESSOR, revenue and tax by the
 *       PLATFORM), event-derived keys that name no person, the credited
 *       beneficiary, 3821's external_ref shape, and every refusal by name.
 *       Pure: `sc.rpc` is a recorder. tests/db/rentBuddyPaymentLedger.db.test.ts
 *       runs the same postings against the real SQL function in CI.
 *   PR  supabaseStore.ts — a provider snapshot carrying a name, an email, a
 *       phone, an address, card digits and a client secret is written to the
 *       jsonb columns WITHOUT any of them (OD-PAY-8: "removing direct
 *       identifiers").
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyPaymentLedgerBinding.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paymentLedgerAdapterWith, LEDGER_SCOPE, PLATFORM_PARTY_LABEL } from "../services/payments/bookingPayments/ledgerAdapter.js";
import { planPaymentPostings, planPayoutPaidPosting, planProviderFeePosting } from "../services/payments/bookingPayments/ledgerPostings.js";
import { supabaseBookingPaymentStore, projectIntentSnapshot } from "../services/payments/bookingPayments/supabaseStore.js";
import type { BookingPaymentRecord } from "../services/payments/bookingPayments/model.js";
import type { PaymentIntentSnapshot } from "../services/payments/PaymentProvider.js";

const PROFILE = "5f2c1b9e-1111-4a2b-8c3d-000000000001";
const PARTY = "9a8b7c6d-2222-4e5f-8a9b-000000000002";

/** A recorder standing in for PostgREST's rpc: answers ensure with ids by owner, and posts with a transaction id. */
function recorder(opts: { postError?: { code: string; message: string }; ensureError?: { code: string; message: string } } = {}) {
  const calls: Array<{ fn: string; p: Record<string, any> }> = [];
  const sc = {
    async rpc(fn: string, args: { p: Record<string, any> }) {
      calls.push({ fn, p: args.p });
      if (fn === "payment_account_ensure") {
        if (opts.ensureError) return { data: null, error: opts.ensureError };
        const p = args.p;
        const who = p["owner_kind"] === "user" ? `user:${p["profile_id"]}` : `${p["owner_kind"]}:${p["owner_label"]}`;
        return { data: { account_id: `acct:${who}:${p["account_type"]}:${p["currency"]}`, party_id: who === `user:${PROFILE}` ? PARTY : `party:${who}`, created: true }, error: null };
      }
      if (opts.postError) return { data: null, error: opts.postError };
      return { data: { transaction_id: "tx-1", replayed: false, balances: [] }, error: null };
    },
  };
  return { sc, calls };
}

const lookups = (accountId: string | null, profileId: string | null = PROFILE) => ({
  userAccount: async () => ({ ok: true as const, accountId }),
  profileForParty: async () => ({ ok: true as const, profileId }),
});

const payment = (o: Partial<BookingPaymentRecord> = {}) => ({
  id: "3b1e2a4c-aaaa-4bbb-8ccc-000000000010", bookingId: "7d6c5b4a-bbbb-4ccc-8ddd-000000000020", provider: "fake", intentRef: "fake_pi_000001",
  recipientPartyId: PARTY, amount: { amountMinor: 5400, currency: "USD" },
  components: { serviceMinor: 4000, payerFeeMinor: 0, tipMinor: 1000, taxMinor: 400 },
  platformFee: { commissionMinor: 400, payerFeeMinor: 0, taxMinor: 400 }, ...o,
});
const zero = { capturedMinor: 0, refundedMinor: 0, feeCollectedMinor: 0, feeRefundedMinor: 0 };

describe("LB — the planner's postings as 3822 payloads", () => {
  it("LB1 a capture: credits positive, original = Σ credits, owners by 3821's rule, the buddy's payable is the beneficiary", async () => {
    const { sc, calls } = recorder();
    const port = paymentLedgerAdapterWith(sc, lookups("acct:payable")); // the buddy already has a payable account
    const [p] = planPaymentPostings(payment(), zero, { ...zero, capturedMinor: 5400, feeCollectedMinor: 800 }, "2026-08-10T12:00:00.000Z");
    const r = await port.post(p!);
    assert.deepEqual(r, { ok: true, replayed: false });
    const post = calls.find((c) => c.fn === "payment_post_transaction")!.p;
    assert.equal(post["kind"], "capture");
    assert.equal(post["scope"], LEDGER_SCOPE);
    assert.equal(post["livemode"], false);
    assert.equal(post["original_currency"], "USD");
    const credits = post["entries"].filter((e: any) => Number(e.amount_minor) > 0).reduce((n: number, e: any) => n + Number(e.amount_minor), 0);
    assert.equal(post["original_amount_minor"], String(credits), "PL007: the credits total the original amount");
    assert.equal(post["entries"].reduce((n: number, e: any) => n + Number(e.amount_minor), 0), 0);
    const byAcct = (a: string) => post["entries"].filter((e: any) => e.account_id === a).map((e: any) => [e.entry_reason, e.amount_minor]);
    assert.deepEqual(byAcct("acct:payable"), [["principal", "3600"], ["tip", "1000"]], "3600 principal + 1000 tip credited to the buddy");
    assert.deepEqual(byAcct("acct:processor:fake:processor_clearing:USD"), [["principal", "-5400"]], "the processor's clearing is debited");
    assert.deepEqual(byAcct(`acct:platform:${PLATFORM_PARTY_LABEL}:platform_revenue:USD`), [["platform_fee", "400"]]);
    assert.deepEqual(byAcct(`acct:platform:${PLATFORM_PARTY_LABEL}:tax_withheld:USD`), [["tax", "400"]]);
    assert.equal(post["beneficiary_account_id"], "acct:payable");
    assert.equal(post["cause_kind"], "booking");
    assert.equal(post["subject_kind"], "booking");
    assert.equal(post["external_ref"], "fake_pi_000001");
  });

  it("LB2 no person in any text the ledger stores: no profile id, no party id in scope / key / cause / subject", async () => {
    const { sc, calls } = recorder();
    const port = paymentLedgerAdapterWith(sc, lookups(null)); // first posting for this buddy: the account is ensured by profile
    const [p] = planPaymentPostings(payment(), zero, { ...zero, capturedMinor: 5400, feeCollectedMinor: 800 }, "2026-08-10T12:00:00.000Z");
    await port.post(p!);
    const post = calls.find((c) => c.fn === "payment_post_transaction")!.p;
    for (const k of ["scope", "idempotency_key", "cause_id", "subject_id", "attribution_version", "external_ref"]) {
      assert.doesNotMatch(String(post[k] ?? ""), new RegExp(`${PROFILE}|${PARTY}`), k);
    }
    const ensures = calls.filter((c) => c.fn === "payment_account_ensure").map((c) => c.p);
    assert.ok(ensures.some((e) => e["owner_kind"] === "user" && e["profile_id"] === PROFILE && e["account_type"] === "user_payable"), "the payable account is ensured BY PROFILE only when the party still leads to one");
    assert.ok(ensures.every((e) => e["livemode"] === false));
  });

  it("LB3 a party whose identity was REMOVED and has no account in that currency books nothing (refused, named)", async () => {
    const { sc, calls } = recorder();
    const port = paymentLedgerAdapterWith(sc, lookups(null, null));
    const [p] = planPaymentPostings(payment(), zero, { ...zero, capturedMinor: 5400, feeCollectedMinor: 800 }, "t");
    const r = await port.post(p!);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /identity was removed/);
    assert.equal(calls.filter((c) => c.fn === "payment_post_transaction").length, 0);
  });

  it("LB4 the provider's fee is its OWN `fee` transaction (3822: credits total the original amount)", async () => {
    const { sc, calls } = recorder();
    const port = paymentLedgerAdapterWith(sc, lookups("acct:payable"));
    await port.post(planProviderFeePosting(payment(), 0, 160, "t")!);
    const post = calls.find((c) => c.fn === "payment_post_transaction")!.p;
    assert.equal(post["kind"], "fee");
    assert.equal(post["original_amount_minor"], "160");
  });

  it("LB5 a monthly payout is cause `adjustment` rab_payout:<id>, subject experience/rent_a_buddy; payout ref kept", async () => {
    const { sc, calls } = recorder();
    const port = paymentLedgerAdapterWith(sc, lookups("acct:payable"));
    await port.post(planPayoutPaidPosting({ id: "po-77777777", recipientPartyId: PARTY, provider: "fake", payoutRef: "fake_po_000001", currency: "USD", amountMinor: 3600 }, "t"));
    const post = calls.find((c) => c.fn === "payment_post_transaction")!.p;
    assert.equal(post["kind"], "payout");
    assert.equal(post["cause_kind"], "adjustment");
    assert.equal(post["cause_id"], "rab_payout:po-77777777");
    assert.equal(post["subject_kind"], "experience");
    assert.equal(post["beneficiary_account_id"], "acct:processor:fake:processor_clearing:USD", "a payout credits the clearing account");
  });

  it("LB6 refusals keep their meaning: missing function / contention -> ledger_unavailable (retry); a key conflict and a floor breach are named", async () => {
    const [p] = planPaymentPostings(payment(), zero, { ...zero, capturedMinor: 5400, feeCollectedMinor: 800 }, "t");
    const missing = await paymentLedgerAdapterWith(recorder({ ensureError: { code: "PGRST202", message: "Could not find the function" } }).sc, lookups("acct:payable")).post(p!);
    assert.equal(!missing.ok && missing.reason, "ledger_unavailable");
    const conflict = await paymentLedgerAdapterWith(recorder({ postError: { code: "PL409", message: "payment_idempotency_conflict" } }).sc, lookups("acct:payable")).post(p!);
    assert.equal(!conflict.ok && conflict.reason, "idempotency_conflict");
    const floor = await paymentLedgerAdapterWith(recorder({ postError: { code: "PL402", message: "payment_insufficient_balance" } }).sc, lookups("acct:payable")).post(p!);
    assert.equal(!floor.ok && floor.reason, "rejected");
    if (!floor.ok) assert.match(floor.detail, /insufficient_balance/);
  });

  it("LB7 an external ref not in 3821's <prefix>_<token> shape is omitted, never mangled", async () => {
    const { sc, calls } = recorder();
    await paymentLedgerAdapterWith(sc, lookups("acct:payable")).post(planPaymentPostings(payment({ intentRef: "PI-UPPER CASE" }), zero, { ...zero, capturedMinor: 5400, feeCollectedMinor: 800 }, "t")[0]!);
    assert.equal(calls.find((c) => c.fn === "payment_post_transaction")!.p["external_ref"], undefined);
  });
});

describe("PR — provider objects are stored as an allow-listed projection", () => {
  const leaky = {
    intentRef: "fake_pi_000001", chargeModel: "direct", recipientRef: "fake_acct_000001", reference: { kind: "rent_buddy_booking", id: "b-1", customer: "Jane Doe" },
    state: "succeeded", amount: { amountMinor: 4400, currency: "USD", billing_email: "jane@example.com" },
    components: { serviceMinor: 4000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 400 }, platformFee: { commissionMinor: 400, payerFeeMinor: 0, taxMinor: 400 },
    capture: "automatic", amountCapturableMinor: 0, amountCapturedMinor: 4400, amountRefundedMinor: 0, platformFeeCollectedMinor: 800, platformFeeRefundedMinor: 0,
    settlement: { settled: { amountMinor: 3600, currency: "USD" }, conversion: null, providerFee: null, platformFeeSettled: null, cardholder: "Jane Doe" },
    clientSecret: "fake_pi_000001_secret_abc", livemode: false, updatedAt: "2026-08-10T12:00:00.000Z",
    customerName: "Jane Doe", customerEmail: "jane@example.com", customerPhone: "+15551234567",
    billingAddress: { line1: "1 Main St", city: "Miami" }, cardLast4: "4242",
  } as unknown as PaymentIntentSnapshot;
  const forbidden = /Jane|jane@example\.com|\+15551234567|Main St|4242|secret/;

  it("PR1 the projection keeps the money facts and drops every identifier and the client secret", () => {
    const p = projectIntentSnapshot(leaky)!;
    const text = JSON.stringify(p);
    assert.doesNotMatch(text, forbidden, text);
    assert.equal(p.amountCapturedMinor, 4400);
    assert.equal(p.settlement?.settled.amountMinor, 3600);
    assert.equal(p.clientSecret, null);
  });

  it("PR2 what the store WRITES for a payment carrying that snapshot contains none of it", async () => {
    const writes: unknown[] = [];
    const sc = {
      from() {
        const q: any = {
          update: (body: unknown) => { writes.push(body); return q; },
          eq: () => q,
          select: async () => ({ data: [{ id: "x" }], error: null }),
        };
        return q;
      },
    };
    const w = await supabaseBookingPaymentStore(sc).updatePayment("x", { lastSnapshot: leaky, settlement: leaky.settlement });
    assert.equal(w.ok, true);
    assert.equal(writes.length, 1);
    assert.doesNotMatch(JSON.stringify(writes[0]), forbidden, JSON.stringify(writes[0]));
  });
});

// ── Verifier F1 (2026-10-06): the production store's compare-and-set ──
describe("F1 supabaseBookingPaymentStore.updatePaymentIfUnchanged is a compare-and-set", () => {
  function casClient(rows: unknown[]) {
    const filters: Array<[string, string, unknown]> = [];
    const sc = {
      from() {
        const q: any = {
          update: () => q,
          eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q; },
          is: (c: string, v: unknown) => { filters.push(["is", c, v]); return q; },
          select: async () => ({ data: rows, error: null }),
        };
        return q;
      },
    };
    return { sc, filters };
  }
  const held = { updatedAt: "2026-08-10T12:00:00.000Z", state: "processing" as const, intentState: null, amountCapturedMinor: 0, amountRefundedMinor: 0 };

  it("the UPDATE is filtered on everything it read: updated_at, state, intent state and both money counters", async () => {
    const { sc, filters } = casClient([{ id: "x" }]);
    const w = await supabaseBookingPaymentStore(sc).updatePaymentIfUnchanged("x", held, { state: "succeeded" });
    assert.equal(w.ok, true);
    assert.deepEqual(filters, [
      ["eq", "id", "x"], ["eq", "updated_at", held.updatedAt], ["eq", "state", "processing"],
      ["eq", "amount_captured_minor", 0], ["eq", "amount_refunded_minor", 0], ["is", "intent_state", null],
    ]);
  });

  it("zero rows matched is a CONFLICT (another write landed first), not a plain failure", async () => {
    const { sc } = casClient([]);
    const w = await supabaseBookingPaymentStore(sc).updatePaymentIfUnchanged("x", held, { state: "succeeded" });
    assert.deepEqual([w.ok, !w.ok && w.conflict], [false, true]);
  });
});
