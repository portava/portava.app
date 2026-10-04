/**
 * paymentEventFold — combine provider events so that the answer does not depend
 * on the order they arrived in, or on how many times each arrived.
 *
 * `09_Payment_Architecture.md` §7: "For processor webhooks, the PSP's event id
 * is the idempotency key and the handler must be order-independent as well as
 * duplicate-safe: a `charge.captured` arriving before `charge.authorized` must
 * reconcile, not fail."
 *
 * Providers deliver at least once and in no promised order. Every
 * `PaymentWebhookEvent` therefore carries the object's FULL snapshot at the
 * moment the provider produced it. Three rules follow, and this module is them:
 *
 *   1. An event id seen before is a duplicate. It changes nothing.
 *   2. For one object, the LATEST snapshot is the state, and an older snapshot
 *      arriving later is STALE: it is recorded as seen and changes nothing.
 *   3. An event that cannot be read — no body, a body whose kind promises a
 *      snapshot it does not carry — is IGNORED with a reason. It never throws:
 *      a handler that throws on one bad delivery is a handler a provider will
 *      retry forever.
 *
 * ── WHAT "LATEST" MEANS ──────────────────────────────────────────────────────
 * `updatedAt` is the provider's time for a snapshot. It never goes backwards
 * for one object, but it REPEATS: a provider whose event clock has one-second
 * resolution (and no per-object "updated" stamp) reports the same instant for a
 * capture and the refund that followed it. So time alone cannot order two
 * snapshots, and the order between EQUAL instants is decided by what can only
 * grow, per kind of object:
 *
 *   payment intent  refunded amount, then captured amount, then state rank
 *   refund          state rank (pending before any terminal state)
 *   payout          reversed amount, then state rank
 *   dispute         state rank (open before closed)
 *   recipient       state rank
 *
 * and only then by the snapshot's canonical text, so that two different
 * snapshots can never tie. Two same-instant snapshots of one payment with 900
 * and 1 000 refunded therefore fold to 1 000 whichever arrives first — not to
 * whichever sorts first as text.
 *
 * A LATER instant always wins over an earlier one, whatever the counters say.
 * That matters because state can legitimately step back (a failed
 * authentication returns an intent to `requires_payment_method`) and a counter
 * can legitimately fall (a refund that fails after it was reported).
 *
 * `applyPaymentEvent` is commutative, associative and idempotent over events —
 * any permutation of any multiset of the same events folds to the same state.
 * `test/fakePaymentProviderWebhooks.test.ts` proves that over every
 * permutation of a real event sequence, with duplicates.
 *
 * WHAT THIS IS FOR. The webhook route (PAY-T19) persists the event id under a
 * unique index and books ledger entries; this fold is the reference for what
 * the route must compute, and the function its handler calls to decide whether
 * a delivery is new, a duplicate or stale BEFORE anything is booked. It is
 * pure: no I/O, no clock, no ledger import.
 *
 * WHAT AN ADAPTER MUST DO for rule 2 to be sound: never report an `updatedAt`
 * earlier than one it already reported for the same object; and where two
 * changes share an instant and no counter separates them (two state changes in
 * one second), re-read the object (`getPaymentIntent`, `getPayoutStatus`,
 * `validateRecipient`) and report the provider's CURRENT state.
 */

import {
  isPaymentWebhookBody,
  type DisputeSnapshot,
  type PaymentIntentSnapshot,
  type PaymentWebhookEvent,
  type PayoutSnapshot,
  type RecipientSnapshot,
  type RefundSnapshot,
} from "./PaymentProvider.js";

export interface PaymentEventState {
  readonly seenEventIds: ReadonlySet<string>;
  readonly intents: ReadonlyMap<string, PaymentIntentSnapshot>;
  readonly refunds: ReadonlyMap<string, RefundSnapshot>;
  readonly recipients: ReadonlyMap<string, RecipientSnapshot>;
  readonly payouts: ReadonlyMap<string, PayoutSnapshot>;
  readonly disputes: ReadonlyMap<string, DisputeSnapshot>;
}

/**
 *   applied    the event was new and its snapshot is now the object's state
 *   duplicate  this event id was already seen
 *   stale      the event was new, but a later snapshot of the object is already held
 *   ignored    the event changes nothing; `reason` says why
 */
export type PaymentEventOutcome = "applied" | "duplicate" | "stale" | "ignored";

/**
 *   unmodelled       a well-formed event about something this contract does not model
 *   malformed_body   the body is absent, or its kind promises a snapshot it does not carry
 *   malformed_event  the envelope itself has no event id; it cannot even be recorded as seen
 */
export type PaymentEventIgnoredReason = "unmodelled" | "malformed_body" | "malformed_event";

export interface PaymentEventApplication {
  readonly state: PaymentEventState;
  readonly outcome: PaymentEventOutcome;
  /** Set exactly when `outcome` is `ignored`. */
  readonly reason: PaymentEventIgnoredReason | null;
}

export function emptyPaymentEventState(): PaymentEventState {
  return { seenEventIds: new Set(), intents: new Map(), refunds: new Map(), recipients: new Map(), payouts: new Map(), disputes: new Map() };
}

/** Canonical text of a value: object keys sorted, so equal snapshots have equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const INTENT_RANK: Record<string, number> = {
  requires_payment_method: 0,
  requires_confirmation: 1,
  requires_action: 2,
  processing: 3,
  requires_capture: 4,
  succeeded: 5,
  canceled: 5,
};
const REFUND_RANK: Record<string, number> = { pending: 0, succeeded: 1, failed: 1, canceled: 1 };
const PAYOUT_RANK: Record<string, number> = { pending: 0, on_hold: 0, in_transit: 1, paid: 2, canceled: 2, failed: 3, returned: 3, reversed: 3 };
const DISPUTE_RANK: Record<string, number> = { needs_response: 0, under_review: 1, won: 2, lost: 2 };
const RECIPIENT_RANK: Record<string, number> = { not_started: 0, in_progress: 1, pending_verification: 2, verified: 3, restricted: 3, rejected: 4 };

/** The numbers that order two same-instant snapshots, most significant first. Each only grows over an object's life. */
type Counters<T> = (snapshot: T) => readonly number[];

const intentCounters: Counters<PaymentIntentSnapshot> = (s) => [s.amountRefundedMinor, s.amountCapturedMinor, INTENT_RANK[s.state] ?? 0];
const refundCounters: Counters<RefundSnapshot> = (s) => [REFUND_RANK[s.state] ?? 0];
const recipientCounters: Counters<RecipientSnapshot> = (s) => [RECIPIENT_RANK[s.onboarding] ?? 0];
const payoutCounters: Counters<PayoutSnapshot> = (s) => [s.amountReversedMinor, PAYOUT_RANK[s.state] ?? 0];
const disputeCounters: Counters<DisputeSnapshot> = (s) => [DISPUTE_RANK[s.state] ?? 0];

/** A positive number when `b` is strictly later than `a`: by time, then by the counters, then by canonical text. */
function compareSnapshots<T extends { updatedAt: string }>(a: T, b: T, counters: Counters<T>): number {
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  if (ta !== tb) return tb - ta;
  const ca = counters(a);
  const cb = counters(b);
  for (let i = 0; i < ca.length; i += 1) {
    const d = (cb[i] ?? 0) - (ca[i] ?? 0);
    if (d !== 0) return d;
  }
  const xa = canonicalJson(a);
  const xb = canonicalJson(b);
  return xb > xa ? 1 : xb < xa ? -1 : 0;
}

function put<T extends { updatedAt: string }>(
  map: ReadonlyMap<string, T>,
  key: string,
  incoming: T,
  counters: Counters<T>,
): { map: ReadonlyMap<string, T>; applied: boolean } {
  const held = map.get(key);
  if (held !== undefined && compareSnapshots(held, incoming, counters) <= 0) return { map, applied: false };
  const next = new Map(map);
  next.set(key, incoming);
  return { map: next, applied: true };
}

/**
 * Apply one verified event. Returns the new state, what the event turned out to
 * be and — when it was ignored — why. Never mutates `state` and never throws,
 * whatever `event` is.
 */
export function applyPaymentEvent(state: PaymentEventState, event: PaymentWebhookEvent): PaymentEventApplication {
  const id: unknown = typeof event === "object" && event !== null ? (event as { providerEventId?: unknown }).providerEventId : undefined;
  if (typeof id !== "string" || id.length === 0) return { state, outcome: "ignored", reason: "malformed_event" };
  if (state.seenEventIds.has(id)) return { state, outcome: "duplicate", reason: null };
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(id);

  const body: unknown = (event as { body?: unknown }).body;
  if (!isPaymentWebhookBody(body)) return { state: { ...state, seenEventIds }, outcome: "ignored", reason: "malformed_body" };

  const done = (next: Partial<PaymentEventState>, applied: boolean): PaymentEventApplication => ({
    state: { ...state, seenEventIds, ...next },
    outcome: applied ? "applied" : "stale",
    reason: null,
  });
  switch (body.kind) {
    case "payment_intent": {
      const r = put(state.intents, body.intent.intentRef, body.intent, intentCounters);
      return done({ intents: r.map }, r.applied);
    }
    case "refund": {
      const r = put(state.refunds, body.refund.refundRef, body.refund, refundCounters);
      return done({ refunds: r.map }, r.applied);
    }
    case "recipient": {
      const r = put(state.recipients, body.recipient.recipientRef, body.recipient, recipientCounters);
      return done({ recipients: r.map }, r.applied);
    }
    case "payout": {
      const r = put(state.payouts, body.payout.payoutRef, body.payout, payoutCounters);
      return done({ payouts: r.map }, r.applied);
    }
    case "dispute": {
      const r = put(state.disputes, body.dispute.disputeRef, body.dispute, disputeCounters);
      return done({ disputes: r.map }, r.applied);
    }
    default:
      return { state: { ...state, seenEventIds }, outcome: "ignored", reason: "unmodelled" };
  }
}

/** Fold a sequence of verified events, in whatever order and multiplicity they arrived. */
export function foldPaymentEvents(events: readonly PaymentWebhookEvent[]): PaymentEventState {
  let state = emptyPaymentEventState();
  for (const e of events) state = applyPaymentEvent(state, e).state;
  return state;
}

/** A plain, comparable rendering of a state (maps and sets in sorted order), for equality checks and logs. */
export function describePaymentEventState(state: PaymentEventState): {
  seenEventIds: string[];
  intents: PaymentIntentSnapshot[];
  refunds: RefundSnapshot[];
  recipients: RecipientSnapshot[];
  payouts: PayoutSnapshot[];
  disputes: DisputeSnapshot[];
} {
  const sorted = <T>(m: ReadonlyMap<string, T>): T[] => [...m.keys()].sort().map((k) => m.get(k) as T);
  return {
    seenEventIds: [...state.seenEventIds].sort(),
    intents: sorted(state.intents),
    refunds: sorted(state.refunds),
    recipients: sorted(state.recipients),
    payouts: sorted(state.payouts),
    disputes: sorted(state.disputes),
  };
}
