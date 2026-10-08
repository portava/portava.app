/**
 * Rent-a-Buddy payments — the HTTP surface of the payment slice
 * (services/payments/bookingPayments/). TEST MODE ONLY: the provider comes from
 * services/payments/providerRegistry.ts, which resolves `none` by default (every
 * operation refused), the deterministic fake only in a local run, and a real
 * adapter only once one is registered and certified — none is today.
 *
 *   GET  /rent-a-buddy/bookings/:bookingId/payment/quote      traveller: the price lines, commission shown
 *   POST /rent-a-buddy/bookings/:bookingId/payment/checkout   traveller: create/resume the payment
 *   POST /rent-a-buddy/bookings/:bookingId/payment/confirm    traveller: confirm with a payment method
 *   POST /rent-a-buddy/bookings/:bookingId/payment/refund     traveller / buddy / admin, by the owner's refund rules
 *   POST /rent-a-buddy/me/payouts/onboarding                  buddy: provider account + hosted onboarding link
 *   GET  /rent-a-buddy/me/payouts/account                     buddy: onboarding state (codes only)
 *   POST /admin/rent-a-buddy/payouts/plan                     admin: plan a month's payouts
 *   POST /admin/rent-a-buddy/payouts/execute                  admin: request planned payouts
 *   POST /admin/rent-a-buddy/payouts/:payoutId/hold|release   admin: hold / release a planned payout
 *   POST /api/payments/webhooks/:endpoint                     provider → us; RAW body, mounted in app.ts
 *                                                             before the JSON parser
 *
 * Every user route also requires `rent_buddy_enabled` (FALSE in production,
 * migration 2210), exactly as the rest of Rent-a-Buddy does.
 */
import express, { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireIdempotencyKey, requireUser, sendError } from "../lib/http.js";
import { createHash } from "node:crypto";
import { requireAdmin } from "../lib/requireAdmin.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkBookingParties } from "../lib/rentBuddyIdentityEligibility.js";
import { readCurrentIdentityVerification } from "../services/identityVerification/currentVerification.js";
import { getPaymentProvider } from "../services/payments/providerRegistry.js";
import { taxProviderOrNone } from "../services/payments/TaxProvider.js";
import { paymentsReadiness } from "../services/payments/readiness.js";
import type { WebhookEndpoint } from "../services/payments/PaymentProvider.js";
import type { PaymentSliceDeps, SliceOutcome } from "../services/payments/bookingPayments/deps.js"; import type { BookingForPayment } from "../services/payments/bookingPayments/model.js";
import { paymentLedgerAdapter } from "../services/payments/bookingPayments/ledgerAdapter.js";
import { supabaseBookingPaymentStore } from "../services/payments/bookingPayments/supabaseStore.js";
import { confirmBookingPayment, quoteBookingPayment, startBookingCheckout } from "../services/payments/bookingPayments/checkout.js";
import { REFUND_TRIGGERS, requestBookingRefund, type RefundTrigger } from "../services/payments/bookingPayments/refunds.js";
import { refreshRecipient, startRecipientOnboarding } from "../services/payments/bookingPayments/recipients.js";
import { executePlannedPayouts, holdOrReleasePayout, payoutPolicyFromEnv, planMonthlyPayouts } from "../services/payments/bookingPayments/payouts.js";
import { processPaymentWebhook } from "../services/payments/bookingPayments/webhookProcessor.js";
import { requireRentBuddyEnabled } from "./rentABuddy.js";

/** The production dependencies over a service-role client. */
export function productionPaymentDeps(sc: any): PaymentSliceDeps {
  return {
    provider: getPaymentProvider(),
    tax: taxProviderOrNone(),
    store: supabaseBookingPaymentStore(sc),
    // PR #598's double-entry ledger (payment_post_transaction, 3822). Unapplied
    // anywhere today, so it answers ledger_unavailable and every webhook that must
    // book money is a 503 the provider retries — never money acknowledged unbooked.
    ledger: paymentLedgerAdapter(sc),
    paymentsOperational: () => {
      const r = paymentsReadiness();
      return { operational: r.operational, reason: r.reason };
    },
    bookingParties: (booking) => checkBookingParties(sc, { travelerId: booking.travelerId, buddyUserId: booking.buddyUserId }),
    personVerified: async (userId) => {
      const v = await readCurrentIdentityVerification(sc, userId);
      if (v.state === "unreadable") return "unreadable";
      return v.state === "verified" && v.adult ? "verified" : "not_verified";
    },
    newId: () => randomUUID(),
    now: () => new Date(),
  };
}

function send(res: Response, o: SliceOutcome): void {
  res.status(o.httpStatus).json(o.body);
}

const intOrUndefined = (v: unknown): number | undefined | null => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const UUIDISH = /^[0-9a-f-]{8,64}$/i;

/**
 * Money routes take an `Idempotency-Key` header, bound to the CALLER's payment
 * party (lib/http.ts requireIdempotencyKey, #598): a retried request is the
 * same request, and two callers who pick the same key never meet. The party is
 * the traveller's receivable side or the buddy's payable side in the booking's
 * currency (3821 payment_account_ensure — the pseudonym, never the profile id).
 * Answers the hashed, scoped key, or null after writing the refusal.
 */
async function boundRequestKey(
  req: Request, res: Response, deps: PaymentSliceDeps, userId: string, bookingId: string, operation: string, actsForPlatform = false,
): Promise<string | null> {
  // AUTHORISE FIRST (verifier F2): nothing is ensured, bound or created for a
  // caller who is not a party to this booking (support acting for the platform
  // excepted), and a non-party learns nothing about whether the id exists.
  const booking = await requireBookingParty(res, deps, userId, bookingId, actsForPlatform);
  if (!booking) return null;
  const role = booking.travelerId === userId ? "user_receivable" : "user_payable";
  // Support is not a payment party; it acts for the PLATFORM, whose party binds its keys.
  const party = actsForPlatform ? await deps.store.ensurePlatformParty(booking.currency) : await deps.store.ensureUserParty(userId, booking.currency, role);
  if (!party.ok) { sendError(res, "degraded_unavailable", "Your payment account could not be resolved."); return null; }
  const bound = requireIdempotencyKey(req, res, { operation, actorPartyId: party.value });
  if (!bound) return null;
  return createHash("sha256").update(`${bound.scope}|${bound.idempotencyKey}`).digest("hex").slice(0, 40);
}

/**
 * The booking, when `userId` is its traveller or its buddy (or `actsForPlatform`,
 * support with an admin token). Anyone else gets the SAME 404 an unknown id gets
 * (verifier F2: no 403/404 oracle). An unreadable booking is a 503. Null after
 * writing the refusal.
 */
async function requireBookingParty(
  res: Response, deps: PaymentSliceDeps, userId: string, bookingId: string, actsForPlatform = false,
): Promise<BookingForPayment | null> {
  const b = await deps.store.loadBooking(bookingId);
  if (!b.ok) { sendError(res, "degraded_unavailable", "The booking could not be read."); return null; }
  const isParty = b.value !== null && (actsForPlatform || b.value.travelerId === userId || b.value.buddyUserId === userId);
  if (!b.value || !isParty) { res.status(404).json(BOOKING_NOT_FOUND); return null; }
  return b.value;
}
const BOOKING_NOT_FOUND = Object.freeze({ error: "not_found", message: "Booking not found." });

/** The router, over injectable dependencies (tests pass an in-memory store and the fake provider). */
export function createRentABuddyPaymentsRouter(makeDeps: (sc: any) => PaymentSliceDeps = productionPaymentDeps): Router {
  const router = Router();

  const userCtx = async (req: Request, res: Response): Promise<{ userId: string; deps: PaymentSliceDeps } | null> => {
    const auth = await requireUser(req, res);
    if (!auth) return null;
    const sc = getServiceClient() ?? auth.client;
    if (!(await requireRentBuddyEnabled(sc, res))) return null;
    return { userId: auth.user.id, deps: makeDeps(sc) };
  };

  router.get("/rent-a-buddy/bookings/:bookingId/payment/quote", asyncHandler(async (req, res) => {
    const ctx = await userCtx(req, res);
    if (!ctx) return;
    const tip = intOrUndefined(req.query?.["tipMinor"]);
    if (tip === null) return sendError(res, "invalid_payload", "tipMinor must be a non-negative integer of minor units");
    if (!(await requireBookingParty(res, ctx.deps, ctx.userId, String(req.params.bookingId)))) return; // F2: a non-party gets the unknown-id 404
    send(res, await quoteBookingPayment(ctx.deps, { bookingId: String(req.params.bookingId), actorUserId: ctx.userId, tipMinor: tip }));
  }));

  router.post("/rent-a-buddy/bookings/:bookingId/payment/checkout", asyncHandler(async (req, res) => {
    const ctx = await userCtx(req, res);
    if (!ctx) return;
    const tip = intOrUndefined(req.body?.tipMinor);
    const expected = intOrUndefined(req.body?.expectedTotalMinor);
    if (tip === null || expected === null) return sendError(res, "invalid_payload", "tipMinor and expectedTotalMinor must be non-negative integers of minor units");
    // Checkout resumes an open attempt rather than creating a second, so the key's
    // job here is the contract: no money request without one.
    if ((await boundRequestKey(req, res, ctx.deps, ctx.userId, String(req.params.bookingId), "rab_checkout")) === null) return;
    send(res, await startBookingCheckout(ctx.deps, { bookingId: String(req.params.bookingId), actorUserId: ctx.userId, tipMinor: tip, expectedTotalMinor: expected }));
  }));

  router.post("/rent-a-buddy/bookings/:bookingId/payment/confirm", asyncHandler(async (req, res) => {
    const ctx = await userCtx(req, res);
    if (!ctx) return;
    const pm = req.body?.paymentMethodRef;
    const returnUrl = typeof req.body?.returnUrl === "string" && req.body.returnUrl.length > 0 ? req.body.returnUrl : null;
    if (typeof pm !== "string" || pm.length === 0 || pm.length > 255) return sendError(res, "invalid_payload", "paymentMethodRef is required");
    const requestKey = await boundRequestKey(req, res, ctx.deps, ctx.userId, String(req.params.bookingId), "rab_confirm");
    if (requestKey === null) return;
    send(res, await confirmBookingPayment(ctx.deps, { bookingId: String(req.params.bookingId), actorUserId: ctx.userId, paymentMethodRef: pm, returnUrl, requestKey }));
  }));

  router.post("/rent-a-buddy/bookings/:bookingId/payment/refund", asyncHandler(async (req, res) => {
    const ctx = await userCtx(req, res);
    if (!ctx) return;
    const trigger = req.body?.trigger;
    if (!REFUND_TRIGGERS.includes(trigger)) return sendError(res, "invalid_payload", `trigger must be one of ${REFUND_TRIGGERS.join(", ")}`);
    const amount = intOrUndefined(req.body?.amountMinor);
    if (amount === null) return sendError(res, "invalid_payload", "amountMinor must be a positive integer of minor units");
    // Admin is decided from the verified token's profile, never from the body.
    let actorIsAdmin = false;
    if (trigger === "service_unavailable" || trigger === "safety_issue_upheld" || trigger === "support_decision") {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      actorIsAdmin = true;
    }
    // A double-submitted refund is ONE refund: the provider key carries the
    // caller's request key (support's bound to the platform party).
    const requestKey = await boundRequestKey(req, res, ctx.deps, ctx.userId, String(req.params.bookingId), "rab_refund", actorIsAdmin);
    if (requestKey === null) return;
    send(res, await requestBookingRefund(ctx.deps, {
      bookingId: String(req.params.bookingId), actorUserId: ctx.userId, actorIsAdmin, trigger: trigger as RefundTrigger, amountMinor: amount, requestKey,
    }));
  }));

  router.post("/rent-a-buddy/me/payouts/onboarding", asyncHandler(async (req, res) => {
    const ctx = await userCtx(req, res);
    if (!ctx) return;
    const country = typeof req.body?.country === "string" ? req.body.country.toUpperCase() : "";
    const currency = typeof req.body?.settlementCurrency === "string" ? req.body.settlementCurrency.toUpperCase() : "";
    const base = process.env["APP_RETURN_BASE_URL"] ?? "travelbuddy://rent-a-buddy/payouts";
    send(res, await startRecipientOnboarding(ctx.deps, {
      userId: ctx.userId, country, settlementCurrency: currency, returnUrl: `${base}?onboarding=done`, refreshUrl: `${base}?onboarding=refresh`,
    }));
  }));

  router.get("/rent-a-buddy/me/payouts/account", asyncHandler(async (req, res) => {
    const ctx = await userCtx(req, res);
    if (!ctx) return;
    send(res, await refreshRecipient(ctx.deps, ctx.userId));
  }));

  router.post("/admin/rent-a-buddy/payouts/plan", asyncHandler(async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const period = typeof req.body?.period === "string" ? req.body.period : "";
    send(res, await planMonthlyPayouts(makeDeps(admin.sc), payoutPolicyFromEnv(), period));
  }));

  router.post("/admin/rent-a-buddy/payouts/execute", asyncHandler(async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const ids = Array.isArray(req.body?.payoutIds) ? req.body.payoutIds.filter((x: unknown) => typeof x === "string" && UUIDISH.test(x)) : [];
    if (ids.length === 0 || ids.length > 500) return sendError(res, "invalid_payload", "payoutIds must be 1..500 ids");
    send(res, await executePlannedPayouts(makeDeps(admin.sc), ids));
  }));

  for (const action of ["hold", "release"] as const) {
    router.post(`/admin/rent-a-buddy/payouts/:payoutId/${action}`, asyncHandler(async (req, res) => {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
      // The acting admin comes from the verified token (requireAdmin), never from the body.
      send(res, await holdOrReleasePayout(makeDeps(admin.sc), { payoutId: String(req.params.payoutId), action, reason, actorUserId: admin.userId }));
    }));
  }

  return router;
}

const router = createRentABuddyPaymentsRouter();
export default router;

// ── Webhook (RAW body; mounted in app.ts before the global JSON parser) ──────
export const paymentWebhookRawParser = express.raw({ type: () => true, limit: "512kb" });

/** Build the webhook handler over injectable dependencies. */
export function createPaymentWebhookHandler(makeDeps: (sc: any) => PaymentSliceDeps = productionPaymentDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const endpoint = req.params?.endpoint;
    if (endpoint !== "platform" && endpoint !== "connect") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : null;
    if (raw === null) {
      res.status(400).json({ error: "webhook_malformed" });
      return;
    }
    const sc = getServiceClient();
    if (!sc) {
      res.status(503).json({ error: "retry_later" });
      return;
    }
    const o = await processPaymentWebhook(makeDeps(sc), { rawBody: raw, headers: req.headers ?? {}, endpoint: endpoint as WebhookEndpoint });
    res.status(o.httpStatus).json(o.body);
  };
}

export const paymentWebhookHandler = createPaymentWebhookHandler();
