/**
 * The records and ports of the Rent-a-Buddy payment slice.
 *
 * Two ports, so the orchestration in this directory is the same code whether it
 * runs against the database or against a test double:
 *
 *   BookingPaymentStore  the payment, refund, recipient, payout and webhook-event
 *                        records (migration 3931) plus the booking reads and the
 *                        one booking write this slice makes (`payment_status`).
 *                        Production: supabaseBookingPaymentStore.ts.
 *   PaymentLedgerPort    the double-entry postings (ledgerPostings.ts). The
 *                        ledger that can record SETTLED money is PR #598
 *                        (payment_post_transaction, 3821–3823), which is not on
 *                        main. Until it is, the production binding answers
 *                        `ledger_unavailable`, and every step that must book
 *                        money refuses rather than proceeding unbooked
 *                        (`09` §2: the ledger is the source of truth).
 *
 * Every read answers `{ ok: false }` on failure — never an empty result — and
 * every write says whether it happened.
 */
import type {
  AmountComponents,
  ChargeModel,
  DisputeSnapshot,
  Money,
  PaymentIntentSnapshot,
  PaymentIntentState,
  PayoutSnapshot,
  PayoutState,
  PlatformFee,
  RecipientOnboardingState,
  RefundReason,
  RefundSnapshot,
  RefundState,
} from "../PaymentProvider.js";

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };
export type Write = { readonly ok: true } | { readonly ok: false; readonly conflict: boolean; readonly detail: string };

export const readOk = <T>(value: T): Read<T> => ({ ok: true, value });
export const readFail = <T>(detail: string): Read<T> => ({ ok: false, detail });
export const writeOk: Write = Object.freeze({ ok: true }) as Write;
export const writeFail = (detail: string, conflict = false): Write => ({ ok: false, conflict, detail });

/** Booking statuses from which a traveller may pay: the buddy accepted and the service has not begun. */
export const PAYABLE_BOOKING_STATUSES: readonly string[] = ["confirmed", "scheduled"];

/** What this slice reads about a booking. */
export interface BookingForPayment {
  readonly bookingId: string;
  readonly status: string;
  /** rent_buddy_bookings.payment_status (rent_buddy_payment_status enum). */
  readonly paymentStatus: string;
  readonly travelerId: string;
  readonly buddyProfileId: string;
  readonly buddyUserId: string | null;
  /** The service country snapshotted on the booking (2212). */
  readonly serviceCountry: string | null;
  /** PRE-TAX service price in minor units (total_usd, which includes add-ons). Null when unreadable as money. */
  readonly serviceMinor: number | null;
  /** The currency the price is stated in. The schema stores USD only (`total_usd`). */
  readonly currency: string;
  /** booking_date + start_time as an ISO instant, UTC; null when the start time is unknown. */
  readonly startsAt: string | null;
  /** How `startsAt` was derived: in the booking city's zone, or the earliest-possible instant (no zone known). */
  readonly startBasis: "city_timezone" | "earliest_possible" | null;
  readonly completedAt: string | null;
  readonly disputeWindowExpiresAt: string | null;
  readonly isTestBooking: boolean; /** rent_buddy_bookings.payment_mode. Only 'full_in_app' is charged in the app (checkout.ts, foot). */ readonly paymentMode: string;
}

/**
 * The buddy's account with the payment provider. Codes only — never a document
 * or a number. Keyed by the buddy's PAYMENT PARTY (3821), not their profile:
 * the party's `profile_id` is the one identity link, and erasure removes it
 * there (OD-PAY-8) without touching this row.
 */
export interface RecipientRecord {
  readonly partyId: string;
  readonly provider: string;
  readonly recipientRef: string;
  readonly country: string;
  readonly settlementCurrency: string;
  readonly onboarding: RecipientOnboardingState;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly requirementsDue: readonly string[];
  readonly providerUpdatedAt: string | null;
}

/**
 * The slice's own lifecycle for one payment attempt. The provider's intent
 * state is kept beside it (`intentState`), and this one is what the booking and
 * the payout planner read.
 *
 *   creating          the row exists, the provider has not answered yet (a crash
 *                     here is recovered by re-sending the same idempotency key)
 *   awaiting_payment  the intent exists; the payer has to confirm/authenticate
 *   processing        the payer confirmed; the provider has not settled it
 *   succeeded         captured (the intent is `succeeded`)
 *   failed            creation or the payment failed; a new attempt may be made
 *   canceled          the intent was canceled before capture
 *   refunded          everything captured has been refunded
 *   partially_refunded
 *   disputed          a dispute is open
 *   reversed          a dispute was LOST: the money went back by chargeback
 */
export type BookingPaymentState =
  | "creating"
  | "awaiting_payment"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "partially_refunded"
  | "disputed"
  | "reversed";

export const BOOKING_PAYMENT_STATES: readonly BookingPaymentState[] = [
  "creating", "awaiting_payment", "processing", "succeeded", "failed", "canceled",
  "refunded", "partially_refunded", "disputed", "reversed",
];

/** States in which another attempt for the same booking may be started. */
export const RETRYABLE_PAYMENT_STATES: readonly BookingPaymentState[] = ["failed", "canceled"];

export interface BookingPaymentRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly attemptNo: number;
  readonly provider: string;
  readonly idempotencyKey: string;
  readonly intentRef: string | null;
  readonly recipientRef: string;
  /** The buddy's payment party (3821). Never a profile id. */
  readonly recipientPartyId: string;
  readonly chargeModel: ChargeModel;
  readonly state: BookingPaymentState;
  readonly intentState: PaymentIntentState | null;
  /** The ORIGINAL amount and currency charged. Never rewritten by a conversion. */
  readonly amount: Money;
  readonly components: AmountComponents;
  readonly platformFee: PlatformFee;
  readonly commissionBps: number;
  readonly commissionRuleVersion: string;
  readonly taxProvider: string;
  readonly taxCalculationRefs: readonly string[];
  readonly buyerMarket: string;
  readonly sellerMarket: string;
  readonly amountCapturedMinor: number;
  readonly amountRefundedMinor: number;
  readonly platformFeeCollectedMinor: number;
  readonly platformFeeRefundedMinor: number;
  /** Settlement and conversion details exactly as the provider reported them (`09` §8). */
  readonly settlement: PaymentIntentSnapshot["settlement"];
  /** The last applied provider snapshot, for stale/duplicate decisions. */
  readonly lastSnapshot: PaymentIntentSnapshot | null;
  readonly failureReason: string | null;
  /**
   * The provider still holds an OPEN intent for this ended attempt (a declined
   * confirmation leaves the intent awaiting another method). Set until a
   * cancellation through the contract succeeds; retried on the next checkout.
   */
  readonly providerCancelOwed: boolean;
  /** Included in a payout (rent_buddy_monthly_payouts.id) once paid out. */
  readonly payoutId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a payment compare-and-set compares (F1). */
export type PaymentCasKey = Pick<BookingPaymentRecord, "updatedAt" | "state" | "intentState" | "amountCapturedMinor" | "amountRefundedMinor">;

export interface RefundRecord {
  readonly id: string;
  readonly bookingPaymentId: string;
  readonly provider: string;
  readonly idempotencyKey: string;
  readonly refundRef: string | null;
  readonly state: RefundState | "requested" | "refused";
  readonly reason: RefundReason;
  /** Null for a full refund until the provider reports the amount. */
  readonly amountMinor: number | null;
  readonly currency: string;
  readonly refundPlatformFee: boolean;
  /** Who asked, by role. The traveller's or buddy's payment party when one of them asked; null for support. */
  readonly requestedByRole: "traveler" | "buddy" | "admin";
  readonly requestedByPartyId: string | null;
  readonly lastSnapshot: RefundSnapshot | null;
  readonly createdAt: string;
}

export type MonthlyPayoutState =
  | "planned"
  | "held"
  | "requested"
  | "pending"
  | "in_transit"
  | "paid"
  | "failed"
  | "returned"
  | "canceled"
  | "carried_forward";

export interface MonthlyPayoutRecord {
  readonly id: string;
  /** The buddy's payment party (3821). Never a profile id. */
  readonly recipientPartyId: string;
  /** The provider the payout is requested from (the processor_clearing owner in the ledger). */
  readonly provider: string;
  /** YYYY-MM, the month whose finalised earnings this pays. */
  readonly period: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly state: MonthlyPayoutState;
  readonly idempotencyKey: string;
  readonly payoutRef: string | null;
  readonly recipientRef: string;
  readonly bookingPaymentIds: readonly string[];
  readonly holdReason: string | null;
  /**
   * The admin who held / released it, and when: written in the SAME UPDATE as
   * the state change (one statement, so one transaction). A staff member's
   * profile id, deliberately: accountability for a money action has to name the
   * person who took it, and an admin is not a payment party.
   */
  readonly heldBy: string | null;
  readonly heldAt: string | null;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
  readonly carryReason: string | null;
  readonly failureCode: string | null;
  readonly lastSnapshot: PayoutSnapshot | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WebhookEventOutcome = "applied" | "duplicate" | "stale" | "ignored";

export interface WebhookEventReceipt {
  /** True when this event id was already PROCESSED (not merely received). */
  readonly alreadyProcessed: boolean;
}

export interface BookingPaymentStore {
  loadBooking(bookingId: string): Promise<Read<BookingForPayment | null>>;
  /** The only booking write this slice makes: the `payment_status` projection. */
  setBookingPaymentStatus(bookingId: string, status: "pending" | "captured" | "partial" | "refunded" | "failed"): Promise<Write>;

  /** The payment party of a profile, or null when it has none yet. Never creates one. */
  partyForProfile(profileId: string): Promise<Read<string | null>>;
  /** The profile behind a party, or null once the identity was removed (erasure). */
  profileForParty(partyId: string): Promise<Read<string | null>>;
  /** The party of a profile, created with its `user_payable` account in `currency` if absent (3821 payment_account_ensure). */
  ensureUserParty(profileId: string, currency: string, accountType?: "user_payable" | "user_receivable"): Promise<Read<string>>;
  /** The PLATFORM's party (label `portava`), with its refund-liability account in `currency`: who support acts for. */
  ensurePlatformParty(currency: string): Promise<Read<string>>;
  getRecipient(partyId: string): Promise<Read<RecipientRecord | null>>;
  findRecipientByRef(provider: string, recipientRef: string): Promise<Read<RecipientRecord | null>>;
  upsertRecipient(rec: RecipientRecord): Promise<Write>;

  listPaymentsForBooking(bookingId: string): Promise<Read<readonly BookingPaymentRecord[]>>;
  findPaymentByIntent(provider: string, intentRef: string): Promise<Read<BookingPaymentRecord | null>>;
  /** Insert; `conflict: true` when the idempotency key already exists. */
  insertPayment(rec: BookingPaymentRecord): Promise<Write>;
  updatePayment(id: string, patch: Partial<BookingPaymentRecord>): Promise<Write>;
  /**
   * Compare-and-set (verifier F1): updates only while the row still holds `held`'s
   * updated_at, state, intent state and money counters. `conflict: true` when another
   * write landed first, so a stale delivery can never overwrite a newer one.
   */
  updatePaymentIfUnchanged(id: string, held: PaymentCasKey, patch: Partial<BookingPaymentRecord>): Promise<Write>;
  /** Payments whose money is on the recipient's provider balance and not yet in a payout. */
  listUnpaidSucceededPayments(recipientPartyId: string | null): Promise<Read<readonly BookingPaymentRecord[]>>;

  insertRefund(rec: RefundRecord): Promise<Write>;
  findRefundByRef(provider: string, refundRef: string): Promise<Read<RefundRecord | null>>;
  updateRefund(id: string, patch: Partial<RefundRecord>): Promise<Write>;
  listRefundsForPayment(bookingPaymentId: string): Promise<Read<readonly RefundRecord[]>>;

  insertPayout(rec: MonthlyPayoutRecord): Promise<Write>;
  getPayout(id: string): Promise<Read<MonthlyPayoutRecord | null>>;
  findPayoutByRef(provider: string, payoutRef: string): Promise<Read<MonthlyPayoutRecord | null>>;
  findPayoutByKey(idempotencyKey: string): Promise<Read<MonthlyPayoutRecord | null>>;
  /** Compare-and-swap: updates only when the current state is one of `from`. `conflict: true` when it was not. */
  transitionPayout(id: string, from: readonly MonthlyPayoutState[], patch: Partial<MonthlyPayoutRecord>): Promise<Write>;

  /** Record that an event arrived. Idempotent per (provider, eventId). */
  recordWebhookEvent(provider: string, eventId: string, meta: { endpoint: string; type: string; occurredAt: string }): Promise<Read<WebhookEventReceipt>>;
  /** Mark it processed LAST, so a crash before this point is retried by the provider. */
  markWebhookEventProcessed(provider: string, eventId: string, outcome: WebhookEventOutcome): Promise<Write>;
}

/** A dispute's lifecycle is recorded through the payment it is about; see webhookProcessor. */
export type DisputeRecordView = Pick<DisputeSnapshot, "disputeRef" | "state" | "amount" | "reasonCode">;

export type PayoutStateFromProvider = PayoutState;
