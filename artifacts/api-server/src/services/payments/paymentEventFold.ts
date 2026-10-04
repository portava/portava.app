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
 * moment the provider produced it, and each snapshot carries `updatedAt`, the
 * provider's clock for that object. Two rules follow, and this module is them:
 *
 *   1. An event id seen before is a duplicate. It changes nothing.
 *   2. For one object, the snapshot with the latest `updatedAt` is the state.
 *      An older snapshot arriving later is STALE: it is recorded as seen and
 *      changes nothing. Equal instants are broken by a fixed total order (state
 *      rank, then the snapshot's canonical text), so two deliveries of
 *      different events cannot disagree about which wins whichever comes first.
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
 * WHAT AN ADAPTER MUST GUARANTEE for rule 2 to be sound: `updatedAt` never goes
 * backwards for one object. Where a provider's event clock is too coarse to
 * order two changes to the same object, the adapter re-reads the object
 * (`getPaymentIntent`, `getPayoutStatus`, `validateRecipient`) and reports the
 * provider's current state instead of the event's.
 */

import type {
  DisputeSnapshot,
  PaymentIntentSnapshot,
  PaymentWebhookEvent,
  PayoutSnapshot,
  RecipientSnapshot,
  RefundSnapshot,
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
 *   ignored    the event was new and is about nothing this contract models
 */
export type PaymentEventOutcome = "applied" | "duplicate" | "stale" | "ignored";

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

/** A positive number when `b` is strictly newer than `a` under the fixed total order. */
function compareSnapshots<T extends { updatedAt: string }>(a: T, b: T, rank: (s: T) => number): number {
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  const r = rank(b) - rank(a);
  if (r !== 0) return r;
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  return cb > ca ? 1 : cb < ca ? -1 : 0;
}

function put<T extends { updatedAt: string }>(
  map: ReadonlyMap<string, T>,
  key: string,
  incoming: T,
  rank: (s: T) => number,
): { map: ReadonlyMap<string, T>; applied: boolean } {
  const held = map.get(key);
  if (held !== undefined && compareSnapshots(held, incoming, rank) <= 0) return { map, applied: false };
  const next = new Map(map);
  next.set(key, incoming);
  return { map: next, applied: true };
}

/** Apply one verified event. Returns the new state and what the event turned out to be. Never mutates `state`. */
export function applyPaymentEvent(
  state: PaymentEventState,
  event: PaymentWebhookEvent,
): { state: PaymentEventState; outcome: PaymentEventOutcome } {
  if (state.seenEventIds.has(event.providerEventId)) return { state, outcome: "duplicate" };
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(event.providerEventId);
  const body = event.body;
  switch (body.kind) {
    case "payment_intent": {
      const r = put(state.intents, body.intent.intentRef, body.intent, (s) => INTENT_RANK[s.state] ?? 0);
      return { state: { ...state, seenEventIds, intents: r.map }, outcome: r.applied ? "applied" : "stale" };
    }
    case "refund": {
      const r = put(state.refunds, body.refund.refundRef, body.refund, (s) => REFUND_RANK[s.state] ?? 0);
      return { state: { ...state, seenEventIds, refunds: r.map }, outcome: r.applied ? "applied" : "stale" };
    }
    case "recipient": {
      const r = put(state.recipients, body.recipient.recipientRef, body.recipient, (s) => RECIPIENT_RANK[s.onboarding] ?? 0);
      return { state: { ...state, seenEventIds, recipients: r.map }, outcome: r.applied ? "applied" : "stale" };
    }
    case "payout": {
      const r = put(state.payouts, body.payout.payoutRef, body.payout, (s) => PAYOUT_RANK[s.state] ?? 0);
      return { state: { ...state, seenEventIds, payouts: r.map }, outcome: r.applied ? "applied" : "stale" };
    }
    case "dispute": {
      const r = put(state.disputes, body.dispute.disputeRef, body.dispute, (s) => DISPUTE_RANK[s.state] ?? 0);
      return { state: { ...state, seenEventIds, disputes: r.map }, outcome: r.applied ? "applied" : "stale" };
    }
    default:
      return { state: { ...state, seenEventIds }, outcome: "ignored" };
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
