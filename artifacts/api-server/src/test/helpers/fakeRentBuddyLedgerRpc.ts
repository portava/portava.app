/**
 * fakeRentBuddyLedgerRpc — an in-memory model of the SQL functions migration
 * `3824_rent_buddy_ledger_posting.sql` creates, for ROUTE tests. Not a test file.
 *
 * WHY THIS EXISTS. Since 3824 the API has no JavaScript path that writes a
 * booking's ledger, a tip, or a payout transition: each is one `.rpc()` call
 * and, with the function absent, a REFUSAL. A route test that hands the routes
 * a client with no `.rpc` therefore no longer exercises a fallback — there is
 * none — it exercises the refusal. Route tests that want the booking, the tip
 * or the transition to HAPPEN need the function, and this is it.
 *
 * WHAT IT MODELS, AND ITS LIMIT. The one property the SQL gives that a test of
 * a route can observe: the read-decide-write of each call is NOT separated by an
 * await, so two overlapping calls cannot interleave inside it (the booking's row
 * lock, the payout's row lock). The arithmetic and the state rules are restated
 * here from the migration so the stored state a route test asserts is the state
 * the real function would leave.
 *
 * It is a MODEL. The functions themselves are executed, against PostgreSQL, by
 * `src/test/db/rentBuddyLedgerPosting.db.test.ts` — that suite, not this file,
 * is the evidence about the SQL. If the two ever disagree, the database is
 * right and this file is wrong.
 */

export interface FakeLedgerEntry {
  id: string;
  booking_id: string;
  transaction_key: string;
  idempotency_key: string;
  account: "buddy_payable" | "platform_revenue" | "traveler_receivable" | "cash_external";
  entry_reason: "booking_gross" | "tip" | "platform_fee" | "reversal";
  amount_minor: number;
  reverses_entry_id: string | null;
  beneficiary_user_id: string | null;
}

export interface FakeLedgerDb {
  /** rent_buddy_bookings by id. Needs traveler_id, buddy_id, status, total_usd. */
  bookings: Record<string, any>;
  /** rent_buddy_profiles by id. Needs user_id; buddy_level / country / city optional. */
  buddyProfiles: Record<string, any>;
  /** rent_buddy_fee_rules: buddy_level → platform_fee_percent. Empty ⇒ owner default 10. */
  feeRules: Record<string, number>;
  /** rent_buddy_launch_controls rows that set platform_fee_percent. */
  feeOverrides: Array<{ country_code: string | null; city: string | null; category: string | null; platform_fee_percent: number }>;
  entries: FakeLedgerEntry[];
  /** rent_buddy_earnings_ledger by booking_id. */
  ledger: Record<string, any>;
  /** rent_buddy_tips by booking_id (UNIQUE in the real table). */
  tips: Record<string, any>;
  /** rent_buddy_payouts by id. */
  payouts: Record<string, any>;
  /** rent_buddy_admin_actions, in insert order. */
  adminActions: any[];
  /** profiles.id values whose role is 'admin'. */
  admins: Set<string>;
}

export function emptyLedgerDb(over: Partial<FakeLedgerDb> = {}): FakeLedgerDb {
  return {
    bookings: {}, buddyProfiles: {}, feeRules: {}, feeOverrides: [], entries: [], ledger: {}, tips: {},
    payouts: {}, adminActions: [], admins: new Set<string>(), ...over,
  };
}

export const LEDGER_RPC_NAMES = [
  "rb_post_booking_ledger",
  "rb_buddy_ledger_totals",
  "rb_resolve_platform_fee_percent",
  "rb_admin_payout_transition",
] as const;

const UNFULFILLED = ["cancelled", "cancelled_by_traveler", "cancelled_by_buddy", "declined", "expired"];
const EARNING = ["booking_gross", "platform_fee"];
const RULE = "rent-buddy-fee-schedule/v2";

/** What PostgREST answers for a function that is not in the schema cache. */
export function functionNotFound(fn: string): { data: null; error: { code: string; message: string } } {
  return {
    data: null,
    error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` },
  };
}

const usd = (minor: number) => minor / 100;
const toMinor = (v: unknown) => Math.round(Number(v ?? 0) * 100);

function resolveFee(db: FakeLedgerDb, sel: { level?: string | null; country?: string | null; city?: string | null; category?: string | null }) {
  const level = (sel.level ?? "").trim() || "new";
  const country = (sel.country ?? "").trim() || null;
  const city = (sel.city ?? "").trim() || null;
  const category = (sel.category ?? "").trim() || null;
  const specs: Array<[string | null, string | null, string | null, boolean]> = [
    [country, city, category, !!(country && city && category)],
    [country, null, category, !!(country && category)],
    [country, city, null, !!(country && city)],
    [country, null, null, !!country],
    [null, null, category, !!category],
    [null, null, null, true],
  ];
  for (const [c, ci, cat, applies] of specs) {
    if (!applies) continue;
    const hit = db.feeOverrides.find((o) => o.country_code === c && o.city === ci && o.category === cat);
    if (hit) return { fee_percent: hit.platform_fee_percent, fee_source: "launch_control" };
  }
  if (level in db.feeRules) return { fee_percent: db.feeRules[level], fee_source: "fee_schedule" };
  return { fee_percent: 10, fee_source: "owner_default" };
}

function baseReason(db: FakeLedgerDb, e: FakeLedgerEntry): string {
  if (!e.reverses_entry_id) return e.entry_reason;
  return db.entries.find((o) => o.id === e.reverses_entry_id)?.entry_reason ?? e.entry_reason;
}

function project(db: FakeLedgerDb, bookingId: string, feePercent: number | null, note: string | null): any {
  const b = db.bookings[bookingId];
  const es = db.entries.filter((e) => e.booking_id === bookingId);
  const sum = (pred: (e: FakeLedgerEntry) => boolean) => es.filter(pred).reduce((n, e) => n + e.amount_minor, 0);
  const gross = sum((e) => e.account === "buddy_payable" && baseReason(db, e) === "booking_gross");
  const tip = sum((e) => e.account === "buddy_payable" && baseReason(db, e) === "tip");
  const fee = sum((e) => e.account === "platform_revenue" && baseReason(db, e) === "platform_fee");
  const net = sum((e) => e.account === "buddy_payable");
  const prev = db.ledger[bookingId];
  const row = {
    ...(prev ?? {}),
    booking_id: bookingId,
    buddy_user_id: db.buddyProfiles[b.buddy_id]?.user_id ?? null,
    traveler_id: b.traveler_id,
    total_booking_usd: usd(gross),
    tip_usd: usd(tip),
    platform_fee_percent: feePercent ?? prev?.platform_fee_percent ?? null,
    platform_fee_amount: usd(fee),
    traveler_service_fee_amount: 0,
    buddy_gross_amount: usd(gross + tip),
    buddy_net_estimated_amount: usd(net),
    deposit_amount: prev?.deposit_amount ?? Number(b.deposit_usd ?? 0),
    in_app_amount_collected: 0,
    cash_balance_due: prev?.cash_balance_due ?? Number(b.cash_balance_usd ?? 0),
    cash_balance_confirmed: false,
    is_estimated: true,
    note: note ?? prev?.note ?? null,
  };
  db.ledger[bookingId] = row;
  return row;
}

let seq = 0;
function append(db: FakeLedgerDb, e: Omit<FakeLedgerEntry, "id">): number {
  if (db.entries.some((x) => x.idempotency_key === e.idempotency_key)) return 0;   // ON CONFLICT DO NOTHING
  db.entries.push({ ...e, id: `entry-${++seq}` });
  return 1;
}

function postBookingLedger(db: FakeLedgerDb, args: any): any {
  const bookingId = args.p_booking_id;
  const event = args.p_event;
  const key = typeof args.p_event_key === "string" && args.p_event_key.trim() ? args.p_event_key.trim() : null;
  const a = args.p_args ?? {};
  if (!["booking_created", "tip", "reversal", "settlement"].includes(event)) {
    return { ok: false, refusal: "unknown_event", detail: String(event) };
  }
  if ((event === "tip" || event === "settlement") && (!key || !/^[A-Za-z0-9_.:-]{1,120}$/.test(key))) {
    return { ok: false, refusal: "event_key_required", detail: "" };
  }
  const b = db.bookings[bookingId];
  if (!b) return { ok: false, refusal: "booking_not_found", detail: String(bookingId) };
  const bp = db.buddyProfiles[b.buddy_id];
  const buddyUser: string | null = bp?.user_id ?? null;
  const hasGross = db.entries.some((e) => e.booking_id === bookingId && e.entry_reason === "booking_gross");

  let appended = 0;
  let replayed = false;
  let feePercent: number | null = null;
  let feeSource: string | null = null;
  let note: string | null = null;

  let tipMinor = 0;
  let tipReplay = false;
  if (event === "tip") {
    const amount = Number(a.amount_usd);
    if (!a.traveler_id || a.traveler_id !== b.traveler_id) return { ok: false, refusal: "not_traveler", detail: "" };
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) < 1) return { ok: false, refusal: "invalid_amount", detail: "" };
    if (b.status !== "completed") return { ok: false, refusal: "booking_not_completed", detail: String(b.status) };
    if (!buddyUser) return { ok: false, refusal: "buddy_not_found", detail: "" };
    tipMinor = Math.round(amount * 100);
    const prior = db.entries.find((e) => e.idempotency_key === `booking:${bookingId}:tip:${key}#1`);
    if (prior) {
      if (prior.amount_minor !== tipMinor) return { ok: false, refusal: "idempotency_key_reused", detail: "" };
      tipReplay = true;
    }
  }

  if (event === "booking_created" || (event === "tip" && !hasGross)) {
    if (hasGross) {
      replayed = true;
    } else {
      if (UNFULFILLED.includes(b.status)) return { ok: false, refusal: "booking_not_ledgerable", detail: String(b.status) };
      if (!buddyUser) return { ok: false, refusal: "buddy_not_found", detail: "" };
      const total = Number(b.total_usd ?? 0);
      if (!Number.isFinite(total) || total < 0) return { ok: false, refusal: "invalid_total", detail: String(b.total_usd) };
      const fee = resolveFee(db, { level: bp?.buddy_level, country: b.country_code ?? bp?.country, city: b.city, category: b.category });
      feePercent = fee.fee_percent; feeSource = fee.fee_source;
      const totalMinor = toMinor(total);
      const feeMinor = Math.round((totalMinor * fee.fee_percent) / 100);
      const mk = (reason: "booking_gross" | "platform_fee", i: number, account: FakeLedgerEntry["account"], amount: number, ben: string | null) => {
        const tx = `booking:${bookingId}:${reason}:${RULE}`;
        return append(db, {
          booking_id: bookingId, transaction_key: tx, idempotency_key: `${tx}#${i}`, account, entry_reason: reason,
          amount_minor: amount, reverses_entry_id: null, beneficiary_user_id: ben,
        });
      };
      if (totalMinor !== 0) {
        appended += mk("booking_gross", 0, "traveler_receivable", -totalMinor, null);
        appended += mk("booking_gross", 1, "buddy_payable", totalMinor, buddyUser);
      }
      if (feeMinor !== 0) {
        appended += mk("platform_fee", 0, "buddy_payable", -feeMinor, buddyUser);
        appended += mk("platform_fee", 1, "platform_revenue", feeMinor, null);
      }
    }
  }

  if (event === "tip") {
    if (tipReplay) {
      replayed = true;
    } else {
      const tx = `booking:${bookingId}:tip:${key}`;
      appended += append(db, {
        booking_id: bookingId, transaction_key: tx, idempotency_key: `${tx}#0`, account: "traveler_receivable",
        entry_reason: "tip", amount_minor: -tipMinor, reverses_entry_id: null, beneficiary_user_id: null,
      });
      appended += append(db, {
        booking_id: bookingId, transaction_key: tx, idempotency_key: `${tx}#1`, account: "buddy_payable",
        entry_reason: "tip", amount_minor: tipMinor, reverses_entry_id: null, beneficiary_user_id: buddyUser,
      });
    }
  }

  if (event === "reversal") {
    if (!UNFULFILLED.includes(b.status)) return { ok: false, refusal: "booking_not_reversible", detail: String(b.status) };
    const targets = db.entries.filter((e) =>
      e.booking_id === bookingId && EARNING.includes(e.entry_reason)
      && !db.entries.some((r) => r.reverses_entry_id === e.id));
    for (const o of targets) {
      appended += append(db, {
        booking_id: bookingId, transaction_key: `reversal:${o.transaction_key}`, idempotency_key: `reversal:${o.idempotency_key}`,
        account: o.account, entry_reason: "reversal", amount_minor: -o.amount_minor, reverses_entry_id: o.id,
        beneficiary_user_id: o.beneficiary_user_id,
      });
    }
    if (targets.length === 0) {
      if (!hasGross && !db.ledger[bookingId]) {
        return { ok: true, event, replayed: false, entries_appended: 0, outcome: "nothing_to_reverse", summary: null };
      }
      replayed = true;
    } else {
      note = `Earning entries reversed: booking ${a.cause ?? b.status}.`;
    }
  }

  if (event === "settlement") {
    // The route layer never posts one; the refusal is all a route test can see.
    return { ok: false, refusal: "settlement_provider_required", detail: "" };
  }

  const summary = project(db, bookingId, feePercent, note);

  if (event === "tip") {
    db.tips[bookingId] = {
      id: db.tips[bookingId]?.id ?? `tip-${bookingId}`,
      booking_id: bookingId, traveler_id: b.traveler_id, buddy_user_id: buddyUser,
      amount_usd: summary.tip_usd, note: a.note ?? db.tips[bookingId]?.note ?? null,
    };
    b.tip_usd = summary.tip_usd;
  }

  return {
    ok: true, event, replayed: replayed && appended === 0, entries_appended: appended,
    fee_percent: feePercent, fee_source: feeSource, rule_version: RULE, summary,
  };
}

function ledgerTotals(db: FakeLedgerDb, args: any): any {
  const buddyUser = args.p_buddy_user_id;
  const profileIds = Object.entries(db.buddyProfiles).filter(([, p]) => p.user_id === buddyUser).map(([id]) => id);
  const done = Object.values(db.bookings).filter((b: any) => profileIds.includes(b.buddy_id) && b.status === "completed") as any[];
  const ids = new Set(done.map((b) => b.id));
  const es = db.entries.filter((e) => ids.has(e.booking_id));
  const sum = (pred: (e: FakeLedgerEntry) => boolean) => es.filter(pred).reduce((n, e) => n + e.amount_minor, 0);
  const gross = sum((e) => e.account === "buddy_payable" && baseReason(db, e) === "booking_gross");
  const tip = sum((e) => e.account === "buddy_payable" && baseReason(db, e) === "tip");
  const fee = sum((e) => e.account === "platform_revenue" && baseReason(db, e) === "platform_fee");
  const net = sum((e) => e.account === "buddy_payable");
  const ledgered = done.filter((b) => db.ledger[b.id]).length;
  return {
    completedCount: done.length,
    unledgeredCompletedCount: done.length - ledgered,
    completedTotalUsd: done.reduce((n, b) => n + toMinor(b.total_usd), 0) / 100,
    ledgeredGrossUsd: usd(gross),
    estimatedPlatformFeeUsd: usd(fee),
    estimatedBuddyEarningsUsd: usd(net - tip),
    tipsTotalUsd: usd(tip),
    tipCount: es.filter((e) => e.account === "buddy_payable" && baseReason(db, e) === "tip" && e.amount_minor > 0).length,
    inAppAmountCollectedUsd: 0,
    cashBalanceDueUsd: done.filter((b) => b.cash_balance_confirmed_by_buddy !== true).reduce((n, b) => n + toMinor(b.cash_balance_usd), 0) / 100,
    cashBalanceConfirmedUsd: done.filter((b) => b.cash_balance_confirmed_by_buddy === true).reduce((n, b) => n + toMinor(b.cash_balance_usd), 0) / 100,
    isEstimated: true,
  };
}

function payoutTransition(db: FakeLedgerDb, args: any, opts: FakeLedgerRpcOptions): { data: any; error: any } {
  const { p_payout_id: id, p_action: action, p_admin_id: adminId } = args;
  const reason = typeof args.p_reason === "string" ? args.p_reason.trim() : "";
  const refuse = (refusal: string, extra: Record<string, unknown> = {}) => ({ data: { ok: false, refusal, detail: refusal, ...extra }, error: null });
  if (action !== "hold" && action !== "release") return refuse("unknown_action");
  if (!adminId || !db.admins.has(adminId)) return refuse("not_admin");
  if (reason.length === 0 || reason.length > 1000) return refuse("reason_required");
  const row = db.payouts[id];
  if (!row) return refuse("not_found");
  const from = row.status;
  if (action === "hold" && (from === "on_hold" || from === "released")) {
    return refuse("conflict", { current_status: from, detail: `Payout is ${from}; this transition requires a status other than on_hold or released.` });
  }
  if (action === "release" && from !== "on_hold") {
    return refuse("conflict", { current_status: from, detail: `Payout is ${from}; this transition requires on_hold.` });
  }
  // ONE transaction: if the audit row cannot be written, the status does not move.
  if (opts.failPayoutAudit?.()) {
    return { data: null, error: { code: "P0001", message: "scripted failure of the audit insert" } };
  }
  const now = new Date().toISOString();
  if (action === "hold") Object.assign(row, { status: "on_hold", hold_reason: reason, held_by: adminId, held_at: now, updated_at: now });
  else Object.assign(row, { status: "released", notes: reason, released_by: adminId, released_at: now, updated_at: now });
  const audit = {
    id: `audit-${db.adminActions.length + 1}`, admin_id: adminId, target_type: "payout", target_id: id,
    action: action === "hold" ? "payout_held" : "payout_released", notes: reason,
    details: { from_status: from, to_status: row.status, amount_usd: row.amount_usd ?? null, booking_id: row.booking_id ?? null },
  };
  db.adminActions.push(audit);
  return { data: { ok: true, action, from_status: from, to_status: row.status, audit_id: audit.id, payout: { ...row } }, error: null };
}

export interface FakeLedgerRpcOptions {
  /** Stand-in for the network round trip, so overlapping calls really overlap. */
  tick?: () => Promise<void>;
  /** Functions to answer as ABSENT (PGRST202) — "3824 is not applied". */
  absent?: readonly string[];
  /** Every call, in order — for assertions about what a route asked for. */
  calls?: Array<{ fn: string; args: any }>;
  /** Return true to make the payout audit insert fail (the whole call errors). */
  failPayoutAudit?: () => boolean;
  /** Anything this model does not own is delegated here; default: not found. */
  otherwise?: (fn: string, args: any) => Promise<{ data: any; error: any }> | { data: any; error: any };
}

/**
 * A `.rpc()` for a fake Supabase client. After the initial `await tick()` each
 * function's read-decide-write runs SYNCHRONOUSLY — the guarantee the real
 * function gets from its row lock.
 */
export function fakeLedgerRpc(db: FakeLedgerDb, opts: FakeLedgerRpcOptions = {}) {
  return async (fn: string, args: any): Promise<{ data: any; error: any }> => {
    opts.calls?.push({ fn, args });
    if (opts.tick) await opts.tick();
    if (opts.absent?.includes(fn)) return functionNotFound(fn);
    return answerLedgerFunction(db, fn, args, opts) ?? (opts.otherwise ? opts.otherwise(fn, args) : functionNotFound(fn));
  };
}

/**
 * The same model, SYNCHRONOUSLY, for a fake that answers at the HTTP layer: a
 * real supabase client over a fake `fetch` whose responder is synchronous (the
 * rabLifecycle* suites). Returns what `.rpc()` would resolve to — the PostgREST
 * response BODY is its `data` — or `null` for a function this model does not own.
 */
export function answerLedgerFunction(
  db: FakeLedgerDb, fn: string, args: any, opts: FakeLedgerRpcOptions = {},
): { data: any; error: any } | null {
  switch (fn) {
    case "rb_post_booking_ledger": return { data: postBookingLedger(db, args), error: null };
    case "rb_buddy_ledger_totals": return { data: ledgerTotals(db, args), error: null };
    case "rb_resolve_platform_fee_percent":
      return {
        data: [resolveFee(db, { level: args.p_buddy_level, country: args.p_country_code, city: args.p_city, category: args.p_category })],
        error: null,
      };
    case "rb_admin_payout_transition": return payoutTransition(db, args, opts);
    default: return null;
  }
}

/**
 * `rb_confirm_booking_cash` (migration 2330), modelled over a bookings map and a
 * buddy-profiles map. Since PAY-018 the route has no read-then-write fallback,
 * so a route test that wants a cash confirmation to HAPPEN needs the function.
 * Read-decide-write is synchronous, as it is under the real row lock.
 */
export function fakeConfirmBookingCash(
  db: { bookings: Record<string, any>; buddyProfiles: Record<string, any> },
  args: any,
): { data: any; error: null } {
  const b = db.bookings[args.p_booking_id];
  if (!b) return { data: [{ outcome: "not_found" }], error: null };
  const bp = db.buddyProfiles[b.buddy_id];
  const isTraveler = b.traveler_id === args.p_actor_id;
  const isBuddy = !!bp && bp.user_id === args.p_actor_id;
  if (!isTraveler && !isBuddy) return { data: [{ outcome: "not_party" }], error: null };

  const due = Number(b.cash_balance_usd ?? 0);
  if (args.p_confirmed === true && args.p_amount_usd !== null && args.p_amount_usd !== undefined
      && Number(args.p_amount_usd) > due + 0.005) {
    return { data: [{ outcome: "amount_exceeds_due", cash_due_usd: due }], error: null };
  }

  if (isTraveler) b.cash_balance_confirmed_by_traveler = args.p_confirmed;
  if (isBuddy) b.cash_balance_confirmed_by_buddy = args.p_confirmed;
  return {
    data: [{
      outcome: "confirmed",
      acted_as_traveler: isTraveler,
      acted_as_buddy: isBuddy,
      traveler_confirmed: b.cash_balance_confirmed_by_traveler ?? null,
      buddy_confirmed: b.cash_balance_confirmed_by_buddy ?? null,
      traveler_user_id: b.traveler_id,
      booking_status: b.status,
      cash_due_usd: due,
      dispute_expires_at: b.dispute_window_expires_at ?? null,
    }],
    error: null,
  };
}

/**
 * The smallest `.rpc()` a route test needs when the ledger is NOT what it is
 * about: the posting function answers "posted" for whatever booking it is
 * handed, and every other function is absent, exactly as it was for a client
 * with no `.rpc` at all. `calls` records what was asked.
 */
export function acceptingLedgerRpc(calls: Array<{ fn: string; args: any }> = []) {
  return async (fn: string, args: any): Promise<{ data: any; error: any }> => {
    calls.push({ fn, args });
    if (fn !== "rb_post_booking_ledger") return functionNotFound(fn);
    return acceptedLedgerPosting(args);
  };
}

/**
 * The "posted" answer of rb_post_booking_ledger, for a fake whose rpc surface is
 * a registry of `fn -> (args) => { data, error }` (helpers/failClosedSupabase.ts).
 */
export function acceptedLedgerPosting(args: any): { data: any; error: null } {
  return {
    data: {
      ok: true, event: args?.p_event, replayed: false, entries_appended: 4, fee_percent: 10,
      fee_source: "owner_default", rule_version: RULE,
      summary: {
        booking_id: args?.p_booking_id, total_booking_usd: 0, tip_usd: 0, platform_fee_percent: 10,
        platform_fee_amount: 0, traveler_service_fee_amount: 0, buddy_gross_amount: 0,
        buddy_net_estimated_amount: 0, in_app_amount_collected: 0, is_estimated: true,
      },
    },
    error: null,
  };
}
