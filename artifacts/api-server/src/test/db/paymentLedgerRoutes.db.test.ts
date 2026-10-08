/**
 * The payment read routes over the real router, the real auth guard and a real
 * PostgreSQL — `09` §10, PAY-073 (task PAY-T07).
 *
 * `routes/payments.ts` is mounted on an express app whose Supabase client is
 * `creatorLedgerPsqlClient`: tokens resolve to seeded users, the flag is
 * answered in memory (the database row stays FALSE), and every read runs
 * `public.payment_party_ledger` (3823) as service_role.
 *
 *   PR1  flag off: both routes answer feature_disabled — never an empty ledger
 *   PR2  no token / a bad token is 401, before the flag and before any parameter
 *   PR3  the payer reads only the payer's entries for a booking, the payee theirs
 *   PR4  a counterparty read returns nothing; naming another profile changes nothing
 *   PR5  accounts and balances are the caller's own, amounts are strings, livemode is false
 *   PR6  a malformed filter, limit or cursor is 400, not an empty page
 *   PR7  a failed read is an error (500 / 503), never `entries: []`
 *   PR8  the surface is read-only: no method but GET is served
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, rows, seedUser } from "./localDb.js";
import { creatorPsqlClient } from "./creatorLedgerPsqlClient.js";
import { paymentLedgerPurgeSql } from "./paymentLedgerFixture.js";
import { _setTestClient } from "../../lib/http.js";
import paymentsRouter from "../../routes/payments.js";
import {
  PAYMENT_LEDGER_READS_FLAG,
  ensurePaymentAccount,
  postPaymentTransaction,
} from "../../services/payments/PaymentLedger.js";

const RUN = randomUUID().slice(0, 8);
const SCOPE = `test-payb-routes-${RUN}`;
const PLATFORM = `t_platform_r_${RUN}`;
const BOOKING = `booking-routes-${RUN}`;
let payer = "", payee = "", third = "", nobody = "";
let aPayer = "", aPayee = "", aThird = "", aRevenue = "";
const users: string[] = [];
const accounts: string[] = [];
const tokens: Record<string, string> = {};
let server: http.Server | null = null;
let base = "";

function call(method: string, path: string, token: string | null): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b, raw }); });
    });
    r.on("error", reject);
    r.end();
  });
}

/** The client the routes see. `rpc` may be replaced to make the READ fail while auth still works. */
function install(flagOn: boolean, rpc?: (fn: string, args: any) => Promise<{ data: any; error: any }>) {
  const client = creatorPsqlClient({ flags: flagOn ? { [PAYMENT_LEDGER_READS_FLAG]: true } : {}, tokens });
  _setTestClient(rpc ? { ...client, rpc } : client, true);
}

describe("the payment read routes over a real database (09 §10, PAY-073)", { skip: !HAVE_DB }, () => {
  before(async () => {
    payer = seedUser("paybrpayer"); payee = seedUser("paybrpayee"); third = seedUser("paybrthird"); nobody = seedUser("paybrnobody");
    users.push(payer, payee, third, nobody);
    tokens["tok-payer"] = payer; tokens["tok-payee"] = payee; tokens["tok-third"] = third; tokens["tok-nobody"] = nobody;
    const sc = creatorPsqlClient();
    const acct = async (owner: any, accountType: any) => {
      const r = await ensurePaymentAccount(sc, { owner, accountType, currency: "USD" });
      assert.equal(r.ok, true, JSON.stringify(r));
      if (!r.ok) throw new Error("unreachable");
      accounts.push(r.accountId);
      return r.accountId;
    };
    aPayer = await acct({ kind: "user", profileId: payer }, "user_receivable");
    aPayee = await acct({ kind: "user", profileId: payee }, "user_payable");
    aThird = await acct({ kind: "user", profileId: third }, "user_payable");
    aRevenue = await acct({ kind: "platform", label: PLATFORM }, "platform_revenue");
    const posted = await postPaymentTransaction(sc, {
      scope: SCOPE, idempotencyKey: `${BOOKING}:capture`, kind: "capture",
      currency: "USD", originalCurrency: "USD", originalAmountMinor: 11000,
      attribution: { causeKind: "booking", causeId: BOOKING, subjectKind: "booking", subjectId: BOOKING, beneficiaryAccountId: aPayee, attributionVersion: "test-rules/v1" },
      externalRef: `pi_routes_${RUN}`, occurredAt: new Date().toISOString(),
      entries: [
        { accountId: aPayer, amountMinor: -11000, entryReason: "principal" },
        { accountId: aPayee, amountMinor: 9000, entryReason: "principal" },
        { accountId: aPayee, amountMinor: 1000, entryReason: "tip" },
        { accountId: aRevenue, amountMinor: 1000, entryReason: "platform_fee" },
      ],
    });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    install(true);
    const app = express();
    app.use(express.json());
    app.use(paymentsRouter);
    await new Promise<void>((res) => { server = app.listen(0, "127.0.0.1", () => res()); });
    const addr = server!.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    exec(paymentLedgerPurgeSql({ accountIds: accounts, profileIds: users, partyLabels: [PLATFORM], scope: SCOPE }));
  });

  test("PR1. flag off: both routes answer feature_disabled — not an empty ledger — and the database row is still FALSE", async () => {
    install(false);
    for (const path of ["/payments/me/accounts", "/payments/me/entries"]) {
      const r = await call("GET", path, "tok-payee");
      assert.equal(r.status, 404, path);
      assert.equal(r.body.error, "feature_disabled", path);
      assert.equal("entries" in r.body || "accounts" in r.body, false, path);
    }
    assert.deepEqual(rows<any>(`SELECT enabled FROM public.feature_flags WHERE flag = '${PAYMENT_LEDGER_READS_FLAG}'`), [{ enabled: false }]);
  });

  test("PR2. no token and a bad token are 401 — before the flag, and before any parameter is looked at", async () => {
    for (const flagOn of [true, false]) {
      install(flagOn);
      for (const path of ["/payments/me/accounts", "/payments/me/entries", "/payments/me/entries?limit=abc"]) {
        const none = await call("GET", path, null);
        assert.equal(none.status, 401, `${path} flag=${flagOn}`);
        assert.equal(none.body.error, "unauthenticated");
        const bad = await call("GET", path, "tok-forged");
        assert.equal(bad.status, 401, `${path} flag=${flagOn}`);
      }
    }
  });

  test("PR3. the payer reads the payer's entries for the booking and the payee theirs; neither response names the other side", async () => {
    install(true);
    const q = `/payments/me/entries?causeKind=booking&causeId=${BOOKING}`;
    const asPayer = await call("GET", q, "tok-payer");
    const asPayee = await call("GET", q, "tok-payee");
    assert.equal(asPayer.status, 200, asPayer.raw);
    assert.equal(asPayee.status, 200, asPayee.raw);
    assert.deepEqual(asPayer.body.entries.map((e: any) => [e.accountId, e.amountMinor, e.entryReason]), [[aPayer, "-11000", "principal"]]);
    assert.deepEqual(
      asPayee.body.entries.map((e: any) => [e.accountId, e.amountMinor, e.entryReason]).sort(),
      [[aPayee, "1000", "tip"], [aPayee, "9000", "principal"]],
    );
    assert.equal(asPayer.body.livemode, false);
    assert.equal(asPayer.body.hasPaymentAccount, true);
    assert.equal(asPayer.body.nextCursor, null);
    assert.ok(asPayer.body.entries.every((e: any) => typeof e.amountMinor === "string" && e.currency === "USD" && e.causeId === BOOKING));
    for (const needle of [aPayee, payee, aRevenue, `pi_routes_${RUN}`, SCOPE, `${BOOKING}:capture`]) {
      assert.equal(asPayer.raw.includes(needle), false, `the payer's response contains ${needle}`);
    }
    for (const needle of [aPayer, payer, aRevenue, `pi_routes_${RUN}`]) {
      assert.equal(asPayee.raw.includes(needle), false, `the payee's response contains ${needle}`);
    }
  });

  test("PR4. a counterparty read returns nothing, and no parameter can name another party", async () => {
    install(true);
    const q = `/payments/me/entries?causeKind=booking&causeId=${BOOKING}`;
    const asThird = await call("GET", q, "tok-third");
    assert.equal(asThird.status, 200, asThird.raw);
    assert.deepEqual(asThird.body.entries, [], "a party that is not in the booking reads none of its entries");
    assert.equal(asThird.body.hasPaymentAccount, true);
    const asNobody = await call("GET", "/payments/me/entries", "tok-nobody");
    assert.equal(asNobody.status, 200);
    assert.deepEqual({ e: asNobody.body.entries, h: asNobody.body.hasPaymentAccount }, { e: [], h: false });
    // Whatever the request claims about identity, the token decides.
    for (const extra of [`&profileId=${payee}`, `&profile_id=${payee}`, `&userId=${payee}`, `&accountId=${aPayee}`]) {
      const r = await call("GET", q + extra, "tok-third");
      assert.equal(r.status, 200, extra);
      assert.deepEqual(r.body.entries, [], extra);
      assert.equal(r.raw.includes(aPayee), false, extra);
    }
    for (const path of [`/payments/${payee}/entries`, `/payments/me/entries/${payee}`, `/payments/accounts/${aPayee}`]) {
      assert.equal((await call("GET", path, "tok-third")).status, 404, path);
    }
  });

  test("PR5. accounts: the caller's own, with posted balances as strings; a caller with no party has none", async () => {
    install(true);
    const asPayee = await call("GET", "/payments/me/accounts", "tok-payee");
    assert.equal(asPayee.status, 200, asPayee.raw);
    assert.deepEqual(asPayee.body, {
      livemode: false,
      hasPaymentAccount: true,
      accounts: [{ accountId: aPayee, accountType: "user_payable", currency: "USD", balanceMinor: "10000", entryCount: 2 }],
    });
    const asPayer = await call("GET", "/payments/me/accounts", "tok-payer");
    assert.deepEqual(asPayer.body.accounts, [{ accountId: aPayer, accountType: "user_receivable", currency: "USD", balanceMinor: "-11000", entryCount: 1 }]);
    const asThird = await call("GET", "/payments/me/accounts", "tok-third");
    assert.deepEqual(asThird.body.accounts, [{ accountId: aThird, accountType: "user_payable", currency: "USD", balanceMinor: "0", entryCount: 0 }]);
    const asNobody = await call("GET", "/payments/me/accounts", "tok-nobody");
    assert.deepEqual(asNobody.body, { livemode: false, hasPaymentAccount: false, accounts: [] });
  });

  test("PR6. a malformed filter, limit or cursor is 400 invalid_payload — not an empty page", async () => {
    install(true);
    for (const q of [
      "?limit=0", "?limit=201", "?limit=abc", "?limit=-1", "?limit=1.5", "?limit=1&limit=2",
      "?causeKind=booking", `?causeId=${BOOKING}`,
      "?beforeOccurredAt=2026-10-04T00:00:00Z", `?beforeEntryId=${randomUUID()}`,
      `?beforeOccurredAt=not-a-time&beforeEntryId=${randomUUID()}`,
      "?beforeOccurredAt=2026-10-04T00:00:00Z&beforeEntryId=not-a-uuid",
    ]) {
      const r = await call("GET", `/payments/me/entries${q}`, "tok-payee");
      assert.equal(r.status, 400, `${q}: ${r.raw}`);
      assert.equal(r.body.error, "invalid_payload", q);
      assert.equal("entries" in r.body, false, q);
    }
    // A well-formed page works and carries a cursor when there is more.
    const page = await call("GET", "/payments/me/entries?limit=1", "tok-payee");
    assert.equal(page.status, 200, page.raw);
    assert.equal(page.body.entries.length, 1);
    assert.ok(page.body.nextCursor?.beforeEntryId);
    const next = await call("GET",
      `/payments/me/entries?limit=1&beforeOccurredAt=${encodeURIComponent(page.body.nextCursor.beforeOccurredAt)}&beforeEntryId=${page.body.nextCursor.beforeEntryId}`,
      "tok-payee");
    assert.equal(next.status, 200, next.raw);
    assert.equal(next.body.entries.length, 1);
    assert.notEqual(next.body.entries[0].entryId, page.body.entries[0].entryId);
    assert.equal(next.body.nextCursor, null);
  });

  test("PR7. a failed read is an error, never an empty list: 503 when the ledger is not applied, 500 on any other failure", async () => {
    install(true, async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.payment_party_ledger(p) in the schema cache" } }));
    for (const path of ["/payments/me/accounts", "/payments/me/entries"]) {
      const r = await call("GET", path, "tok-payee");
      assert.equal(r.status, 503, `${path}: ${r.raw}`);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.retryable, true);
      assert.equal("entries" in r.body || "accounts" in r.body, false);
    }
    install(true, async () => ({ data: null, error: { code: "57014", message: 'canceling statement due to statement timeout on relation "payment_ledger_entries"' } }));
    for (const path of ["/payments/me/accounts", "/payments/me/entries"]) {
      const r = await call("GET", path, "tok-payee");
      assert.equal(r.status, 500, `${path}: ${r.raw}`);
      assert.equal(r.body.error, "db_error");
      assert.equal(r.raw.includes("payment_ledger_entries"), false, "the database's message is not relayed to the client");
      assert.equal("entries" in r.body || "accounts" in r.body, false);
    }
    // A result that is not the function's shape is a failed read too.
    install(true, async () => ({ data: { entries: null }, error: null }));
    assert.equal((await call("GET", "/payments/me/entries", "tok-payee")).status, 500);
    install(true, async () => { throw new Error("socket hang up"); });
    assert.equal((await call("GET", "/payments/me/entries", "tok-payee")).status, 500);
  });

  test("PR8. read-only: no method but GET is served on either path", async () => {
    install(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/payments/me/accounts", "/payments/me/entries"]) {
        assert.equal((await call(method, path, "tok-payee")).status, 404, `${method} ${path}`);
      }
    }
  });
});
