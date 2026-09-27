/**
 * PayoutProvider — the replaceable boundary between the creator ledger and
 * whatever will one day move money. Its ONLY implementation moves none.
 *
 * census-discovery DV-69 (`09` §11 "provider can be swapped later"), DV-63
 * (`08` §7 "attribution is auditable"), DV-81 ("payouts remain disabled until
 * economics are validated").
 *
 * ── THE INTERFACE IS `09` §9's, VERBATIM ────────────────────────────────────
 * "Future interface: create recipient · validate recipient · request payout ·
 * get payout status · handle webhook · reverse/hold. Do not tightly couple core
 * ledger to one provider." Six operations, one method each, and nothing about
 * any particular processor in any signature: amounts are integer minor units
 * with their currency (`09` §8), recipients are the platform's own profile ids,
 * and every answer is a tagged result a caller must branch on.
 *
 * ── NO PROVIDER IS CHOSEN HERE ──────────────────────────────────────────────
 * `NONE_PAYOUT_PROVIDER` is the only implementation. Every operation answers
 * `payouts_disabled` and does nothing else: it opens no socket, calls no
 * `fetch`, reads no credential, writes no row and returns no money. Choosing a
 * processor, and what a recipient must prove before one is created, are owner
 * decisions (census §52's questions); `resolvePayoutProvider` refuses any
 * configured name other than `none` rather than guessing at one.
 *
 * ── WHY SWAPPING IT NEEDS NO LEDGER CHANGE ───────────────────────────────────
 *   • No ledger module imports this file. `lib/creatorLedgerEntries.ts`,
 *     `lib/creatorShareCanonical.ts`, `lib/creatorLedgerStatus.ts`,
 *     `lib/creatorLedgerPlans.ts` and the three services that write and read the
 *     ledger have no reference to it (pinned by a static test).
 *   • The ledger records a provider only as `provider text DEFAULT 'none'` +
 *     `external_ref` on each entry (2901, 2921), and NOTHING derived reads
 *     either column: every fold, share and status is identical whatever they
 *     hold (pinned by a property test that rewrites them).
 *   • A settlement is unrecordable in either direction: `cash_settled_minor = 0`
 *     is CHECK-enforced on both entry ledgers and `settled_minor = 0` on
 *     attributions. A future provider that moved money would need a NEW,
 *     reviewed migration to say so — which is the point.
 */

export const NONE_PROVIDER_ID = "none" as const;

/** Every answer a provider operation can give. There is no success without a provider. */
export type PayoutProviderResult<T> =
  | { ok: true; provider: string; value: T }
  | { ok: false; provider: string; reason: "payouts_disabled" | "not_supported" | "invalid_request"; detail: string };

export interface PayoutRecipientRequest {
  /** The creator's profile id. Never a processor's account id. */
  creatorId: string;
  /** ISO 4217 settlement currency the recipient would be paid in (`09` §8). */
  settlementCurrency: string;
}

export interface PayoutRequest {
  creatorId: string;
  /** Integer minor units. */
  amountMinor: number;
  currency: string;
  /** The platform's idempotency key for this payout (`09` §10). */
  idempotencyKey: string;
}

export interface PayoutProvider {
  /** Recorded on a ledger entry's `provider` column; read by nothing derived. */
  readonly id: string;
  createRecipient(req: PayoutRecipientRequest): Promise<PayoutProviderResult<{ recipientRef: string }>>;
  validateRecipient(recipientRef: string): Promise<PayoutProviderResult<{ valid: boolean }>>;
  requestPayout(req: PayoutRequest): Promise<PayoutProviderResult<{ payoutRef: string }>>;
  getPayoutStatus(payoutRef: string): Promise<PayoutProviderResult<{ status: string }>>;
  /** `09` §10 "signed webhook verification" is the implementation's duty, before anything else. */
  handleWebhook(rawBody: string, headers: Record<string, string>): Promise<PayoutProviderResult<{ accepted: boolean }>>;
  reverseOrHold(payoutRef: string, action: "reverse" | "hold"): Promise<PayoutProviderResult<{ status: string }>>;
}

const DISABLED_DETAIL =
  "No payout provider is chosen and payouts remain disabled (09 §1 'Do later: real payouts'; DV-81). " +
  "The ledger records earnings without paying them.";

function disabled<T>(): Promise<PayoutProviderResult<T>> {
  return Promise.resolve({ ok: false, provider: NONE_PROVIDER_ID, reason: "payouts_disabled", detail: DISABLED_DETAIL });
}

/**
 * The no-money provider. Six operations, each a resolved refusal built from
 * constants — no I/O of any kind, no read of its arguments beyond their
 * existence, no state.
 */
export const NONE_PAYOUT_PROVIDER: PayoutProvider = Object.freeze({
  id: NONE_PROVIDER_ID,
  createRecipient: () => disabled<{ recipientRef: string }>(),
  validateRecipient: () => disabled<{ valid: boolean }>(),
  requestPayout: () => disabled<{ payoutRef: string }>(),
  getPayoutStatus: () => disabled<{ status: string }>(),
  handleWebhook: () => disabled<{ accepted: boolean }>(),
  reverseOrHold: () => disabled<{ status: string }>(),
});

export type ProviderResolution =
  | { ok: true; provider: PayoutProvider }
  | { ok: false; reason: "no_provider_chosen"; detail: string };

/**
 * The provider in use. `configured` is an operator setting; absent, empty or
 * `none` resolves to the no-money provider, and ANY other value is refused —
 * there is no registry to look it up in, because no provider has been chosen.
 * A future provider is added by registering it HERE; nothing in the ledger
 * changes (see the header).
 */
export function resolvePayoutProvider(configured?: string | null): ProviderResolution {
  const name = (configured ?? "").trim().toLowerCase();
  if (name === "" || name === NONE_PROVIDER_ID) return { ok: true, provider: NONE_PAYOUT_PROVIDER };
  return {
    ok: false,
    reason: "no_provider_chosen",
    detail: `payout provider ${JSON.stringify(configured)} is not registered; choosing one is an owner decision (census-discovery §52)`,
  };
}
