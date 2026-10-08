/**
 * ledgerAdapter — the slice's postings (ledgerPostings.ts) onto PR #598's
 * double-entry ledger, `payment_post_transaction` (3822), through its one API
 * door, services/payments/PaymentLedger.ts. This replaces LEDGER_NOT_AVAILABLE
 * as the production binding.
 *
 * ── HOW A PLANNED POSTING BECOMES A 3822 TRANSACTION ────────────────────────
 *   sign        the planner writes + debit / − credit; 3822 writes a CREDIT as
 *               positive. Every amount is negated here, nowhere else.
 *   accounts    by 3821's owner rule (pa_account_type_owner_kind):
 *                 user_payable        the buddy's PARTY (entry.partyId). Looked
 *                                     up by party; created through
 *                                     payment_account_ensure only while the
 *                                     party still leads to a profile.
 *                 processor_clearing  the PROCESSOR party labelled by the provider
 *                 platform_revenue,   the PLATFORM party `portava`
 *                 tax_withheld
 *   original    3822 ties a transaction's credits to `original_amount_minor`
 *               (PL007), so it is the sum of the credit entries; booked in the
 *               charge's own currency, so no conversion is stated (none is
 *               invented — `09` §8).
 *   kind        capture / refund / fee / chargeback / payout (a returned payout
 *               is a `payout` transaction with the legs reversed — not a 3822
 *               `reversal`, which must negate one transaction exactly).
 *   attribution cause `booking` + the booking id, subject `booking` + the booking
 *               id; a monthly payout covers many bookings, so it is cause
 *               `adjustment` `rab_payout:<id>`, subject `experience`
 *               `rent_a_buddy` — 3823's vocabulary has no "payout run" subject,
 *               stated rather than hidden. The beneficiary is the account the
 *               transaction credits most (3822: "the account credited").
 *   scope / key `rab_payments` + the planner's key: derived from the EVENT
 *               (cumulative provider counters), never the attempt, and naming a
 *               payment / payout row — never a person (3821 ptx_admit refuses a
 *               profile id in any text column).
 *   externalRef the provider's object id when it has 3821's `<prefix>_<token>`
 *               shape; otherwise omitted rather than mangled.
 *
 * Every refusal keeps 3822's name. `ledger_unavailable` (the functions are not
 * applied here) stays `ledger_unavailable`, so the webhook answers 503 and the
 * provider retries — this tree still never acknowledges money it did not book.
 */
import {
  ensurePaymentAccount,
  postPaymentTransaction,
  type PaymentAccountOwner,
  type PaymentAccountType,
  type PaymentEntryReason,
  type PaymentTransactionKind,
} from "../PaymentLedger.js";
import type { LedgerEntry, LedgerPostResult, LedgerPosting, PaymentLedgerPort } from "./ledgerPostings.js";

export const PLATFORM_PARTY_LABEL = "portava";
export const LEDGER_SCOPE = "rab_payments";
export const ATTRIBUTION_VERSION = "rab-payments/2026-10-05/v1";

const EXTERNAL_REF = /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{4,200}$/;

const KIND: Record<LedgerPosting["kind"], PaymentTransactionKind> = {
  capture: "capture",
  refund: "refund",
  fee: "fee",
  chargeback: "chargeback",
  payout: "payout",
  payout_return: "payout",
};

/** The slice's reasons in 3821's entry-reason vocabulary. */
const REASON: Record<LedgerEntry["reason"], PaymentEntryReason> = {
  principal: "principal",
  tip: "tip",
  platform_fee: "platform_fee",
  processor_fee: "processor_fee",
  tax: "tax",
  refund: "refund",
  chargeback: "chargeback",
  payout: "payout",
  payout_return: "payout_return",
};

export interface LedgerAdapterDeps {
  /** The account of a user party, looked up without creating one. Null when the party has none in that currency. */
  userAccount(partyId: string, accountType: PaymentAccountType, currency: string): Promise<{ ok: true; accountId: string | null } | { ok: false }>;
  /** The profile behind a party, or null once its identity was removed. */
  profileForParty(partyId: string): Promise<{ ok: true; profileId: string | null } | { ok: false }>;
}

/** Where postings are filed. Production uses the defaults; a database suite passes its own so it can remove exactly its rows. */
export interface LedgerAdapterOptions {
  readonly scope?: string;
  readonly platformLabel?: string;
}

/** The production binding over a service-role client. */
export function paymentLedgerAdapter(sc: any, options: LedgerAdapterOptions = {}): PaymentLedgerPort {
  return paymentLedgerAdapterWith(sc, {
    async userAccount(partyId, accountType, currency) {
      try {
        const { data, error } = await sc
          .from("payment_accounts")
          .select("id")
          .eq("owner_kind", "user")
          .eq("owner_id", partyId)
          .eq("account_type", accountType)
          .eq("currency", currency)
          .eq("livemode", false)
          .maybeSingle();
        if (error) return { ok: false };
        return { ok: true, accountId: data ? String((data as Record<string, unknown>)["id"]) : null };
      } catch {
        return { ok: false };
      }
    },
    async profileForParty(partyId) {
      try {
        const { data, error } = await sc.from("payment_parties").select("profile_id").eq("id", partyId).maybeSingle();
        if (error || !data) return { ok: false };
        const p = (data as Record<string, unknown>)["profile_id"];
        return { ok: true, profileId: typeof p === "string" ? p : null };
      } catch {
        return { ok: false };
      }
    },
  }, options);
}

/** The binding with its two lookups injectable (the pure suite proves the translation with them faked). */
export function paymentLedgerAdapterWith(sc: any, deps: LedgerAdapterDeps, options: LedgerAdapterOptions = {}): PaymentLedgerPort {
  const scope = options.scope ?? LEDGER_SCOPE;
  const platformLabel = options.platformLabel ?? PLATFORM_PARTY_LABEL;
  const ensure = async (owner: PaymentAccountOwner, accountType: PaymentAccountType, currency: string): Promise<string | LedgerPostResult> => {
    const r = await ensurePaymentAccount(sc, { owner, accountType, currency });
    if (r.ok) return r.accountId;
    return r.reason === "ledger_unavailable"
      ? { ok: false, reason: "ledger_unavailable", detail: r.detail }
      : { ok: false, reason: "rejected", detail: `payment_account_ensure: ${r.reason}` };
  };

  const accountFor = async (e: LedgerEntry, posting: LedgerPosting): Promise<string | LedgerPostResult> => {
    switch (e.account) {
      case "processor_clearing":
        return ensure({ kind: "processor", label: posting.processor }, "processor_clearing", posting.currency);
      case "platform_revenue":
      case "tax_withheld":
        return ensure({ kind: "platform", label: platformLabel }, e.account, posting.currency);
      case "user_payable": {
        if (!e.partyId) return { ok: false, reason: "rejected", detail: "a user_payable entry names no party" };
        const found = await deps.userAccount(e.partyId, "user_payable", posting.currency);
        if (!found.ok) return { ok: false, reason: "ledger_unavailable", detail: "payment_accounts could not be read" };
        if (found.accountId) return found.accountId;
        const prof = await deps.profileForParty(e.partyId);
        if (!prof.ok) return { ok: false, reason: "ledger_unavailable", detail: "payment_parties could not be read" };
        if (!prof.profileId) {
          return { ok: false, reason: "rejected", detail: "the party's identity was removed and it has no account in this currency; nothing was booked" };
        }
        return ensure({ kind: "user", profileId: prof.profileId }, "user_payable", posting.currency);
      }
    }
  };

  return Object.freeze({
    async post(posting: LedgerPosting): Promise<LedgerPostResult> {
      const entries: Array<{ accountId: string; amountMinor: number; entryReason: PaymentEntryReason }> = [];
      const netByAccount = new Map<string, number>();
      for (const e of posting.entries) {
        const acct = await accountFor(e, posting);
        if (typeof acct !== "string") return acct;
        const credit = -e.amountMinor; // 3822: credit positive
        entries.push({ accountId: acct, amountMinor: credit, entryReason: REASON[e.reason] });
        netByAccount.set(acct, (netByAccount.get(acct) ?? 0) + credit);
      }
      const original = entries.filter((x) => x.amountMinor > 0).reduce((n, x) => n + x.amountMinor, 0);
      const beneficiary = [...netByAccount.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!beneficiary || original <= 0) return { ok: false, reason: "unbalanced", detail: "the posting credits no account" };

      const isPayout = posting.bookingId === null;
      const r = await postPaymentTransaction(sc, {
        scope,
        idempotencyKey: posting.key,
        kind: KIND[posting.kind],
        currency: posting.currency,
        originalCurrency: posting.currency,
        originalAmountMinor: original,
        attribution: isPayout
          ? { causeKind: "adjustment", causeId: `rab_payout:${posting.subjectId}`, subjectKind: "experience", subjectId: "rent_a_buddy", beneficiaryAccountId: beneficiary, attributionVersion: ATTRIBUTION_VERSION }
          : { causeKind: "booking", causeId: posting.bookingId as string, subjectKind: "booking", subjectId: posting.bookingId as string, beneficiaryAccountId: beneficiary, attributionVersion: ATTRIBUTION_VERSION },
        externalRef: posting.externalRef && EXTERNAL_REF.test(posting.externalRef) ? posting.externalRef : null,
        occurredAt: posting.occurredAt,
        entries,
      });
      if (r.ok) return { ok: true, replayed: r.replayed };
      switch (r.reason) {
        case "ledger_unavailable":
        case "retryable_contention":
        case "db_error":
          // Not an answer about this posting: the provider re-delivers and the same key is posted again.
          return { ok: false, reason: "ledger_unavailable", detail: `${r.reason}: ${r.detail}` };
        case "idempotency_conflict":
          return { ok: false, reason: "idempotency_conflict", detail: r.detail };
        case "transaction_unbalanced":
          return { ok: false, reason: "unbalanced", detail: r.detail };
        default:
          // insufficient_balance (a refund or payout larger than what is payable — #598 owner question 2),
          // invalid_request, live_mode_refused, …: kept by name in the detail.
          return { ok: false, reason: "rejected", detail: `${r.reason}: ${r.detail}` };
      }
    },
  });
}
