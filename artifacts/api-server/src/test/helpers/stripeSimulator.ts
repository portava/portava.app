/**
 * A STUB of the parts of the Stripe API the Connect adapter calls
 * (services/payments/StripeConnectProvider.ts), as a `StripeTransport`.
 *
 * It is NOT Stripe and proves nothing about Stripe. It answers in the shapes
 * Stripe documents (docs.stripe.com, fetched 2026-10-05), keeps enough state
 * to run the provider contract suite, and RECORDS every request so a test can
 * assert its method, path, form fields, Idempotency-Key and Stripe-Account.
 * Where Stripe's exact behaviour is not documented (how a partial refund rounds
 * the application fee, the error code for an uncancellable payout) the stub's
 * choice is its own and is named where it is made. No socket is opened.
 *
 * It emits events the way Stripe does for direct charges — on the CONNECT
 * endpoint, with `account` set — and signs them with the env's webhook secrets.
 */
import crypto from "node:crypto";

import type { StripeRequest, StripeResponse, StripeTransport } from "../../services/payments/StripeConnectProvider.js";
import type { WebhookDelivery, WebhookEndpoint } from "../../services/payments/PaymentProvider.js";

type Obj = Record<string, unknown>;

export interface RecordedRequest extends StripeRequest {
  /** The form as a map (last value wins). */
  readonly formMap: Readonly<Record<string, string>>;
}

export interface StripeSimulator {
  readonly transport: StripeTransport;
  readonly requests: RecordedRequest[];
  /** Requests that broke a rule the adapter must keep (no key, no Idempotency-Key on a POST, Stripe-Account where it must not be …). */
  readonly violations: string[];
  readonly control: {
    verifyAccount(acct: string): void;
    pendingAccount(acct: string): void;
    rejectAccount(acct: string): void;
    declineNextConfirm(declineCode?: string): void;
    requireActionNextConfirm(): void;
    /** The next request answers this HTTP status with no usable body (5xx, 429), or throws (status 0). */
    failNext(status: number): void;
    payPayout(payoutRef: string): void;
    openDispute(intentRef: string): void;
    /** Signed deliveries of every event not yet handed out, oldest first. */
    deliveries(opts?: { livemode?: boolean }): WebhookDelivery[];
    sign(rawBody: string, endpoint: WebhookEndpoint): WebhookDelivery;
  };
}

export function createStripeSimulator(opts: { env: NodeJS.ProcessEnv; nowMs: () => number }): StripeSimulator {
  const requests: RecordedRequest[] = [];
  const violations: string[] = [];
  const accounts = new Map<string, Obj>();
  const intents = new Map<string, Obj & { _account: string }>();
  const charges = new Map<string, Obj>();
  const fees = new Map<string, Obj>();
  const payouts = new Map<string, Obj & { _account: string }>();
  const idem = new Map<string, { signature: string; response: StripeResponse }>();
  const outbox: Array<{ id: string; type: string; account: string | null; object: Obj; created: number }> = [];
  let seq = 0;
  let declineNext: string | null = null;
  let actionNext = false;
  let failNext: number | null = null;
  const next = (p: string) => `${p}_sim${String(++seq).padStart(6, "0")}`;
  const now = () => Math.floor(opts.nowMs() / 1000);
  const ok = (body: Obj): StripeResponse => ({ status: 200, body: JSON.parse(JSON.stringify(body)) });
  const err = (status: number, type: string, code: string | null, extra: Obj = {}): StripeResponse =>
    ({ status, body: { error: { type, ...(code ? { code } : {}), message: "(stub)", ...extra } } });
  const emit = (type: string, account: string | null, object: Obj) =>
    outbox.push({ id: next("evt"), type, account, object: JSON.parse(JSON.stringify(object)), created: now() });
  const publicIntent = (pi: Obj) => {
    const { _account: _a, ...rest } = pi as Obj & { _account?: string };
    return rest;
  };
  const balanceOf = (acct: string, currency: string): number => {
    let n = 0;
    for (const pi of intents.values()) {
      if (pi._account !== acct || pi["currency"] !== currency || pi["status"] !== "succeeded") continue;
      const ch = charges.get(String(pi["latest_charge"]));
      const fee = ch && ch["application_fee"] ? fees.get(String(ch["application_fee"])) : undefined;
      n += Number(pi["amount_received"]) - Number(ch?.["amount_refunded"] ?? 0) - (fee ? Number(fee["amount"]) - Number(fee["amount_refunded"]) : 0);
    }
    for (const po of payouts.values()) if (po._account === acct && po["currency"] === currency && po["status"] !== "canceled" && po["status"] !== "failed") n -= Number(po["amount"]);
    return n;
  };

  const handle = (req: StripeRequest, f: Readonly<Record<string, string>>): StripeResponse => {
    const account = req.headers["Stripe-Account"] ?? null;
    const p = req.path;
    let m: RegExpMatchArray | null;

    // ── connected accounts ───────────────────────────────────────────────────
    if (req.method === "POST" && p === "/v1/accounts") {
      if (account) violations.push("POST /v1/accounts carried Stripe-Account");
      for (const k of ["country", "default_currency", "controller[fees][payer]", "controller[losses][payments]", "controller[stripe_dashboard][type]"]) {
        if (!f[k]) return err(400, "invalid_request_error", "parameter_missing", { param: k });
      }
      if (f["controller[losses][payments]"] === "application" && f["controller[fees][payer]"] !== "application") {
        return err(400, "invalid_request_error", "invalid_controller"); // docs: losses=application requires fees=application
      }
      const a: Obj = {
        id: next("acct"), object: "account", country: f["country"], default_currency: f["default_currency"],
        business_type: f["business_type"] ?? null, charges_enabled: false, payouts_enabled: false, details_submitted: false,
        controller: { fees: { payer: f["controller[fees][payer]"] }, losses: { payments: f["controller[losses][payments]"] }, stripe_dashboard: { type: f["controller[stripe_dashboard][type]"] } },
        requirements: { currently_due: ["individual.id_number", "external_account", "tos_acceptance.date"], pending_verification: [], disabled_reason: "requirements.past_due", current_deadline: null },
        metadata: { portava_ref: f["metadata[portava_ref]"] ?? "" }, livemode: false,
      };
      accounts.set(String(a["id"]), a);
      emit("account.updated", String(a["id"]), a);
      return ok(a);
    }
    if (req.method === "GET" && (m = p.match(/^\/v1\/accounts\/([^/]+)$/))) {
      const a = accounts.get(decodeURIComponent(m[1]!));
      return a ? ok(a) : err(404, "invalid_request_error", "resource_missing");
    }
    if (req.method === "POST" && p === "/v1/account_links") {
      if (account) violations.push("POST /v1/account_links carried Stripe-Account");
      if (!accounts.has(f["account"] ?? "")) return err(404, "invalid_request_error", "resource_missing");
      if (f["type"] !== "account_onboarding" || !f["refresh_url"] || !f["return_url"]) return err(400, "invalid_request_error", "parameter_missing");
      return ok({ object: "account_link", url: `https://connect.stripe.invalid/setup/${next("link")}`, created: now(), expires_at: now() + 300 });
    }

    // ── payment intents (direct charges: on the connected account) ───────────
    if (p.startsWith("/v1/payment_intents") && !account) violations.push(`${req.method} ${p} without Stripe-Account (a direct charge lives on the connected account)`);
    if (req.method === "POST" && p === "/v1/payment_intents") {
      const a = account ? accounts.get(account) : undefined;
      if (!a) return err(404, "invalid_request_error", "resource_missing");
      if (a["charges_enabled"] !== true) return err(400, "invalid_request_error", "account_invalid");
      const amount = Number(f["amount"]);
      const fee = f["application_fee_amount"] === undefined ? null : Number(f["application_fee_amount"]);
      if (fee !== null && !(fee > 0 && fee < amount)) return err(400, "invalid_request_error", "application_fee_amount_invalid"); // docs: positive and less than the charge
      const metadata: Obj = {};
      for (const [k, v] of Object.entries(f)) { const mm = k.match(/^metadata\[(.+)\]$/); if (mm) metadata[mm[1]!] = v; }
      const id = next("pi");
      const pi = {
        _account: account as string, id, object: "payment_intent", amount, currency: f["currency"], status: "requires_payment_method",
        capture_method: f["capture_method"] ?? "automatic", amount_capturable: 0, amount_received: 0, client_secret: `${id}_secret_sim`,
        application_fee_amount: fee, metadata, livemode: false, latest_charge: null, next_action: null, last_payment_error: null,
      };
      intents.set(id, pi);
      emit("payment_intent.created", account, publicIntent(pi));
      return ok(publicIntent(pi));
    }
    if ((m = p.match(/^\/v1\/payment_intents\/([^/]+)(\/(confirm|capture|cancel))?$/))) {
      const pi = intents.get(decodeURIComponent(m[1]!));
      if (!pi || pi._account !== account) return err(404, "invalid_request_error", "resource_missing");
      const action = m[3];
      if (req.method === "GET" && !action) {
        const expanded = req.query.some(([k, v]) => k === "expand[]" && v === "latest_charge");
        const body = publicIntent(pi);
        if (expanded && pi["latest_charge"]) body["latest_charge"] = charges.get(String(pi["latest_charge"])) ?? null;
        return ok(body);
      }
      if (req.method !== "POST") return err(400, "invalid_request_error", "method_not_allowed");
      if (action === "confirm") {
        if (pi["status"] !== "requires_payment_method" && pi["status"] !== "requires_confirmation") return err(400, "invalid_request_error", "payment_intent_unexpected_state");
        if (declineNext) {
          const code = declineNext;
          declineNext = null;
          pi["status"] = "requires_payment_method";
          pi["last_payment_error"] = { type: "card_error", code: "card_declined", decline_code: code };
          emit("payment_intent.payment_failed", account, publicIntent(pi));
          return err(402, "card_error", "card_declined", { decline_code: code, payment_intent: publicIntent(pi) });
        }
        if (actionNext) {
          actionNext = false;
          pi["status"] = "requires_action";
          pi["next_action"] = f["return_url"] ? { type: "redirect_to_url", redirect_to_url: { url: `https://hooks.stripe.invalid/3ds/${pi["id"]}`, return_url: f["return_url"] } } : { type: "use_stripe_sdk" };
          emit("payment_intent.requires_action", account, publicIntent(pi));
          return ok(publicIntent(pi));
        }
        const ch: Obj = { id: next("ch"), object: "charge", payment_intent: pi["id"], amount_refunded: 0, application_fee: null };
        charges.set(String(ch["id"]), ch);
        pi["latest_charge"] = ch["id"];
        if (pi["capture_method"] === "manual") {
          pi["status"] = "requires_capture";
          pi["amount_capturable"] = pi["amount"];
          emit("payment_intent.amount_capturable_updated", account, publicIntent(pi));
        } else {
          pi["status"] = "succeeded";
          pi["amount_received"] = pi["amount"];
          if (pi["application_fee_amount"]) {
            const fee: Obj = { id: next("fee"), object: "application_fee", amount: pi["application_fee_amount"], amount_refunded: 0 };
            fees.set(String(fee["id"]), fee);
            ch["application_fee"] = fee["id"];
          }
          emit("payment_intent.succeeded", account, publicIntent(pi));
        }
        return ok(publicIntent(pi));
      }
      if (action === "capture") {
        if (pi["status"] !== "requires_capture") return err(400, "invalid_request_error", "payment_intent_unexpected_state");
        const amount = Number(f["amount_to_capture"] ?? pi["amount_capturable"]);
        if (amount > Number(pi["amount_capturable"])) return err(400, "invalid_request_error", "amount_too_large");
        pi["status"] = "succeeded";
        pi["amount_received"] = amount;
        pi["amount_capturable"] = 0;
        const feeAmount = f["application_fee_amount"] === undefined ? Number(pi["application_fee_amount"] ?? 0) : Number(f["application_fee_amount"]);
        if (feeAmount > 0) {
          const fee: Obj = { id: next("fee"), object: "application_fee", amount: feeAmount, amount_refunded: 0 };
          fees.set(String(fee["id"]), fee);
          (charges.get(String(pi["latest_charge"])) as Obj)["application_fee"] = fee["id"];
        }
        emit("payment_intent.succeeded", account, publicIntent(pi));
        return ok(publicIntent(pi));
      }
      if (action === "cancel") {
        if (["succeeded", "processing", "canceled"].includes(String(pi["status"]))) return err(400, "invalid_request_error", "payment_intent_unexpected_state");
        pi["status"] = "canceled";
        pi["amount_capturable"] = 0;
        pi["cancellation_reason"] = f["cancellation_reason"] ?? null;
        emit("payment_intent.canceled", account, publicIntent(pi));
        return ok(publicIntent(pi));
      }
    }

    // ── refunds, on the connected account ────────────────────────────────────
    if (req.method === "POST" && p === "/v1/refunds") {
      if (!account) violations.push("POST /v1/refunds without Stripe-Account");
      if (f["refund_application_fee"] !== "true" && f["refund_application_fee"] !== "false") violations.push("a refund did not STATE refund_application_fee");
      const pi = intents.get(f["payment_intent"] ?? "");
      if (!pi || pi._account !== account) return err(404, "invalid_request_error", "resource_missing");
      if (pi["status"] !== "succeeded") return err(400, "invalid_request_error", "payment_intent_unexpected_state");
      const ch = charges.get(String(pi["latest_charge"])) as Obj;
      const remaining = Number(pi["amount_received"]) - Number(ch["amount_refunded"]);
      const amount = f["amount"] === undefined ? remaining : Number(f["amount"]);
      if (remaining <= 0) return err(400, "invalid_request_error", "charge_already_refunded");
      if (amount > remaining) return err(400, "invalid_request_error", "amount_too_large");
      ch["amount_refunded"] = Number(ch["amount_refunded"]) + amount;
      if (f["refund_application_fee"] === "true" && ch["application_fee"]) {
        const fee = fees.get(String(ch["application_fee"])) as Obj;
        const full = Number(ch["amount_refunded"]) >= Number(pi["amount_received"]);
        // The STUB's rounding for a partial refund (floor of the proportional share); Stripe documents "a proportional amount" only.
        const share = full ? Number(fee["amount"]) - Number(fee["amount_refunded"]) : Math.floor((Number(fee["amount"]) * amount) / Number(pi["amount_received"]));
        fee["amount_refunded"] = Number(fee["amount_refunded"]) + share;
      }
      const re: Obj = { id: next("re"), object: "refund", amount, currency: pi["currency"], status: "succeeded", payment_intent: pi["id"], charge: ch["id"], metadata: {}, livemode: false };
      for (const [k, v] of Object.entries(f)) { const mm = k.match(/^metadata\[(.+)\]$/); if (mm) (re["metadata"] as Obj)[mm[1]!] = v; }
      emit("refund.created", account, re);
      emit("charge.refunded", account, ch);
      return ok(re);
    }
    if (req.method === "GET" && (m = p.match(/^\/v1\/application_fees\/([^/]+)$/))) {
      if (account) violations.push("GET /v1/application_fees carried Stripe-Account (fees live on the platform)");
      const fee = fees.get(decodeURIComponent(m[1]!));
      return fee ? ok(fee) : err(404, "invalid_request_error", "resource_missing");
    }

    // ── payouts, on the connected account ────────────────────────────────────
    if (p.startsWith("/v1/payouts") && !account) violations.push(`${req.method} ${p} without Stripe-Account`);
    if (req.method === "POST" && p === "/v1/payouts") {
      const a = account ? accounts.get(account) : undefined;
      if (!a) return err(404, "invalid_request_error", "resource_missing");
      if (a["payouts_enabled"] !== true) return err(400, "invalid_request_error", "payouts_not_allowed");
      const amount = Number(f["amount"]);
      if (amount > balanceOf(account as string, f["currency"] ?? "")) return err(400, "invalid_request_error", "balance_insufficient");
      const metadata: Obj = {};
      for (const [k, v] of Object.entries(f)) { const mm = k.match(/^metadata\[(.+)\]$/); if (mm) metadata[mm[1]!] = v; }
      const po = { _account: account as string, id: next("po"), object: "payout", amount, currency: f["currency"], status: "pending", automatic: false, failure_code: null, arrival_date: now() + 2 * 86400, metadata, livemode: false };
      payouts.set(po.id, po);
      const { _account: _x, ...pub } = po;
      emit("payout.created", account, pub);
      return ok(pub);
    }
    if ((m = p.match(/^\/v1\/payouts\/([^/]+)(\/cancel)?$/))) {
      const po = payouts.get(decodeURIComponent(m[1]!));
      if (!po || po._account !== account) return err(404, "invalid_request_error", "resource_missing");
      if (m[2]) {
        // The STUB's code for an uncancellable payout; Stripe documents only that a `pending` payout can be cancelled.
        if (po["status"] !== "pending") return err(400, "invalid_request_error", "payout_not_cancelable");
        po["status"] = "canceled";
        const { _account: _x, ...pub } = po;
        emit("payout.canceled", account, pub);
      }
      const { _account: _y, ...pub } = po;
      return ok(pub);
    }
    return err(404, "invalid_request_error", "resource_missing");
  };

  const transport: StripeTransport = async (req) => {
    const formMap: Record<string, string> = {};
    for (const [k, v] of req.form) formMap[k] = v;
    requests.push({ ...req, formMap });
    const auth = req.headers["Authorization"] ?? "";
    if (!/^Bearer sk_test_/.test(auth)) violations.push(`${req.method} ${req.path} without a TEST key`);
    if (req.method === "POST" && !req.headers["Idempotency-Key"]) violations.push(`POST ${req.path} without an Idempotency-Key`);
    if (failNext !== null) {
      const s = failNext;
      failNext = null;
      if (s === 0) throw new Error("socket hang up (stub)");
      return { status: s, body: null };
    }
    const key = req.headers["Idempotency-Key"];
    if (req.method === "POST" && key) {
      const scope = `${req.headers["Stripe-Account"] ?? "platform"}|${key}`;
      const signature = JSON.stringify([req.path, req.form]);
      const seen = idem.get(scope);
      if (seen) return seen.signature === signature ? seen.response : err(400, "idempotency_error", null);
      const response = handle(req, formMap);
      idem.set(scope, { signature, response });
      return response;
    }
    return handle(req, formMap);
  };

  const secretFor = (endpoint: WebhookEndpoint) => String(opts.env[endpoint === "connect" ? "STRIPE_CONNECT_WEBHOOK_SECRET" : "STRIPE_WEBHOOK_SECRET"] ?? "");
  const sign = (rawBody: string, endpoint: WebhookEndpoint): WebhookDelivery => {
    const t = now();
    const v1 = crypto.createHmac("sha256", secretFor(endpoint)).update(`${t}.${rawBody}`, "utf8").digest("hex");
    return { rawBody, headers: { "stripe-signature": `t=${t},v1=${v1}` }, endpoint };
  };

  return {
    transport,
    requests,
    violations,
    control: {
      verifyAccount(acct) {
        const a = accounts.get(acct) as Obj;
        Object.assign(a, { details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [], pending_verification: [], disabled_reason: null, current_deadline: null } });
        emit("account.updated", acct, a);
      },
      pendingAccount(acct) {
        const a = accounts.get(acct) as Obj;
        Object.assign(a, { details_submitted: true, charges_enabled: false, payouts_enabled: false, requirements: { currently_due: [], pending_verification: ["individual.verification.document"], disabled_reason: "requirements.pending_verification", current_deadline: null } });
        emit("account.updated", acct, a);
      },
      rejectAccount(acct) {
        const a = accounts.get(acct) as Obj;
        Object.assign(a, { details_submitted: true, charges_enabled: false, payouts_enabled: false, requirements: { currently_due: [], pending_verification: [], disabled_reason: "rejected.other", current_deadline: null } });
        emit("account.updated", acct, a);
      },
      declineNextConfirm(code = "insufficient_funds") { declineNext = code; },
      requireActionNextConfirm() { actionNext = true; },
      failNext(status) { failNext = status; },
      payPayout(ref) {
        const po = payouts.get(ref) as Obj & { _account: string };
        po["status"] = "paid";
        const { _account: acct, ...pub } = po;
        emit("payout.paid", acct, pub);
      },
      openDispute(intentRef) {
        const pi = intents.get(intentRef) as Obj & { _account: string };
        emit("charge.dispute.created", pi._account, { id: next("dp"), object: "dispute", payment_intent: intentRef, amount: pi["amount_received"], currency: pi["currency"], status: "needs_response", reason: "fraudulent", livemode: false });
      },
      deliveries(o = {}) {
        const out = outbox.splice(0, outbox.length);
        return out.map((e) => {
          const endpoint: WebhookEndpoint = e.account ? "connect" : "platform";
          const raw = JSON.stringify({ id: e.id, object: "event", type: e.type, created: e.created, livemode: o.livemode === true, ...(e.account ? { account: e.account } : {}), data: { object: e.object } });
          return sign(raw, endpoint);
        });
      },
      sign,
    },
  };
}
