/**
 * PaymentLedger — the API's one door to the double-entry payment ledger
 * (migrations 3821, 3822, 3823; `09` §4–§7, §10).
 *
 *   ensurePaymentAccount      public.payment_account_ensure         (PAY-022)
 *   postPaymentTransaction    public.payment_post_transaction       (PAY-023, PAY-034, PAY-046, PAY-047)
 *   readPartyLedger           public.payment_party_ledger           (PAY-073)
 *   removePaymentIdentity     public.payment_party_remove_identity  (owner ruling 2026-10-04, erasure)
 *
 * ── EVERY CALL IS ONE DATABASE FUNCTION, AND THERE IS NO OTHER PATH ─────────
 * A posting is one `rpc` — envelope, entries and balance delta in one
 * transaction, or nothing. This module never reads a balance and writes it
 * back, never inserts a row itself (service_role holds no INSERT on the
 * ledger), and has NO FALLBACK: when the function is absent — the migration is
 * not applied here — every call answers `ledger_unavailable` and does nothing.
 * `09` §3.2 is explicit that the read-modify-write fallback acceptable for a
 * display counter "is not acceptable for money and must not be copied".
 *
 * ── NO MONEY ARITHMETIC IN THIS PROCESS (`09` §8) ───────────────────────────
 * Amounts are integer minor units and cross this module as decimal STRINGS, in
 * both directions. An amount handed in as a bigint or a safe-integer number is
 * rendered to its digits and nothing else; nothing here adds, subtracts,
 * negates, multiplies, rounds or compares two amounts. Whether entries balance,
 * whether a balance may go negative and what a balance is are the database's
 * answers. A conversion rate is a decimal string for the same reason.
 * `src/test/paymentLedgerShape.test.ts` fails if arithmetic appears here.
 *
 * ── TAGGED RESULTS ──────────────────────────────────────────────────────────
 * Every function resolves `{ ok: true, … }` or `{ ok: false, reason, detail }`
 * and never throws for a database answer. A refusal the database NAMES keeps
 * its name (`idempotency_conflict`, `insufficient_balance`, …): reporting one
 * as `db_error` would tell a caller to retry something that can never succeed.
 * A replay is a success with `replayed: true` and the ORIGINAL transaction id.
 *
 * ── NO PROVIDER ─────────────────────────────────────────────────────────────
 * Nothing here imports, names or calls a payment provider. `externalRef` is an
 * opaque string the caller got from wherever it got it.
 *
 * ── TEST MODE ONLY ──────────────────────────────────────────────────────────
 * Every request is sent with `livemode: false`, and the tables CHECK it.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";

/** Gates the party-scoped read routes (`routes/payments.ts`). Seeded FALSE by 3823. */
export const PAYMENT_LEDGER_READS_FLAG = "payment_ledger_reads_enabled";

/** Fail-closed read of the routes' gate: off, absent or unreadable is `false`. */
export async function paymentLedgerReadsEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, PAYMENT_LEDGER_READS_FLAG);
}

// ── Vocabularies (each mirrors a CHECK constraint; the database decides) ─────

export const PAYMENT_ACCOUNT_TYPES = [
  "user_payable", "user_receivable", "platform_revenue", "platform_fee_expense",
  "processor_clearing", "payout_in_transit", "hold_reserve", "refund_liability", "tax_withheld",
] as const;
export type PaymentAccountType = (typeof PAYMENT_ACCOUNT_TYPES)[number];

export const PAYMENT_TRANSACTION_KINDS = [
  "charge", "capture", "fee", "payout", "refund", "chargeback", "reversal", "fx",
] as const;
export type PaymentTransactionKind = (typeof PAYMENT_TRANSACTION_KINDS)[number];

/**
 * `principal`, `tip` and `platform_fee` are separate reasons so a commission is
 * never folded into what it was charged on, and a tip never into a price.
 */
export const PAYMENT_ENTRY_REASONS = [
  "principal", "tip", "platform_fee", "customer_service_fee", "processor_fee", "tax",
  "hold", "hold_release", "payout", "payout_return", "refund", "chargeback",
  "chargeback_fee", "reversal", "fx_conversion", "fx_spread", "rounding", "adjustment",
] as const;
export type PaymentEntryReason = (typeof PAYMENT_ENTRY_REASONS)[number];

export const PAYMENT_CAUSE_KINDS = ["booking", "subscription", "tip", "reward", "adjustment"] as const;
export type PaymentCauseKind = (typeof PAYMENT_CAUSE_KINDS)[number];

/** What the money is ABOUT. Never a person. */
export const PAYMENT_SUBJECT_KINDS = [
  "place", "event", "trip", "experience", "booking", "itinerary", "trail", "intel_claim",
] as const;
export type PaymentSubjectKind = (typeof PAYMENT_SUBJECT_KINDS)[number];

// ── Amounts ─────────────────────────────────────────────────────────────────

/** Integer minor units as a decimal string, e.g. "1250" or "-1250". Never a float. */
export type MinorUnits = string;
/** What a caller may hand in. A number must be a safe integer. */
export type MinorUnitsInput = string | bigint | number;

const MINOR_UNITS_RE = /^-?[0-9]{1,18}$/;

/**
 * Render an amount to its digits. Returns null when it is not a whole number of
 * minor units this ledger can hold — the caller refuses rather than rounds.
 */
export function toMinorUnits(value: MinorUnitsInput): MinorUnits | null {
  let text: string;
  if (typeof value === "bigint") text = value.toString(10);
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    text = value.toFixed(0);
  } else if (typeof value === "string") text = value;
  else return null;
  return MINOR_UNITS_RE.test(text) ? text : null;
}

// ── Results ─────────────────────────────────────────────────────────────────

export type PaymentLedgerRefusal =
  /** The ledger's functions or tables are not here (migration not applied). Nothing was done. */
  | "ledger_unavailable"
  /** The request is not one the ledger accepts (shape, vocabulary, unknown account, currency). */
  | "invalid_request"
  /** The same (scope, idempotencyKey) already recorded DIFFERENT content (SQLSTATE PL409). */
  | "idempotency_conflict"
  /** A balance floor would be crossed (`09` §5.3 I6, SQLSTATE PL402). */
  | "insufficient_balance"
  /** The entries do not sum to zero, or are fewer than two (I1, PL002). */
  | "transaction_unbalanced"
  /** A reversal that is not the exact negation of what it reverses (PL004). */
  | "reversal_not_negation"
  /** The transaction named has already been reversed once (PL412). */
  | "already_reversed"
  /** `livemode` other than false. This ledger records test-mode money only (PL451). */
  | "live_mode_refused"
  /** A serialisation failure or deadlock: nothing was written, the same request may be retried. */
  | "retryable_contention"
  | "db_error";

export type PaymentLedgerFailure = { ok: false; reason: PaymentLedgerRefusal; detail: string };
export type PaymentLedgerResult<T> = ({ ok: true } & T) | PaymentLedgerFailure;

const refuse = (reason: PaymentLedgerRefusal, detail: string): PaymentLedgerFailure => ({ ok: false, reason, detail });

const SQLSTATE_REFUSALS: Readonly<Record<string, PaymentLedgerRefusal>> = {
  PL409: "idempotency_conflict",
  PL402: "insufficient_balance",
  PL002: "transaction_unbalanced",
  PL004: "reversal_not_negation",
  PL412: "already_reversed",
  PL451: "live_mode_refused",
  PL422: "invalid_request",
  PL006: "invalid_request",
  "40001": "retryable_contention",
  "40P01": "retryable_contention",
};

/**
 * PostgREST relays PostgreSQL's SQLSTATE as `error.code`. A missing function is
 * 42883 from PostgreSQL or PGRST202 from PostgREST's schema cache, and a missing
 * table 42P01: all three mean "3821–3823 are not applied here".
 */
export function classifyLedgerError(error: any): PaymentLedgerFailure {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? error ?? "");
  const named = SQLSTATE_REFUSALS[code];
  if (named) return refuse(named, message);
  if (code === "42883" || code === "PGRST202" || code === "42P01" ||
      /function \S+ does not exist|relation "[^"]+" does not exist|could not find the (function|table)/i.test(message)) {
    return refuse("ledger_unavailable", `the payment ledger is not applied here: ${message}`);
  }
  return refuse("db_error", message);
}

/** One function call. A thrown transport error is a failure too, never a success. */
async function call(sc: any, fn: string, payload: Record<string, unknown>): Promise<{ ok: true; data: any } | PaymentLedgerFailure> {
  try {
    const { data, error } = await sc.rpc(fn, { p: payload });
    if (error) return classifyLedgerError(error);
    if (data === null || data === undefined || typeof data !== "object") {
      return refuse("db_error", `${fn} returned no result`);
    }
    return { ok: true, data };
  } catch (err) {
    return refuse("db_error", String((err as any)?.message ?? err));
  }
}

// ── Accounts ────────────────────────────────────────────────────────────────

export type PaymentAccountOwner =
  | { kind: "user"; profileId: string }
  | { kind: "platform" | "processor"; label: string };

export interface EnsurePaymentAccountInput {
  owner: PaymentAccountOwner;
  accountType: PaymentAccountType;
  /** ISO 4217, upper case. There is no default: no currency is assumed. */
  currency: string;
}

/** Idempotent: the same owner, type and currency always resolve to the same account. */
export async function ensurePaymentAccount(
  sc: any,
  input: EnsurePaymentAccountInput,
): Promise<PaymentLedgerResult<{ accountId: string; created: boolean }>> {
  const payload: Record<string, unknown> = {
    owner_kind: input.owner.kind,
    account_type: input.accountType,
    currency: input.currency,
    livemode: false,
  };
  if (input.owner.kind === "user") payload["profile_id"] = input.owner.profileId;
  else payload["owner_label"] = input.owner.label;

  const r = await call(sc, "payment_account_ensure", payload);
  if (!r.ok) return r;
  const accountId = r.data.account_id;
  if (typeof accountId !== "string" || accountId === "") return refuse("db_error", "payment_account_ensure returned no account_id");
  return { ok: true, accountId, created: r.data.created === true };
}

// ── Posting ─────────────────────────────────────────────────────────────────

export interface PaymentEntryInput {
  accountId: string;
  /** Signed: a credit is positive, a debit negative. Never zero. */
  amountMinor: MinorUnitsInput;
  entryReason: PaymentEntryReason;
}

/** `09` §6 — decided at write time, stored on the transaction, never edited. */
export interface PaymentAttribution {
  causeKind: PaymentCauseKind;
  causeId: string;
  subjectKind: PaymentSubjectKind;
  subjectId: string;
  /** Must be an account one of the entries names. */
  beneficiaryAccountId: string;
  attributionVersion: string;
}

/** `09` §8 — the rate actually applied, its source and its time. Required when the currencies differ. */
export interface PaymentConversion {
  /** A positive decimal as a string, e.g. "0.9134". Never a JS float. */
  rate: string;
  source: string;
  at: string;
}

export interface PostPaymentTransactionInput {
  /** Names the kind of event (a route, a webhook source, a job). A slug; no ids. */
  scope: string;
  /** Derived from the EVENT, not the attempt (`09` §7). */
  idempotencyKey: string;
  kind: PaymentTransactionKind;
  /** The currency the entries are booked in. */
  currency: string;
  /** What the customer was presented: the original currency and amount. */
  originalCurrency: string;
  originalAmountMinor: MinorUnitsInput;
  conversion?: PaymentConversion | null;
  fxTransactionId?: string | null;
  reversesTransactionId?: string | null;
  attribution: PaymentAttribution;
  /** The processor's object id, opaque here. */
  externalRef?: string | null;
  /** When the event happened (ISO 8601), not when it was posted. */
  occurredAt: string;
  entries: readonly PaymentEntryInput[];
}

export interface PostedPaymentTransaction {
  transactionId: string;
  /** true: this key had already recorded this content; nothing was written by this call. */
  replayed: boolean;
  /** The accounts' balances after this posting. Empty on a replay. */
  balances: Array<{ accountId: string; balanceMinor: MinorUnits }>;
}

export async function postPaymentTransaction(
  sc: any,
  input: PostPaymentTransactionInput,
): Promise<PaymentLedgerResult<PostedPaymentTransaction>> {
  const original = toMinorUnits(input.originalAmountMinor);
  if (original === null) return refuse("invalid_request", "originalAmountMinor is not a whole number of minor units");

  const entries: Array<Record<string, unknown>> = [];
  for (const e of input.entries) {
    const amount = toMinorUnits(e.amountMinor);
    if (amount === null) return refuse("invalid_request", "an entry's amountMinor is not a whole number of minor units");
    entries.push({ account_id: e.accountId, amount_minor: amount, entry_reason: e.entryReason });
  }

  const payload: Record<string, unknown> = {
    scope: input.scope,
    idempotency_key: input.idempotencyKey,
    kind: input.kind,
    currency: input.currency,
    livemode: false,
    original_currency: input.originalCurrency,
    original_amount_minor: original,
    cause_kind: input.attribution.causeKind,
    cause_id: input.attribution.causeId,
    subject_kind: input.attribution.subjectKind,
    subject_id: input.attribution.subjectId,
    beneficiary_account_id: input.attribution.beneficiaryAccountId,
    attribution_version: input.attribution.attributionVersion,
    occurred_at: input.occurredAt,
    entries,
  };
  if (input.conversion) {
    payload["fx"] = { rate: input.conversion.rate, source: input.conversion.source, at: input.conversion.at };
  }
  if (input.fxTransactionId) payload["fx_transaction_id"] = input.fxTransactionId;
  if (input.reversesTransactionId) payload["reverses_transaction_id"] = input.reversesTransactionId;
  if (input.externalRef) payload["external_ref"] = input.externalRef;

  const r = await call(sc, "payment_post_transaction", payload);
  if (!r.ok) return r;
  const transactionId = r.data.transaction_id;
  if (typeof transactionId !== "string" || transactionId === "") {
    return refuse("db_error", "payment_post_transaction returned no transaction_id");
  }
  const balances = Array.isArray(r.data.balances) ? r.data.balances : [];
  return {
    ok: true,
    transactionId,
    replayed: r.data.replayed === true,
    balances: balances.map((b: any) => ({ accountId: String(b.account_id), balanceMinor: String(b.balance_minor) })),
  };
}

// ── The party-scoped read ───────────────────────────────────────────────────

export interface PartyLedgerAccount {
  accountId: string;
  accountType: string;
  currency: string;
  /** Posted balance: credits positive. "0" for an account with no entries. */
  balanceMinor: MinorUnits;
  entryCount: number;
}

export interface PartyLedgerEntry {
  entryId: string;
  transactionId: string;
  accountId: string;
  accountType: string;
  amountMinor: MinorUnits;
  currency: string;
  entryReason: string;
  transactionKind: string;
  causeKind: string;
  causeId: string;
  subjectKind: string;
  subjectId: string;
  attributionVersion: string;
  reversesTransactionId: string | null;
  occurredAt: string;
}

export interface PartyLedgerCursor { beforeOccurredAt: string; beforeEntryId: string }

export interface PartyLedger {
  /** false: this profile has no payment party. An answer — a failed read is `ok: false`. */
  hasParty: boolean;
  accounts: PartyLedgerAccount[];
  entries: PartyLedgerEntry[];
  nextCursor: PartyLedgerCursor | null;
}

export interface ReadPartyLedgerOptions {
  /** Only entries of transactions with this cause. Given together or not at all. */
  cause?: { kind: string; id: string } | null;
  /** 0–200; 0 reads the accounts only. Default 50. */
  limit?: number;
  cursor?: PartyLedgerCursor | null;
}

/**
 * The accounts `profileId`'s party owns, and the entries naming THOSE accounts.
 * The counterparty's entries are not in the result and no field of the result
 * is a counterparty's. `profileId` must be the authenticated caller's id —
 * `requireUser`'s — and never a value taken from a request.
 */
export async function readPartyLedger(
  sc: any,
  profileId: string,
  options: ReadPartyLedgerOptions = {},
): Promise<PaymentLedgerResult<PartyLedger>> {
  const payload: Record<string, unknown> = { profile_id: profileId };
  if (options.cause) {
    payload["cause_kind"] = options.cause.kind;
    payload["cause_id"] = options.cause.id;
  }
  if (options.limit !== undefined) payload["limit"] = options.limit;
  if (options.cursor) {
    payload["before_occurred_at"] = options.cursor.beforeOccurredAt;
    payload["before_entry_id"] = options.cursor.beforeEntryId;
  }

  const r = await call(sc, "payment_party_ledger", payload);
  if (!r.ok) return r;
  const d = r.data;
  // A result that does not have the function's shape is a failed read, not an
  // empty ledger: "no entries" must be something the database said.
  if (typeof d.has_party !== "boolean" || !Array.isArray(d.accounts) || !Array.isArray(d.entries)) {
    return refuse("db_error", "payment_party_ledger returned an unexpected shape");
  }
  const next = d.next_cursor;
  return {
    ok: true,
    hasParty: d.has_party,
    accounts: d.accounts.map((a: any) => ({
      accountId: String(a.account_id),
      accountType: String(a.account_type),
      currency: String(a.currency),
      balanceMinor: String(a.balance_minor),
      entryCount: a.entry_count,
    })),
    entries: d.entries.map((e: any) => ({
      entryId: String(e.entry_id),
      transactionId: String(e.transaction_id),
      accountId: String(e.account_id),
      accountType: String(e.account_type),
      amountMinor: String(e.amount_minor),
      currency: String(e.currency),
      entryReason: String(e.entry_reason),
      transactionKind: String(e.transaction_kind),
      causeKind: String(e.cause_kind),
      causeId: String(e.cause_id),
      subjectKind: String(e.subject_kind),
      subjectId: String(e.subject_id),
      attributionVersion: String(e.attribution_version),
      reversesTransactionId: e.reverses_transaction_id === null || e.reverses_transaction_id === undefined
        ? null : String(e.reverses_transaction_id),
      occurredAt: String(e.occurred_at),
    })),
    nextCursor: next && typeof next === "object"
      ? { beforeOccurredAt: String(next.before_occurred_at), beforeEntryId: String(next.before_entry_id) }
      : null,
  };
}

// ── Erasure ─────────────────────────────────────────────────────────────────

export interface RemovedPaymentIdentity {
  /** false: nothing was linked (no payment party, or already removed). */
  removed: boolean;
  accounts: number;
  /** Entries kept, now pseudonymised. Nothing is deleted. */
  entriesRetained: number;
  identityRemovedAt: string | null;
  /** null: the retention period is undecided (payment_retention_settings). */
  retentionPeriod: string | null;
  retainUntil: string | null;
}

/**
 * Pseudonymise a person's payment records: remove the one link between their
 * profile and their payment party. No ledger row changes, every balance is what
 * it was, and nothing is deleted. Idempotent. The pseudonym is not returned.
 *
 * NOT YET CALLED by `services/accountDeletion/AccountDeletionService.ts`: that
 * step belongs to the account-deletion workstream (PAY-T23). Until it is wired,
 * a deleted account's payment party keeps its link unless the profile row
 * itself is deleted (the foreign key then removes it).
 */
export async function removePaymentIdentity(
  sc: any,
  profileId: string,
): Promise<PaymentLedgerResult<RemovedPaymentIdentity>> {
  const r = await call(sc, "payment_party_remove_identity", { profile_id: profileId });
  if (!r.ok) return r;
  const d = r.data;
  if (typeof d.removed !== "boolean") return refuse("db_error", "payment_party_remove_identity returned an unexpected shape");
  return {
    ok: true,
    removed: d.removed,
    accounts: d.accounts,
    entriesRetained: d.entries_retained,
    identityRemovedAt: d.identity_removed_at ?? null,
    retentionPeriod: d.retention_period ?? null,
    retainUntil: d.retain_until ?? null,
  };
}
