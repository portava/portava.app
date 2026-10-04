/**
 * services/payments/PaymentLedger.ts over a recording client — what the wrapper
 * sends, what it refuses before sending, and how it names what comes back.
 * `09` §3.2, §7, §8; PAY-023, PAY-046, PAY-047, PAY-073.
 *
 *   PS1  a posting is ONE rpc and nothing else; amounts cross as digit strings; livemode is false
 *   PS2  the function absent -> `ledger_unavailable`, after exactly one call: no fallback, no table write
 *   PS3  each refusal the database names keeps its name
 *   PS4  a replay is a success with replayed: true and the original transaction id
 *   PS5  an amount that is not a whole number of minor units is refused BEFORE any call
 *   PS6  a thrown transport error, a null result and a malformed result are failures, never an empty ledger
 *   PS7  toMinorUnits renders digits and never rounds
 *   PS8  the read sends the caller's profile id and the filter, and maps the page
 *   PS9  the read gate is fail-closed
 *
 * The database half — that the function really does these things — is
 * src/test/db/paymentLedger.db.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/paymentLedgerService.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_LEDGER_READS_FLAG,
  classifyLedgerError,
  ensurePaymentAccount,
  paymentLedgerReadsEnabled,
  postPaymentTransaction,
  readPartyLedger,
  removePaymentIdentity,
  toMinorUnits,
  type PostPaymentTransactionInput,
} from "../services/payments/PaymentLedger.js";

interface Call { fn: string; args: any }

/** A client that records every rpc and THROWS on any table access: the wrapper has no table path. */
function recorder(answer: (fn: string, args: any) => { data: any; error: any } | Promise<{ data: any; error: any }>) {
  const calls: Call[] = [];
  const sc: any = {
    rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return answer(fn, args); },
    from: (table: string) => { throw new Error(`PaymentLedger touched table ${table} directly`); },
  };
  return { sc, calls };
}

const PAYER = "11111111-1111-4111-8111-111111111111";
const PAYEE = "22222222-2222-4222-8222-222222222222";
const REVENUE = "33333333-3333-4333-8333-333333333333";

function request(over: Partial<PostPaymentTransactionInput> = {}): PostPaymentTransactionInput {
  return {
    scope: "test:service",
    idempotencyKey: "booking:b1:capture",
    kind: "capture",
    currency: "USD",
    originalCurrency: "USD",
    originalAmountMinor: 11000,
    attribution: {
      causeKind: "booking", causeId: "b1", subjectKind: "booking", subjectId: "b1",
      beneficiaryAccountId: PAYEE, attributionVersion: "test/v1",
    },
    occurredAt: "2026-10-04T09:00:00Z",
    entries: [
      { accountId: PAYER, amountMinor: -11000, entryReason: "principal" },
      { accountId: PAYEE, amountMinor: 9000n, entryReason: "principal" },
      { accountId: PAYEE, amountMinor: "1000", entryReason: "tip" },
      { accountId: REVENUE, amountMinor: 1000, entryReason: "platform_fee" },
    ],
    ...over,
  };
}

describe("PaymentLedger service wrapper (09 §3.2, §7, §8)", () => {
  it("PS1. one rpc, the payload the function expects, amounts as digit strings, livemode false", async () => {
    const { sc, calls } = recorder(() => ({
      data: { transaction_id: "t-1", replayed: false, entry_count: 4, balances: [{ account_id: PAYEE, balance_minor: "10000" }] },
      error: null,
    }));
    const r = await postPaymentTransaction(sc, request({ externalRef: "pi_test_1" }));
    assert.deepEqual(r, { ok: true, transactionId: "t-1", replayed: false, balances: [{ accountId: PAYEE, balanceMinor: "10000" }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.fn, "payment_post_transaction");
    const p = calls[0]!.args.p;
    assert.equal(p.livemode, false);
    assert.equal(p.scope, "test:service");
    assert.equal(p.idempotency_key, "booking:b1:capture");
    assert.equal(p.original_amount_minor, "11000");
    assert.equal(p.external_ref, "pi_test_1");
    assert.equal(p.beneficiary_account_id, PAYEE);
    assert.deepEqual(p.entries, [
      { account_id: PAYER, amount_minor: "-11000", entry_reason: "principal" },
      { account_id: PAYEE, amount_minor: "9000", entry_reason: "principal" },
      { account_id: PAYEE, amount_minor: "1000", entry_reason: "tip" },
      { account_id: REVENUE, amount_minor: "1000", entry_reason: "platform_fee" },
    ]);
    // No conversion, no links: absent, not null-filled and not defaulted.
    for (const k of ["fx", "fx_transaction_id", "reverses_transaction_id"]) assert.equal(k in p, false, k);
  });

  it("PS1b. conversion details and links are passed through untouched; the rate stays a string", async () => {
    const { sc, calls } = recorder(() => ({ data: { transaction_id: "t-2", replayed: false, balances: [] }, error: null }));
    const r = await postPaymentTransaction(sc, request({
      kind: "fx", currency: "EUR", originalCurrency: "USD",
      conversion: { rate: "0.9134", source: "processor", at: "2026-10-04T08:59:00Z" },
      fxTransactionId: "t-1",
    }));
    assert.equal(r.ok, true);
    const p = calls[0]!.args.p;
    assert.deepEqual(p.fx, { rate: "0.9134", source: "processor", at: "2026-10-04T08:59:00Z" });
    assert.equal(typeof p.fx.rate, "string");
    assert.equal(p.fx_transaction_id, "t-1");
    assert.equal(p.original_currency, "USD");
    assert.equal(p.currency, "EUR");
  });

  it("PS2. the function absent: `ledger_unavailable` after exactly ONE call — no fallback write, no table access", async () => {
    for (const error of [
      { code: "PGRST202", message: "Could not find the function public.payment_post_transaction(p) in the schema cache" },
      { code: "42883", message: "function public.payment_post_transaction(jsonb) does not exist" },
      { code: "42P01", message: 'relation "public.payment_transactions" does not exist' },
    ]) {
      const { sc, calls } = recorder(() => ({ data: null, error }));
      const r = await postPaymentTransaction(sc, request());
      assert.equal(r.ok, false, error.code);
      if (!r.ok) assert.equal(r.reason, "ledger_unavailable", error.code);
      assert.equal(calls.length, 1, "one attempt, then a refusal — recorder.from() throws on any table path");
    }
    const { sc, calls } = recorder(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }));
    for (const r of [
      await ensurePaymentAccount(sc, { owner: { kind: "user", profileId: PAYER }, accountType: "user_receivable", currency: "USD" }),
      await readPartyLedger(sc, PAYER),
      await removePaymentIdentity(sc, PAYER),
    ]) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "ledger_unavailable");
    }
    assert.deepEqual(calls.map((c) => c.fn), ["payment_account_ensure", "payment_party_ledger", "payment_party_remove_identity"]);
  });

  it("PS3. a refusal the database names keeps its name; an unknown failure is db_error", () => {
    const cases: Array<[string, string]> = [
      ["PL409", "idempotency_conflict"],
      ["PL402", "insufficient_balance"],
      ["PL002", "transaction_unbalanced"],
      ["PL004", "reversal_not_negation"],
      ["PL412", "already_reversed"],
      ["PL451", "live_mode_refused"],
      ["PL422", "invalid_request"],
      ["PL006", "invalid_request"],
      ["40001", "retryable_contention"],
      ["40P01", "retryable_contention"],
      ["23505", "db_error"],
      ["PL001", "db_error"],
      ["", "db_error"],
    ];
    for (const [code, reason] of cases) {
      const f = classifyLedgerError({ code, message: `refused ${code}` });
      assert.equal(f.ok, false);
      assert.equal(f.reason, reason, code);
      assert.match(f.detail, /refused/);
    }
  });

  it("PS4. a replay is a success carrying the ORIGINAL id and replayed: true; a conflict is not a success", async () => {
    const replay = recorder(() => ({ data: { transaction_id: "t-original", replayed: true }, error: null }));
    const r = await postPaymentTransaction(replay.sc, request());
    assert.deepEqual(r, { ok: true, transactionId: "t-original", replayed: true, balances: [] });
    const conflict = recorder(() => ({ data: null, error: { code: "PL409", message: "payment_idempotency_conflict — …" } }));
    const c = await postPaymentTransaction(conflict.sc, request());
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.reason, "idempotency_conflict");
  });

  it("PS5. an amount that is not a whole number of minor units is refused BEFORE any call — never rounded", async () => {
    const bad: unknown[] = [12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "12.50", "1e3", "", " 100", "1,000", null, undefined, {}, "12345678901234567890"];
    for (const amount of bad) {
      const { sc, calls } = recorder(() => ({ data: { transaction_id: "never" }, error: null }));
      const viaEntry = await postPaymentTransaction(sc, request({
        entries: [
          { accountId: PAYER, amountMinor: amount as any, entryReason: "principal" },
          { accountId: PAYEE, amountMinor: 1, entryReason: "principal" },
        ],
      }));
      assert.equal(viaEntry.ok, false, `entry amount ${String(amount)}`);
      if (!viaEntry.ok) assert.equal(viaEntry.reason, "invalid_request");
      const viaOriginal = await postPaymentTransaction(sc, request({ originalAmountMinor: amount as any }));
      assert.equal(viaOriginal.ok, false, `original amount ${String(amount)}`);
      assert.equal(calls.length, 0, `nothing was sent for ${String(amount)}`);
    }
  });

  it("PS6. a thrown transport error, a null result and a malformed result are failures — never an empty ledger", async () => {
    const thrown = recorder(() => { throw new Error("socket hang up"); });
    const t = await readPartyLedger(thrown.sc, PAYER);
    assert.equal(t.ok, false);
    if (!t.ok) { assert.equal(t.reason, "db_error"); assert.match(t.detail, /socket hang up/); }

    for (const data of [null, undefined, "ok", { has_party: true }, { has_party: true, accounts: [], entries: "none" }, { accounts: [], entries: [] }]) {
      const { sc } = recorder(() => ({ data, error: null }));
      const r = await readPartyLedger(sc, PAYER);
      assert.equal(r.ok, false, JSON.stringify(data));
      if (!r.ok) assert.equal(r.reason, "db_error");
    }
    const noId = recorder(() => ({ data: { replayed: false }, error: null }));
    const p = await postPaymentTransaction(noId.sc, request());
    assert.equal(p.ok, false);
    const failedRead = recorder(() => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }));
    const f = await readPartyLedger(failedRead.sc, PAYER);
    assert.equal(f.ok, false, "a timed-out read is an error, not `entries: []`");
  });

  it("PS7. toMinorUnits renders digits: bigint, safe-integer number and digit string; everything else is null", () => {
    assert.equal(toMinorUnits(1250n), "1250");
    assert.equal(toMinorUnits(-1250n), "-1250");
    assert.equal(toMinorUnits(1250), "1250");
    assert.equal(toMinorUnits(-1250), "-1250");
    assert.equal(toMinorUnits("1250"), "1250");
    assert.equal(toMinorUnits("-1250"), "-1250");
    assert.equal(toMinorUnits(Number.MAX_SAFE_INTEGER), "9007199254740991");
    for (const v of [0.1, 1250.5, 2 ** 53, "1250.0", "+5", "0x10", "١٢", 10n ** 18n]) {
      assert.equal(toMinorUnits(v as any), null, String(v));
    }
  });

  it("PS8. the read sends the caller's profile id and the filter, and maps the page without touching an amount", async () => {
    const { sc, calls } = recorder(() => ({
      data: {
        has_party: true,
        accounts: [{ account_id: PAYEE, account_type: "user_payable", currency: "USD", balance_minor: "10000", entry_count: 2 }],
        entries: [{
          entry_id: "e-1", transaction_id: "t-1", account_id: PAYEE, account_type: "user_payable",
          amount_minor: "9000", currency: "USD", entry_reason: "principal", transaction_kind: "capture",
          cause_kind: "booking", cause_id: "b1", subject_kind: "booking", subject_id: "b1",
          attribution_version: "test/v1", reverses_transaction_id: null, occurred_at: "2026-10-04T09:00:00+00:00",
        }],
        next_cursor: { before_occurred_at: "2026-10-04T09:00:00+00:00", before_entry_id: "e-1" },
      },
      error: null,
    }));
    const r = await readPartyLedger(sc, PAYEE, {
      cause: { kind: "booking", id: "b1" }, limit: 1,
      cursor: { beforeOccurredAt: "2026-10-05T00:00:00Z", beforeEntryId: "e-9" },
    });
    assert.deepEqual(calls, [{ fn: "payment_party_ledger", args: { p: {
      profile_id: PAYEE, cause_kind: "booking", cause_id: "b1", limit: 1,
      before_occurred_at: "2026-10-05T00:00:00Z", before_entry_id: "e-9",
    } } }]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hasParty, true);
    assert.deepEqual(r.accounts, [{ accountId: PAYEE, accountType: "user_payable", currency: "USD", balanceMinor: "10000", entryCount: 2 }]);
    assert.equal(r.entries[0]!.amountMinor, "9000");
    assert.equal(typeof r.entries[0]!.amountMinor, "string");
    assert.deepEqual(r.nextCursor, { beforeOccurredAt: "2026-10-04T09:00:00+00:00", beforeEntryId: "e-1" });
    // The mapped entry has no counterparty field to carry.
    assert.deepEqual(Object.keys(r.entries[0]!).sort(), [
      "accountId", "accountType", "amountMinor", "attributionVersion", "causeId", "causeKind", "currency",
      "entryId", "entryReason", "occurredAt", "reversesTransactionId", "subjectId", "subjectKind",
      "transactionId", "transactionKind",
    ]);
  });

  it("PS8b. erasure sends only the profile id and returns counts — no party id is surfaced", async () => {
    const { sc, calls } = recorder(() => ({
      data: { removed: true, accounts: 2, entries_retained: 7, identity_removed_at: "2026-10-04T10:00:00+00:00", retention_period: null, retain_until: null },
      error: null,
    }));
    const r = await removePaymentIdentity(sc, PAYEE);
    assert.deepEqual(calls, [{ fn: "payment_party_remove_identity", args: { p: { profile_id: PAYEE } } }]);
    assert.deepEqual(r, {
      ok: true, removed: true, accounts: 2, entriesRetained: 7,
      identityRemovedAt: "2026-10-04T10:00:00+00:00", retentionPeriod: null, retainUntil: null,
    });
  });

  it("PS9. the read gate is fail-closed: an unreadable or absent flag is OFF", async () => {
    const answering = (result: any) => ({
      from: (table: string) => {
        assert.equal(table, "feature_flags");
        return { select: () => ({ eq: (col: string, flag: string) => {
          assert.equal(col, "flag");
          assert.equal(flag, PAYMENT_LEDGER_READS_FLAG);
          return { maybeSingle: async () => result };
        } }) };
      },
    });
    assert.equal(PAYMENT_LEDGER_READS_FLAG, "payment_ledger_reads_enabled");
    assert.equal(await paymentLedgerReadsEnabled(answering({ data: { enabled: true }, error: null })), true);
    assert.equal(await paymentLedgerReadsEnabled(answering({ data: { enabled: false }, error: null })), false);
    assert.equal(await paymentLedgerReadsEnabled(answering({ data: null, error: null })), false, "absent row");
    assert.equal(await paymentLedgerReadsEnabled(answering({ data: null, error: { message: "boom" } })), false, "unreadable");
  });
});
