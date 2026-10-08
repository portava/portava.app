/**
 * recipients — a buddy's account with the payment provider (Stripe Connect's
 * connected account, behind the contract), so that the buddy is the SELLER of
 * their service and a direct charge can be made on their account.
 *
 * Owner rulings (2026-10-04): "Require identity and payment-provider
 * verification before someone can offer or book the service." / "Buddy payment
 * eligibility: Allow only adults who pass identity verification, provider
 * onboarding, and safety checks, in supported markets. No payments for minors."
 *
 *   start    a buddy with a current REAL identity verification, as a verified
 *            adult, in a market the platform has enabled and the provider
 *            supports, gets a provider account and a hosted onboarding link.
 *            The provider does its own KYC there; nothing about the buddy's
 *            documents passes through Portava (codes only — RecipientSnapshot).
 *   refresh  ask the provider where onboarding stands and store it. Webhooks
 *            (`recipient` events) keep it current between refreshes.
 *
 * The recipient's country is the country the buddy is ESTABLISHED in, as they
 * state it to the provider; the provider verifies it. Market support is the
 * provider's per-country answer (`marketSupport`) behind the platform's own
 * enabled-market list (providerRegistry.enforcePaymentPolicy).
 */
import { outcome, refusal, type PaymentSliceDeps, type SliceOutcome } from "./deps.js";
import type { RecipientRecord } from "./model.js";

export interface StartOnboardingRequest {
  readonly userId: string;
  readonly country: string;
  readonly settlementCurrency: string;
  readonly returnUrl: string;
  readonly refreshUrl: string;
}

const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

export async function startRecipientOnboarding(deps: PaymentSliceDeps, req: StartOnboardingRequest): Promise<SliceOutcome> {
  if (!deps.paymentsOperational().operational) return refusal(503, "payments_unavailable", "In-app payouts are not available right now.");
  if (!COUNTRY.test(req.country) || !CURRENCY.test(req.settlementCurrency)) return refusal(400, "invalid_payload", "country (ISO 3166-1 alpha-2) and settlementCurrency (ISO 4217) are required.");

  const verified = await deps.personVerified(req.userId);
  if (verified === "unreadable") return refusal(503, "verification_unavailable", "We couldn't confirm your identity check right now. Please try again.");
  if (verified !== "verified") {
    return refusal(403, "identity_verification_required", "Verify your identity before setting up payouts. Only verified adults can receive payments.");
  }

  // The buddy's payment PARTY (3821) is created here, with their user_payable
  // account in the settlement currency; from now on they are named by it.
  const party = await deps.store.ensureUserParty(req.userId, req.settlementCurrency);
  if (!party.ok) return refusal(503, "degraded_unavailable", "Your payout account could not be set up. Please try again.");
  const partyId = party.value;
  const existing = await deps.store.getRecipient(partyId);
  if (!existing.ok) return refusal(503, "degraded_unavailable", "Your payout account could not be read. Please try again.");

  let recipientRef = existing.value?.provider === deps.provider.id ? existing.value.recipientRef : null;
  if (!recipientRef) {
    const created = await deps.provider.createRecipient({
      // The provider is given the PARTY id as its opaque reference, never the
      // profile id: an id at the provider outlives an erasure here (OD-PAY-8).
      idempotencyKey: `rab-recipient:${partyId}:${deps.provider.id}`,
      profileId: partyId,
      country: req.country,
      entityType: "individual",
      settlementCurrency: req.settlementCurrency,
      returnUrl: req.returnUrl,
      refreshUrl: req.refreshUrl,
    });
    if (created.status === "unavailable") {
      const unsupported = created.reason === "market_not_enabled" || created.reason === "unsupported_market" || created.reason === "unsupported_currency";
      return unsupported
        ? refusal(409, "market_not_supported", "In-app payouts aren't available in your country yet.", { reason: created.reason })
        : refusal(503, "payments_unavailable", "In-app payouts are not available right now.", { reason: created.reason });
    }
    if (created.status === "failed" || created.status === "declined") return refusal(422, "onboarding_refused", "The payment provider could not create your payout account.", { reason: created.reason });
    const snap = created.value;
    const rec: RecipientRecord = {
      partyId,
      provider: deps.provider.id,
      recipientRef: snap.recipientRef,
      country: snap.country,
      settlementCurrency: snap.settlementCurrency,
      onboarding: snap.onboarding,
      chargesEnabled: snap.chargesEnabled,
      payoutsEnabled: snap.payoutsEnabled,
      requirementsDue: [...snap.requirementsDue],
      providerUpdatedAt: snap.updatedAt,
    };
    const w = await deps.store.upsertRecipient(rec);
    if (!w.ok) return refusal(503, "degraded_unavailable", "Your payout account was created but could not be saved. Please try again — it will be found, not duplicated.");
    recipientRef = snap.recipientRef;
  }

  const link = await deps.provider.createRecipientOnboardingLink({
    idempotencyKey: `rab-onboarding-link:${recipientRef}:${deps.now().toISOString().slice(0, 13)}`,
    recipientRef,
    returnUrl: req.returnUrl,
    refreshUrl: req.refreshUrl,
  });
  if (link.status !== "ok") return refusal(503, "payments_unavailable", "The onboarding link could not be created. Please try again.", { reason: link.reason });
  return outcome(200, { recipientRef, onboardingUrl: link.value.url, expiresAt: link.value.expiresAt });
}

/** Ask the provider where the buddy's onboarding stands, and store it. */
export async function refreshRecipient(deps: PaymentSliceDeps, userId: string): Promise<SliceOutcome> {
  const party = await deps.store.partyForProfile(userId);
  if (!party.ok) return refusal(503, "degraded_unavailable", "Your payout account could not be read.");
  if (!party.value) return outcome(200, { status: "not_started", chargesEnabled: false, payoutsEnabled: false, requirementsDue: [] });
  const existing = await deps.store.getRecipient(party.value);
  if (!existing.ok) return refusal(503, "degraded_unavailable", "Your payout account could not be read.");
  if (!existing.value) return outcome(200, { status: "not_started", chargesEnabled: false, payoutsEnabled: false, requirementsDue: [] });
  const v = await deps.provider.validateRecipient(existing.value.recipientRef);
  if (v.status === "failed" || v.status === "unavailable") return refusal(503, "payments_unavailable", "The payment provider could not be reached.", { reason: v.reason });
  const snap = v.value;
  if (!snap) return refusal(503, "payments_unavailable", "The payment provider gave no account state.");
  const w = await deps.store.upsertRecipient({
    ...existing.value,
    country: snap.country,
    settlementCurrency: snap.settlementCurrency,
    onboarding: snap.onboarding,
    chargesEnabled: snap.chargesEnabled,
    payoutsEnabled: snap.payoutsEnabled,
    requirementsDue: [...snap.requirementsDue],
    providerUpdatedAt: snap.updatedAt,
  });
  if (!w.ok) return refusal(503, "degraded_unavailable", "Your payout account state could not be saved.");
  return outcome(200, {
    status: snap.onboarding,
    chargesEnabled: snap.chargesEnabled,
    payoutsEnabled: snap.payoutsEnabled,
    requirementsDue: snap.requirementsDue,
  });
}
