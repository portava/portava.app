/**
 * Payments — a party's OWN side of the payment ledger. `09` §10, PAY-073.
 *
 *   GET /payments/me/accounts   the caller's payment accounts and posted balances
 *   GET /payments/me/entries    the ledger entries naming the caller's accounts,
 *                               newest first; optional ?causeKind=&causeId=
 *                               (e.g. one booking), ?limit=, and the cursor
 *                               ?beforeOccurredAt=&beforeEntryId=
 *
 * ── WHOSE LEDGER ────────────────────────────────────────────────────────────
 * The caller's, always: the profile id is `requireUser`'s user id and no route
 * accepts one, so no request can name another party. A payer reads the entries
 * on THEIR accounts for a booking and the payee reads theirs; the other side's
 * entries are not in the response, and neither is anything that identifies the
 * other side (migration 3823, `public.payment_party_ledger`).
 *
 * ── A FAILED READ IS AN ERROR, NEVER AN EMPTY LIST ──────────────────────────
 *   flag off / absent / unreadable   feature_disabled      (not "no entries")
 *   migrations not applied           degraded_unavailable  (retryable)
 *   a malformed filter or cursor     invalid_payload
 *   any other database failure       db_error
 * `entries: []` is sent only when the database answered that there are none.
 * `hasPaymentAccount: false` says the caller has no payment party at all, which
 * is a different fact from an account with no entries.
 *
 * ── NOTHING FOR A CLIENT TO COMPUTE ─────────────────────────────────────────
 * Amounts are integer minor units as strings with their currency beside them.
 * A balance is the database's; no route returns a rate, a percentage or a set
 * of legs to add up. `livemode` is always false: this ledger records test-mode
 * money only, and the response says so rather than leave it to be assumed.
 *
 * READ-ONLY. No route here moves money, so none takes an Idempotency-Key; the
 * routes that do move money call `requireIdempotencyKey` (lib/http.ts).
 *
 * Gate: `payment_ledger_reads_enabled` (3823, seeded FALSE).
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  paymentLedgerReadsEnabled,
  readPartyLedger,
  type PartyLedger,
  type PaymentLedgerFailure,
  type ReadPartyLedgerOptions,
} from "../services/payments/PaymentLedger.js";

const router = Router();

/** Map a ledger refusal to the API's distinguishable error semantics. */
export function sendPaymentLedgerRefusal(req: any, res: any, failure: PaymentLedgerFailure): void {
  switch (failure.reason) {
    case "ledger_unavailable":
      sendError(res, "degraded_unavailable", "The payment ledger is not available on this deployment.");
      return;
    case "retryable_contention":
      sendError(res, "degraded_unavailable", "The payment ledger is busy. Please try again.");
      return;
    case "invalid_request":
      sendError(res, "invalid_payload", "The request is not a valid payment ledger query.");
      return;
    default:
      req.log?.error?.({ reason: failure.reason, detail: failure.detail }, "payment ledger read failed");
      sendError(res, "db_error", failure.detail);
  }
}

/** One query-string value, or undefined. A repeated parameter is refused, not guessed at. */
function one(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false };
  return { ok: true, value };
}

/**
 * Authenticate and check the gate — or write the refusal and return null. Every
 * route calls this FIRST, before it looks at a parameter, so an unauthenticated
 * or gated-off request learns nothing about what the route accepts.
 */
async function gate(req: any, res: any): Promise<{ sc: any; profileId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient() ?? auth.client;
  if (!(await paymentLedgerReadsEnabled(sc))) {
    sendError(res, "feature_disabled", "Payment ledger reads are not enabled.");
    return null;
  }
  return { sc, profileId: auth.user.id };
}

/** Read the caller's ledger — or write the refusal and return null. */
async function read(
  req: any,
  res: any,
  who: { sc: any; profileId: string },
  options: ReadPartyLedgerOptions,
): Promise<PartyLedger | null> {
  const r = await readPartyLedger(who.sc, who.profileId, options);
  if (!r.ok) {
    sendPaymentLedgerRefusal(req, res, r);
    return null;
  }
  return { hasParty: r.hasParty, accounts: r.accounts, entries: r.entries, nextCursor: r.nextCursor };
}

router.get("/payments/me/accounts", asyncHandler(async (req, res) => {
  const who = await gate(req, res);
  if (!who) return;
  const v = await read(req, res, who, { limit: 0 });
  if (!v) return;
  res.json({ livemode: false, hasPaymentAccount: v.hasParty, accounts: v.accounts });
}));

router.get("/payments/me/entries", asyncHandler(async (req, res) => {
  const who = await gate(req, res);
  if (!who) return;

  const causeKind = one(req.query.causeKind);
  const causeId = one(req.query.causeId);
  const limitRaw = one(req.query.limit);
  const beforeOccurredAt = one(req.query.beforeOccurredAt);
  const beforeEntryId = one(req.query.beforeEntryId);
  if (!causeKind.ok || !causeId.ok || !limitRaw.ok || !beforeOccurredAt.ok || !beforeEntryId.ok) {
    sendError(res, "invalid_payload", "Each query parameter may be given once.");
    return;
  }
  if ((causeKind.value === undefined) !== (causeId.value === undefined)) {
    sendError(res, "invalid_payload", "causeKind and causeId are given together or not at all.");
    return;
  }
  if ((beforeOccurredAt.value === undefined) !== (beforeEntryId.value === undefined)) {
    sendError(res, "invalid_payload", "beforeOccurredAt and beforeEntryId are given together or not at all.");
    return;
  }
  const options: ReadPartyLedgerOptions = {};
  if (limitRaw.value !== undefined) {
    // 1-200 here; 0 ("accounts only") is /payments/me/accounts' own call.
    if (!/^(?:[1-9][0-9]?|1[0-9]{2}|200)$/.test(limitRaw.value)) {
      sendError(res, "invalid_payload", "limit is a whole number from 1 to 200.");
      return;
    }
    options.limit = Number.parseInt(limitRaw.value, 10);
  }
  if (causeKind.value !== undefined && causeId.value !== undefined) {
    options.cause = { kind: causeKind.value, id: causeId.value };
  }
  if (beforeOccurredAt.value !== undefined && beforeEntryId.value !== undefined) {
    options.cursor = { beforeOccurredAt: beforeOccurredAt.value, beforeEntryId: beforeEntryId.value };
  }

  const v = await read(req, res, who, options);
  if (!v) return;
  res.json({
    livemode: false,
    hasPaymentAccount: v.hasParty,
    entries: v.entries,
    nextCursor: v.nextCursor,
  });
}));

export default router;
