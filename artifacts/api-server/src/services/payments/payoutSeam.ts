/**
 * payoutSeam — the older `PayoutProvider` seam, placed BEHIND the PaymentProvider
 * contract.
 *
 * `services/creators/PayoutProvider.ts` is `09` §9's six-operation payout
 * interface. It predates the charge-side contract, imports nothing, and its
 * `resolvePayoutProvider` refuses every name but `none`. All of that is pinned
 * by `test/creatorPayoutProviderBoundary.test.ts` (PV1–PV3) and none of it is
 * changed: THAT FILE IS NOT EDITED.
 *
 * What changes is where a payout provider comes from once a payment provider
 * exists. There is one provider seam, not two: a `PayoutProvider` is now a VIEW
 * of the configured `PaymentProvider`, produced here.
 *
 *   payment provider `none`  -> the existing `NONE_PAYOUT_PROVIDER` object
 *                               itself, so every existing answer
 *                               (`payouts_disabled`, no I/O) is byte-identical
 *   any resolved provider    -> `payoutProviderBehind(provider, context)`,
 *                               which forwards each of the six operations to
 *                               the contract and translates the answer
 *   an unresolvable provider -> `no_provider_chosen`, as before
 *
 * ── EXISTING CALLERS OF THE OLD SEAM (2026-10-04, origin/main f71cfb85f) ─────
 * There is no production caller. The whole reference set is:
 *   • src/test/creatorPayoutProviderBoundary.test.ts — `NONE_PAYOUT_PROVIDER`,
 *     `NONE_PROVIDER_ID`, `resolvePayoutProvider` (PV1, PV2) and the import pin
 *     on the module (PV3)
 *   • src/test/db/creatorLedgerErasurePolicy.db.test.ts —
 *     `resolvePayoutProvider(process.env.CREATOR_PAYOUT_PROVIDER)` resolves
 *     `none`, and `resolvePayoutProvider("stripe")` is refused
 *   • src/scripts/checkCensusFreshness.ts and CENSUS_STALENESS_ACKNOWLEDGED.json
 *     name the file as counted census evidence (DV-69), which is one more reason
 *     it is left byte-for-byte alone.
 * Both tests keep passing unmodified; `resolvePayoutProvider` still refuses
 * `stripe`, `fake` and every other name.
 *
 * ── WHY A CONTEXT IS NEEDED ──────────────────────────────────────────────────
 * The old requests name a creator by PROFILE id ("never a processor's account
 * id") and a payout by a bare reference. The contract needs the recipient's
 * provider account, their country and where onboarding returns to, and it
 * addresses a payout by kind and recipient. `PayoutSeamContext` is the lookup
 * the caller supplies; this module holds no table and reads no database.
 *
 * ── THE TRANSLATION IS LOSSY, ON PURPOSE AND IN ONE DIRECTION ────────────────
 * The old result has three refusal reasons; the contract has dozens. The
 * mapping keeps the original `status:reason` in `detail`. New code should hold
 * a `PaymentProvider` and read the tagged result directly; this view exists so
 * that code written against the old interface gets a working provider without
 * a second registry.
 */

import {
  resolvePayoutProvider,
  type PayoutProvider,
  type PayoutProviderResult,
  type PayoutRecipientRequest,
  type PayoutRequest,
  type ProviderResolution,
} from "../creators/PayoutProvider.js";
import type { PaymentProvider, PaymentResult, PayoutHandle, PayoutKind, RecipientEntityType } from "./PaymentProvider.js";
import { resolvePaymentProvider, type PaymentProviderAdapterRegistration } from "./providerRegistry.js";

export interface PayoutSeamContext {
  /** Which movement an old-interface "payout" is: platform funds to the recipient's balance, or that balance to their bank. */
  readonly payoutKind: PayoutKind;
  /** The creator's provider account, or null when they have none. */
  recipientRefFor(creatorId: string): Promise<string | null>;
  /** What creating a recipient needs that the old request does not carry; null when unknown. */
  recipientDetailsFor(creatorId: string): Promise<{
    country: string;
    entityType: RecipientEntityType;
    returnUrl: string;
    refreshUrl: string;
  } | null>;
  /** How to address a payout the old interface names by reference alone; null when unknown. */
  payoutHandleFor(payoutRef: string): Promise<PayoutHandle | null>;
}

type Refusal = Extract<PayoutProviderResult<never>, { ok: false }>;

const NOT_SUPPORTED_REASONS: ReadonlySet<string> = new Set([
  "unsupported_market",
  "unsupported_currency",
  "charge_model_not_supported",
  "capability_not_supported",
]);

/** A non-ok contract answer, as the old seam's three-reason refusal. */
export function toPayoutRefusal(result: Exclude<PaymentResult<unknown>, { status: "ok" }>): Refusal {
  const detail = `${result.status}:${result.reason} — ${result.detail}`;
  if (result.status === "failed") return { ok: false, provider: result.provider, reason: "invalid_request", detail };
  if (result.status === "unavailable" && !NOT_SUPPORTED_REASONS.has(result.reason)) {
    return { ok: false, provider: result.provider, reason: "payouts_disabled", detail };
  }
  return { ok: false, provider: result.provider, reason: "not_supported", detail };
}

function invalid(provider: string, detail: string): Refusal {
  return { ok: false, provider, reason: "invalid_request", detail };
}

/** The six `09` §9 operations, each forwarded to the PaymentProvider contract. */
export function payoutProviderBehind(provider: PaymentProvider, context: PayoutSeamContext): PayoutProvider {
  return Object.freeze({
    id: provider.id,

    async createRecipient(req: PayoutRecipientRequest): Promise<PayoutProviderResult<{ recipientRef: string }>> {
      const details = await context.recipientDetailsFor(req.creatorId);
      if (!details) return invalid(provider.id, "the recipient's country and onboarding return address are not known");
      const r = await provider.createRecipient({
        idempotencyKey: `recipient:${req.creatorId}`,
        profileId: req.creatorId,
        country: details.country,
        entityType: details.entityType,
        settlementCurrency: req.settlementCurrency,
        returnUrl: details.returnUrl,
        refreshUrl: details.refreshUrl,
      });
      // The account exists in both cases; onboarding is the recipient's to finish.
      if (r.status === "ok" || r.status === "requires_action") return { ok: true, provider: provider.id, value: { recipientRef: r.value.recipientRef } };
      return toPayoutRefusal(r);
    },

    async validateRecipient(recipientRef: string): Promise<PayoutProviderResult<{ valid: boolean }>> {
      const r = await provider.validateRecipient(recipientRef);
      if (r.status === "ok") return { ok: true, provider: provider.id, value: { valid: true } };
      if (r.status === "requires_action" || r.status === "declined") return { ok: true, provider: provider.id, value: { valid: false } };
      return toPayoutRefusal(r);
    },

    async requestPayout(req: PayoutRequest): Promise<PayoutProviderResult<{ payoutRef: string }>> {
      const recipientRef = await context.recipientRefFor(req.creatorId);
      if (!recipientRef) return invalid(provider.id, "the creator has no recipient account with the provider");
      const r = await provider.requestPayout({
        idempotencyKey: req.idempotencyKey,
        kind: context.payoutKind,
        recipientRef,
        amount: { amountMinor: req.amountMinor, currency: req.currency },
        reference: { kind: "creator_payout", id: req.idempotencyKey },
      });
      if (r.status === "ok") return { ok: true, provider: provider.id, value: { payoutRef: r.value.payoutRef } };
      return toPayoutRefusal(r);
    },

    async getPayoutStatus(payoutRef: string): Promise<PayoutProviderResult<{ status: string }>> {
      const handle = await context.payoutHandleFor(payoutRef);
      if (!handle) return invalid(provider.id, "no such payout is known to the platform");
      const r = await provider.getPayoutStatus(handle);
      if (r.status === "ok") return { ok: true, provider: provider.id, value: { status: r.value.state } };
      return toPayoutRefusal(r);
    },

    async handleWebhook(rawBody: string, headers: Record<string, string>): Promise<PayoutProviderResult<{ accepted: boolean }>> {
      const r = await provider.verifyAndParseWebhook({ rawBody, headers });
      if (r.status === "ok") return { ok: true, provider: provider.id, value: { accepted: true } };
      return toPayoutRefusal(r);
    },

    async reverseOrHold(payoutRef: string, action: "reverse" | "hold"): Promise<PayoutProviderResult<{ status: string }>> {
      const handle = await context.payoutHandleFor(payoutRef);
      if (!handle) return invalid(provider.id, "no such payout is known to the platform");
      const r = await provider.reverseOrHoldPayout({ idempotencyKey: `${action}:${payoutRef}`, payout: handle, action });
      if (r.status === "ok") return { ok: true, provider: provider.id, value: { status: r.value.state } };
      return toPayoutRefusal(r);
    },
  });
}

/**
 * The payout provider for the configured PAYMENT provider.
 *
 * With `PAYMENT_PROVIDER` unset or `none` this returns exactly what
 * `resolvePayoutProvider("none")` returns — the same frozen object the old seam
 * has always returned.
 */
export function resolvePayoutProviderBehindPayments(
  env: NodeJS.ProcessEnv = process.env,
  context: PayoutSeamContext | null = null,
  adapters?: readonly PaymentProviderAdapterRegistration[],
): ProviderResolution {
  const resolved = resolvePaymentProvider(env, adapters);
  if (resolved.ok && resolved.kind === "none") return resolvePayoutProvider("none");
  if (!resolved.ok) {
    return { ok: false, reason: "no_provider_chosen", detail: `payment provider ${JSON.stringify(resolved.name)} cannot be used: ${resolved.reason} — ${resolved.detail}` };
  }
  if (!context) {
    return { ok: false, reason: "no_provider_chosen", detail: "a payout through a real provider needs a PayoutSeamContext to find the recipient's account" };
  }
  return { ok: true, provider: payoutProviderBehind(resolved.provider, context) };
}
