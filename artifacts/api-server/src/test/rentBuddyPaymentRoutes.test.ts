/**
 * The payment slice over HTTP: the real routers (routes/rentABuddyPayments.ts)
 * and the real webhook handler with its RAW-body parser, mounted the way app.ts
 * mounts them, with the dependencies injected — the deterministic fake
 * provider, the fake tax provider, and the in-memory store and ledger. Proves
 * the wiring the service suite cannot: auth, the Rent-a-Buddy master flag,
 * admin-only routes, the raw body reaching signature verification intact, and
 * the HTTP status of every answer.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyPaymentRoutes.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { createRentABuddyPaymentsRouter, createPaymentWebhookHandler, paymentWebhookRawParser, productionPaymentDeps } from "../routes/rentABuddyPayments.js";
import { createFakePaymentProvider, type FakePaymentProvider } from "../services/payments/FakePaymentProvider.js";
import { guardPaymentProvider, type WebhookDelivery } from "../services/payments/PaymentProvider.js";
import { enforcePaymentPolicy } from "../services/payments/providerRegistry.js";
import { createFakeTaxProvider } from "../services/payments/TaxProvider.js";
import type { PaymentSliceDeps } from "../services/payments/bookingPayments/deps.js";
import { createMemoryLedger, createMemoryStore, partyIdFor, type MemoryLedger, type MemoryStore } from "./helpers/memoryBookingPayments.js";

const LOCAL = { NODE_TEST_CONTEXT: "child-v8" } as unknown as NodeJS.ProcessEnv; // the test runner: a dev host no longer counts (N-2)
const TOKENS: Record<string, string> = { "t-traveler": "traveler-1", "t-buddy": "buddy-user-1", "t-admin": "admin-1", "t-stranger": "stranger-9" };
const ROLES: Record<string, string> = { "traveler-1": "user", "buddy-user-1": "user", "admin-1": "admin", "stranger-9": "user" };

let flags: Record<string, boolean>;
let fake: FakePaymentProvider;
let store: MemoryStore;
let ledger: MemoryLedger;
let deps: PaymentSliceDeps;
let server: http.Server;
let base = "";

/** Auth, profiles (role, account_status) and feature_flags — all the routes read through supabase. */
function authClient() {
  return {
    auth: { getUser: async (token: string) => (TOKENS[token] ? { data: { user: { id: TOKENS[token] } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) },
    from(table: string) {
      const f: Record<string, unknown> = {};
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { f[c] = v; return q; },
        maybeSingle: async () => {
          if (table === "feature_flags") return { data: { flag: f["flag"], enabled: !!flags[String(f["flag"])] }, error: null };
          if (table === "profiles") return { data: { id: f["id"], role: ROLES[String(f["id"])] ?? "user", account_status: null }, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  };
}

let keySeq = 0;
/** Every call carries a fresh Idempotency-Key unless `key` is given (or `null` to send none). */
async function call(method: string, path: string, token: string | null, body?: unknown, key?: string | null): Promise<{ status: number; body: any }> {
  const idem: Record<string, string> = key === null ? {} : { "idempotency-key": key ?? `test-key-${++keySeq}-${Date.now()}` };
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...idem, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function postWebhook(d: WebhookDelivery): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(d.headers)) if (typeof v === "string") headers[k] = v;
  const res = await fetch(`${base}/api/payments/webhooks/${d.endpoint}`, { method: "POST", headers, body: d.rawBody });
  await res.text();
  return res.status;
}

async function deliverAllOverHttp(): Promise<number[]> {
  const out: number[] = [];
  for (const d of fake.control.webhooks.deliver()) out.push(await postWebhook(d));
  return out;
}

before(async () => {
  const app = express();
  // As app.ts: the webhook BEFORE the JSON parser, so the raw bytes reach the signature check.
  app.post("/api/payments/webhooks/:endpoint", paymentWebhookRawParser, createPaymentWebhookHandler(() => deps));
  app.use(express.json());
  app.use("/api", createRentABuddyPaymentsRouter(() => deps));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  flags = { rent_buddy_enabled: true };
  fake = createFakePaymentProvider({ env: LOCAL });
  const tax = createFakeTaxProvider({ env: LOCAL });
  store = createMemoryStore();
  ledger = createMemoryLedger();
  let n = 0;
  deps = {
    provider: enforcePaymentPolicy(guardPaymentProvider(fake, () => null), { enabledMarkets: () => ["US"], taxProvider: () => tax }),
    tax, store, ledger,
    paymentsOperational: () => ({ operational: true, reason: "ok" }),
    bookingParties: async () => ({ allowed: true }),
    personVerified: async () => "verified",
    newId: () => `id-${++n}`,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  };
  store.bookings.set("booking-1", {
    bookingId: "booking-1", status: "confirmed", paymentStatus: "not_required", travelerId: "traveler-1",
    buddyProfileId: "bp-1", buddyUserId: "buddy-user-1", serviceCountry: "US", serviceMinor: 4000, currency: "USD",
    startsAt: "2026-08-20T01:00:00.000Z", startBasis: "earliest_possible", completedAt: null, disputeWindowExpiresAt: null, isTestBooking: false, paymentMode: "full_in_app",
  });
  const c = authClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

describe("the slice over HTTP, end to end against the fake provider", () => {
  it("onboard -> quote -> checkout -> confirm -> signed webhooks over HTTP -> captured; then a refund", async () => {
    const ob = await call("POST", "/api/rent-a-buddy/me/payouts/onboarding", "t-buddy", { country: "us", settlementCurrency: "usd" });
    assert.equal(ob.status, 200, JSON.stringify(ob.body));
    fake.control.setRecipientOnboarding(ob.body.recipientRef, "verified");
    assert.ok((await deliverAllOverHttp()).every((s) => s === 200));
    const acct = await call("GET", "/api/rent-a-buddy/me/payouts/account", "t-buddy");
    assert.equal(acct.body.payoutsEnabled, true);

    const q = await call("GET", "/api/rent-a-buddy/bookings/booking-1/payment/quote", "t-traveler");
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.quote.commission.rate, "10%");
    assert.equal(q.body.quote.total.amountMinor, 4400);

    const co = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/checkout", "t-traveler", { expectedTotalMinor: 4400 });
    assert.equal(co.status, 201, JSON.stringify(co.body));
    assert.equal(co.body.nextAction, "confirm_payment");
    const cf = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/confirm", "t-traveler", { paymentMethodRef: "fake_pm_card" });
    assert.equal(cf.status, 200, JSON.stringify(cf.body));
    assert.equal(store.bookings.get("booking-1")?.paymentStatus, "pending");

    const statuses = await deliverAllOverHttp();
    assert.ok(statuses.every((s) => s === 200), JSON.stringify(statuses));
    assert.equal(store.bookings.get("booking-1")?.paymentStatus, "captured");
    assert.equal(ledger.balance("user_payable", partyIdFor("buddy-user-1"), "USD"), -3600);

    const rf = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/refund", "t-traveler", { trigger: "cancelled_before_service" });
    assert.equal(rf.status, 202, JSON.stringify(rf.body));
    await deliverAllOverHttp();
    assert.equal(store.bookings.get("booking-1")?.paymentStatus, "refunded");
  });

  it("the RAW body reaches verification: a re-serialised body fails the signature (400), the original passes", async () => {
    const ob = await call("POST", "/api/rent-a-buddy/me/payouts/onboarding", "t-buddy", { country: "US", settlementCurrency: "USD" });
    fake.control.setRecipientOnboarding(ob.body.recipientRef, "verified");
    const [d] = fake.control.webhooks.deliver();
    assert.ok(d);
    const reserialised = { ...d!, rawBody: JSON.stringify(JSON.parse(d!.rawBody), null, 2) };
    assert.equal(await postWebhook(reserialised), 400);
    assert.equal(await postWebhook(d!), 200);
  });
});

describe("HTTP refusals", () => {
  it("no token -> 401; master flag off -> 403 feature_disabled; nothing created", async () => {
    assert.equal((await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/checkout", null, {})).status, 401);
    flags = { rent_buddy_enabled: false };
    const r = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/checkout", "t-traveler", {});
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(store.payments.size, 0);
  });

  it("a traveller cannot claim a safety refund or plan payouts (admin only)", async () => {
    const r = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/refund", "t-traveler", { trigger: "safety_issue_upheld" });
    assert.equal(r.status, 403);
    const p = await call("POST", "/api/admin/rent-a-buddy/payouts/plan", "t-traveler", { period: "2026-07" });
    assert.equal(p.status, 403);
    const ok = await call("POST", "/api/admin/rent-a-buddy/payouts/plan", "t-admin", { period: "2026-07" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("malformed amounts and unknown triggers are 400; an unknown webhook endpoint is 404", async () => {
    assert.equal((await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/checkout", "t-traveler", { tipMinor: -5 })).status, 400);
    assert.equal((await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/refund", "t-traveler", { trigger: "because" })).status, 400);
    const res = await fetch(`${base}/api/payments/webhooks/other`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
  });
});

describe("the PRODUCTION binding refuses: no provider is configured and no ledger is bound on this tree", () => {
  it("with PAYMENT_PROVIDER unset, payments are not operational and checkout answers 503 creating nothing", async () => {
    const saved = process.env["PAYMENT_PROVIDER"];
    delete process.env["PAYMENT_PROVIDER"];
    try {
      const prod = productionPaymentDeps(authClient());
      assert.equal(prod.provider.id, "none");
      assert.equal(prod.paymentsOperational().operational, false);
      const { startBookingCheckout } = await import("../services/payments/bookingPayments/checkout.js");
      const r = await startBookingCheckout(prod, { bookingId: "booking-1", actorUserId: "traveler-1" });
      assert.equal(r.httpStatus, 503);
      assert.equal(r.body["error"], "payments_unavailable");
    } finally {
      if (saved !== undefined) process.env["PAYMENT_PROVIDER"] = saved;
    }
  });

  it("the production ledger is #598's posting function: where it is not applied it answers ledger_unavailable, so a money-booking webhook is never acknowledged unbooked", async () => {
    // A database without 3821-3823: PostgREST answers PGRST202 (function not found) to every rpc.
    const noLedger = { ...authClient(), rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.payment_account_ensure" } }) };
    const prod = productionPaymentDeps(noLedger);
    const r = await prod.ledger.post({
      key: "rabpay:p-1:captured:4400:fee:800", kind: "capture", currency: "USD", occurredAt: "2026-08-10T12:00:00.000Z",
      subjectId: "p-1", bookingId: "b-1", processor: "fake", externalRef: "fake_pi_000001",
      entries: [
        { account: "processor_clearing", partyId: null, amountMinor: 4400, reason: "principal" },
        { account: "platform_revenue", partyId: null, amountMinor: -4400, reason: "platform_fee" },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "ledger_unavailable", r.detail);
  });
});

describe("money routes require an Idempotency-Key bound to the caller's payment party (#598 requireIdempotencyKey)", () => {
  async function paid(): Promise<void> {
    const ob = await call("POST", "/api/rent-a-buddy/me/payouts/onboarding", "t-buddy", { country: "US", settlementCurrency: "USD" });
    fake.control.setRecipientOnboarding(ob.body.recipientRef, "verified");
    await deliverAllOverHttp();
    await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/checkout", "t-traveler", {});
    await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/confirm", "t-traveler", { paymentMethodRef: "fake_pm_card" });
    await deliverAllOverHttp();
  }

  it("no header -> 400 idempotency_key_required on checkout, confirm and refund; nothing is created", async () => {
    for (const [path, body] of [
      ["/api/rent-a-buddy/bookings/booking-1/payment/checkout", {}],
      ["/api/rent-a-buddy/bookings/booking-1/payment/confirm", { paymentMethodRef: "fake_pm_card" }],
      ["/api/rent-a-buddy/bookings/booking-1/payment/refund", { trigger: "cancelled_before_service" }],
    ] as const) {
      const r = await call("POST", path, "t-traveler", body, null);
      assert.equal(r.status, 400, `${path}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.reason, "idempotency_key_required", path);
    }
    assert.equal(store.payments.size, 0);
  });

  it("a support refund double-submitted with the SAME key is ONE refund; a new key is a new decision", async () => {
    await paid();
    const a = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/refund", "t-admin", { trigger: "support_decision", amountMinor: 500 }, "support-click-1");
    const b = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/refund", "t-admin", { trigger: "support_decision", amountMinor: 500 }, "support-click-1");
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(b.status, 202, JSON.stringify(b.body));
    assert.equal(store.refunds.size, 1, "the same key is the same refund");
    const c = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/refund", "t-admin", { trigger: "support_decision", amountMinor: 500 }, "support-click-2");
    assert.equal(c.status, 202, JSON.stringify(c.body));
    assert.equal(store.refunds.size, 2);
  });
});

// ── Verifier F2 (2026-10-06): authorise BEFORE any payment party is ensured ──
describe("F2: a caller who is not a party to the booking creates nothing and learns nothing", () => {
  const routes: Array<[string, string, string, unknown]> = [
    ["checkout", "POST", "payment/checkout", { tipMinor: 0 }],
    ["confirm", "POST", "payment/confirm", { paymentMethodRef: "fake_pm_card" }],
    ["refund", "POST", "payment/refund", { trigger: "cancelled_before_service" }],
    ["quote", "GET", "payment/quote", undefined],
  ];
  for (const [name, method, tail, body] of routes) {
    it(`${name}: a stranger on a REAL booking gets the same 404 as on an unknown id, and no party, account or payment is created`, async () => {
      const real = await call(method, `/api/rent-a-buddy/bookings/booking-1/${tail}`, "t-stranger", body);
      const unknown = await call(method, `/api/rent-a-buddy/bookings/booking-does-not-exist/${tail}`, "t-stranger", body);
      assert.equal(real.status, 404, JSON.stringify(real.body));
      assert.deepEqual([real.status, real.body], [unknown.status, unknown.body], "no 403/404 oracle");
      assert.equal(store.parties.has("stranger-9"), false, "no payment party was ensured for a stranger");
      assert.equal(store.payments.size, 0);
      assert.equal(store.refunds.size, 0);
    });
  }
  it("control: the traveller on the same booking is not refused as a stranger", async () => {
    const r = await call("POST", "/api/rent-a-buddy/bookings/booking-1/payment/checkout", "t-traveler", { tipMinor: 0 });
    assert.notEqual(r.status, 404, JSON.stringify(r.body));
    assert.equal(store.parties.has("traveler-1"), true, "the traveller's own party is bound to their key");
  });
});
