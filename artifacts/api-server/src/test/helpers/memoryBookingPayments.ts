/**
 * In-memory BookingPaymentStore and PaymentLedgerPort for the payment-slice
 * suites. Both enforce what the database and #598's ledger enforce, so a test
 * that passes here cannot rely on a laxer double:
 *
 *   store   unique idempotency key on payments, refunds and payouts (conflict),
 *           compare-and-swap payout transitions, webhook events recorded once
 *           and marked processed separately, and any operation can be made to
 *           FAIL on demand (`failNext`) to prove the callers fail closed.
 *   ledger  every posting must sum to zero in one currency and carry no zero
 *           entry; a replayed key with the SAME content replays, with
 *           DIFFERENT content conflicts; it can be made unavailable.
 */
import type {
  BookingForPayment,
  BookingPaymentRecord,
  BookingPaymentStore,
  MonthlyPayoutRecord,
  MonthlyPayoutState,
  RecipientRecord,
  RefundRecord,
  WebhookEventOutcome,
  Write,
  Read,
} from "../../services/payments/bookingPayments/model.js";
import type { LedgerPosting, LedgerPostResult, PaymentLedgerPort } from "../../services/payments/bookingPayments/ledgerPostings.js";
import { canonicalJson } from "../../services/payments/paymentEventFold.js";
import { createHash } from "node:crypto";

/** A deterministic uuid-shaped payment party id for a profile (requireIdempotencyKey checks the shape). */
export function partyIdFor(profileId: string): string {
  const h = createHash("sha256").update(`party:${profileId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const PLATFORM_PARTY_ID = partyIdFor("platform:portava");

type Op = keyof BookingPaymentStore;

export interface MemoryStore extends BookingPaymentStore {
  readonly bookings: Map<string, BookingForPayment>;
  readonly recipients: Map<string, RecipientRecord>;
  readonly payments: Map<string, BookingPaymentRecord>;
  readonly refunds: Map<string, RefundRecord>;
  readonly payouts: Map<string, MonthlyPayoutRecord>;
  readonly events: Map<string, { processed: WebhookEventOutcome | null }>;
  readonly bookingStatusWrites: Array<{ bookingId: string; status: string }>;
  /** profile id -> payment party id (3821's pseudonym); a removed identity maps to nothing. */
  readonly parties: Map<string, string>;
  /** The party a profile has (created as `party:<profile>` by ensureUserParty). */
  partyOf(profileId: string): string;
  /** Erasure as 3823 performs it: the party stays, its link to the profile goes. */
  removeIdentity(profileId: string): void;
  /** The next call of `op` answers a failure (read: ok:false; write: ok:false, conflict:false). */
  failNext(op: Op, times?: number): void;
}

export function createMemoryStore(): MemoryStore {
  const bookings = new Map<string, BookingForPayment>();
  const recipients = new Map<string, RecipientRecord>();
  const payments = new Map<string, BookingPaymentRecord>();
  const refunds = new Map<string, RefundRecord>();
  const payouts = new Map<string, MonthlyPayoutRecord>();
  const events = new Map<string, { processed: WebhookEventOutcome | null }>();
  const bookingStatusWrites: Array<{ bookingId: string; status: string }> = [];
  const parties = new Map<string, string>();
  const failing = new Map<Op, number>();
  const fails = (op: Op): boolean => {
    const n = failing.get(op) ?? 0;
    if (n <= 0) return false;
    failing.set(op, n - 1);
    return true;
  };
  const r = <T>(op: Op, v: () => T): Promise<Read<T>> => Promise.resolve(fails(op) ? { ok: false, detail: `${op} failed (injected)` } : { ok: true, value: v() });
  const w = (op: Op, f: () => Write): Promise<Write> => Promise.resolve(fails(op) ? { ok: false, conflict: false, detail: `${op} failed (injected)` } : f());
  const ok: Write = { ok: true };
  const clone = <T>(v: T): T => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

  const store: MemoryStore = {
    bookings, recipients, payments, refunds, payouts, events, bookingStatusWrites, parties,
    failNext(op, times = 1) { failing.set(op, times); },
    partyOf: (profileId) => partyIdFor(profileId),
    removeIdentity(profileId) { parties.delete(profileId); },

    partyForProfile: (profileId) => r("partyForProfile", () => parties.get(profileId) ?? null),
    profileForParty: (partyId) => r("profileForParty", () => [...parties.entries()].find(([, p]) => p === partyId)?.[0] ?? null),
    ensureUserParty: (profileId) => r("ensureUserParty", () => {
      const p = parties.get(profileId) ?? partyIdFor(profileId);
      parties.set(profileId, p);
      return p;
    }),

    loadBooking: (id) => r("loadBooking", () => clone(bookings.get(id) ?? null)),
    setBookingPaymentStatus: (id, status) => w("setBookingPaymentStatus", () => {
      const b = bookings.get(id);
      if (!b) return { ok: false, conflict: false, detail: "no booking" };
      bookings.set(id, { ...b, paymentStatus: status });
      bookingStatusWrites.push({ bookingId: id, status });
      return ok;
    }),

    ensurePlatformParty: () => r("ensurePlatformParty", () => PLATFORM_PARTY_ID),
    getRecipient: (partyId) => r("getRecipient", () => clone(recipients.get(partyId) ?? null)),
    findRecipientByRef: (provider, ref) => r("findRecipientByRef", () => clone([...recipients.values()].find((x) => x.provider === provider && x.recipientRef === ref) ?? null)),
    upsertRecipient: (rec) => w("upsertRecipient", () => { recipients.set(rec.partyId, clone(rec)); return ok; }),

    listPaymentsForBooking: (id) => r("listPaymentsForBooking", () => clone([...payments.values()].filter((p) => p.bookingId === id).sort((a, b) => a.attemptNo - b.attemptNo))),
    findPaymentByIntent: (provider, ref) => r("findPaymentByIntent", () => clone([...payments.values()].find((p) => p.provider === provider && p.intentRef === ref) ?? null)),
    insertPayment: (rec) => w("insertPayment", () => {
      if ([...payments.values()].some((p) => p.idempotencyKey === rec.idempotencyKey)) return { ok: false, conflict: true, detail: "duplicate idempotency key" };
      payments.set(rec.id, clone(rec));
      return ok;
    }),
    updatePayment: (id, patch) => w("updatePayment", () => {
      const p = payments.get(id);
      if (!p) return { ok: false, conflict: false, detail: "no payment" };
      payments.set(id, { ...p, ...clone(patch) });
      return ok;
    }),
    listUnpaidSucceededPayments: (partyId) => r("listUnpaidSucceededPayments", () =>
      clone([...payments.values()].filter((p) => p.payoutId === null && (partyId === null || p.recipientPartyId === partyId) && (p.state === "succeeded" || p.state === "partially_refunded" || p.state === "disputed")))),

    insertRefund: (rec) => w("insertRefund", () => {
      if ([...refunds.values()].some((x) => x.idempotencyKey === rec.idempotencyKey)) return { ok: false, conflict: true, detail: "duplicate idempotency key" };
      refunds.set(rec.id, clone(rec));
      return ok;
    }),
    findRefundByRef: (provider, ref) => r("findRefundByRef", () => clone([...refunds.values()].find((x) => x.provider === provider && x.refundRef === ref) ?? null)),
    updateRefund: (id, patch) => w("updateRefund", () => {
      const x = refunds.get(id);
      if (!x) return { ok: false, conflict: false, detail: "no refund" };
      refunds.set(id, { ...x, ...clone(patch) });
      return ok;
    }),
    listRefundsForPayment: (id) => r("listRefundsForPayment", () => clone([...refunds.values()].filter((x) => x.bookingPaymentId === id))),

    insertPayout: (rec) => w("insertPayout", () => {
      if ([...payouts.values()].some((x) => x.idempotencyKey === rec.idempotencyKey)) return { ok: false, conflict: true, detail: "duplicate idempotency key" };
      payouts.set(rec.id, clone(rec));
      return ok;
    }),
    getPayout: (id) => r("getPayout", () => clone(payouts.get(id) ?? null)),
    findPayoutByRef: (_provider, ref) => r("findPayoutByRef", () => clone([...payouts.values()].find((x) => x.payoutRef === ref) ?? null)),
    findPayoutByKey: (key) => r("findPayoutByKey", () => clone([...payouts.values()].find((x) => x.idempotencyKey === key) ?? null)),
    transitionPayout: (id, from: readonly MonthlyPayoutState[], patch) => w("transitionPayout", () => {
      const x = payouts.get(id);
      if (!x) return { ok: false, conflict: false, detail: "no payout" };
      if (!from.includes(x.state)) return { ok: false, conflict: true, detail: `state is ${x.state}` };
      payouts.set(id, { ...x, ...clone(patch) });
      return ok;
    }),

    recordWebhookEvent: (provider, id) => r("recordWebhookEvent", () => {
      const k = `${provider}:${id}`;
      const e = events.get(k);
      if (!e) events.set(k, { processed: null });
      return { alreadyProcessed: e?.processed != null };
    }),
    markWebhookEventProcessed: (provider, id, outcome) => w("markWebhookEventProcessed", () => {
      events.set(`${provider}:${id}`, { processed: outcome });
      return ok;
    }),
  };
  return store;
}

export interface MemoryLedger extends PaymentLedgerPort {
  readonly postings: Map<string, LedgerPosting>;
  /** How many post() calls replayed an existing key with identical content. */
  readonly replays: () => number;
  setAvailable(available: boolean): void;
  /** Σ entries per (account, party, currency). Processor and platform accounts have party null. */
  balance(account: string, partyId: string | null, currency: string): number;
}

export function createMemoryLedger(): MemoryLedger {
  const postings = new Map<string, LedgerPosting>();
  let available = true;
  let replays = 0;
  return {
    postings,
    replays: () => replays,
    setAvailable(a) { available = a; },
    balance(account, party, currency) {
      let n = 0;
      for (const p of postings.values()) {
        if (p.currency !== currency) continue;
        for (const e of p.entries) if (e.account === account && e.partyId === party) n += e.amountMinor;
      }
      return n;
    },
    async post(p): Promise<LedgerPostResult> {
      if (!available) return { ok: false, reason: "ledger_unavailable", detail: "ledger off (test)" };
      if (p.entries.length < 2 || p.entries.some((e) => e.amountMinor === 0 || !Number.isSafeInteger(e.amountMinor))) return { ok: false, reason: "rejected", detail: "a posting needs ≥2 non-zero integer entries" };
      if (p.entries.reduce((n, e) => n + e.amountMinor, 0) !== 0) return { ok: false, reason: "unbalanced", detail: "entries do not sum to zero" };
      const held = postings.get(p.key);
      if (held) {
        if (canonicalJson(held.entries) === canonicalJson(p.entries) && held.currency === p.currency) { replays += 1; return { ok: true, replayed: true }; }
        return { ok: false, reason: "idempotency_conflict", detail: "same key, different content" };
      }
      postings.set(p.key, JSON.parse(JSON.stringify(p)));
      return { ok: true, replayed: false };
    },
  };
}
