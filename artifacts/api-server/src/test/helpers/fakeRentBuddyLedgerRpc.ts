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
  /** rent_buddy_global_controls.deposits_enabled — the ONE deposit switch. Absent / false = no deposit (the default). */
  depositEnabled?: boolean;
  /** rent_buddy_addons by id. Needs price_usd; is_active defaults to true; title optional. */
  addons?: Record<string, any>;
  /** rent_buddy_booking_addons, in insert order. */
  bookingAddons?: Array<{ booking_id: string; addon_id: string; title: string | null; price_usd: number }>;
}

export function emptyLedgerDb(over: Partial<FakeLedgerDb> = {}): FakeLedgerDb {
  return {
    bookings: {}, buddyProfiles: {}, feeRules: {}, feeOverrides: [], entries: [], ledger: {}, tips: {},
    payouts: {}, adminActions: [], admins: new Set<string>(), depositEnabled: false, addons: {}, bookingAddons: [], ...over,
  };
}

export const LEDGER_RPC_NAMES = [
  "rb_quote_booking",
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
const trimmed = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_LIMIT = 100_000_000;

/** rb_platform_fee_minor: round(total × percent / 100), in minor units. */
const feeMinorOf = (totalMinor: number, percent: number) => Math.round((totalMinor * percent) / 100);

/**
 * rb_booking_market: the ONE definition of a booking's market — the buddy's own
 * country and city, never a string on the booking row or in a request.
 */
function marketOf(bp: any): { level: string | null; country: string | null; city: string | null } {
  return { level: bp?.buddy_level ?? null, country: trimmed(bp?.country), city: trimmed(bp?.city) };
}

/** rb_booking_payment_terms: deposit and cash, behind the one switch. */
function paymentTerms(db: Pick<FakeLedgerDb, "depositEnabled">, totalMinor: number, mode: unknown, percent: unknown) {
  const m = trimmed(mode) ?? "full_in_app";
  if (db.depositEnabled !== true) {
    return { deposit_enabled: false, payment_mode: m, deposit_percent: 0, deposit_minor: 0, cash_balance_minor: m === "deposit_plus_cash" ? totalMinor : 0 };
  }
  if (m === "full_in_app") {
    return { deposit_enabled: true, payment_mode: m, deposit_percent: 100, deposit_minor: totalMinor, cash_balance_minor: 0 };
  }
  const pct = percent === null || percent === undefined ? 30 : Number(percent);
  const deposit = Math.round((totalMinor * pct) / 100);
  return { deposit_enabled: true, payment_mode: m, deposit_percent: pct, deposit_minor: deposit, cash_balance_minor: totalMinor - deposit };
}

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

/**
 * rb_quote_booking: the price, the commission and the terms a booking WOULD
 * carry, for the buddy's own market. `p_unit_price_usd` null ⇒ rate only.
 */
function quoteBookingModel(db: FakeLedgerDb, args: any): any {
  const bp = db.buddyProfiles[args.p_buddy_profile_id];
  if (!bp || !bp.user_id) return { ok: false, refusal: "buddy_not_found", detail: String(args.p_buddy_profile_id) };
  const mode = trimmed(args.p_payment_mode);
  if (mode !== null && mode !== "full_in_app" && mode !== "deposit_plus_cash") {
    return { ok: false, refusal: "invalid_payment_mode", detail: mode };
  }
  const market = marketOf(bp);
  const fee = resolveFee(db, { level: market.level, country: market.country, city: market.city, category: args.p_category });
  const base = {
    ok: true, buddy_profile_id: args.p_buddy_profile_id, category: trimmed(args.p_category),
    market_country: market.country, market_city: market.city,
    fee_percent: fee.fee_percent, fee_source: fee.fee_source, tip_commission_percent: 0,
  };
  if (args.p_unit_price_usd === null || args.p_unit_price_usd === undefined) {
    return { ...base, priced: false, deposit_enabled: db.depositEnabled === true };
  }
  const unit = Number(args.p_unit_price_usd);
  const qty = args.p_quantity === null || args.p_quantity === undefined ? 1 : Number(args.p_quantity);
  if (!Number.isFinite(unit) || !Number.isFinite(qty) || unit < 0 || qty <= 0 || Math.round(unit * qty * 100) >= MONEY_LIMIT * 100) {
    return { ok: false, refusal: "invalid_total", detail: `unit price ${unit} × quantity ${qty}` };
  }
  const pct = args.p_deposit_percent;
  if (pct !== null && pct !== undefined && (Number(pct) < 0 || Number(pct) > 100)) {
    return { ok: false, refusal: "invalid_arguments", detail: "deposit percent must be 0..100" };
  }
  const totalMinor = Math.round(unit * qty * 100);
  const feeMinor = feeMinorOf(totalMinor, fee.fee_percent);
  const terms = paymentTerms(db, totalMinor, mode, pct);
  return {
    ...base, priced: true,
    total_minor: totalMinor, total_usd: usd(totalMinor),
    fee_minor: feeMinor, fee_usd: usd(feeMinor), buddy_net_usd: usd(totalMinor - feeMinor),
    payment_mode: terms.payment_mode, deposit_enabled: terms.deposit_enabled, deposit_percent: terms.deposit_percent,
    deposit_usd: usd(terms.deposit_minor), cash_balance_usd: usd(terms.cash_balance_minor),
  };
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
    addons_usd: Number(b.addons_total_usd ?? 0),
    deposit_amount: Number(b.deposit_usd ?? 0),
    in_app_amount_collected: 0,
    cash_balance_due: Number(b.cash_balance_usd ?? 0),
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
  if (!["booking_created", "tip", "addons", "reversal", "settlement"].includes(event)) {
    return { ok: false, refusal: "unknown_event", detail: String(event) };
  }
  if ((event === "tip" || event === "settlement") && (!key || !/^[A-Za-z0-9_.:-]{1,120}$/.test(key))) {
    return { ok: false, refusal: "event_key_required", detail: "" };
  }
  // RESERVED: the transaction a pre-3824 tips row is carried into the entries under.
  if ((event === "tip" || event === "settlement") && key!.toLowerCase() === "carried-over") {
    return { ok: false, refusal: "event_key_reserved", detail: "" };
  }
  const b = db.bookings[bookingId];
  if (!b) return { ok: false, refusal: "booking_not_found", detail: String(bookingId) };
  const bp = db.buddyProfiles[b.buddy_id];
  const buddyUser: string | null = bp?.user_id ?? null;
  const market = marketOf(bp);
  const grossEntries = db.entries.filter((e) => e.booking_id === bookingId && e.entry_reason === "booking_gross");
  const hasGross = grossEntries.length > 0;
  const liveGross = grossEntries.some((e) => !db.entries.some((r) => r.reverses_entry_id === e.id));

  // A live booking whose earning entries are ALL reversed: refused by name, for
  // every earning event.
  if (["booking_created", "tip", "addons"].includes(event) && hasGross && !liveGross && !UNFULFILLED.includes(b.status)) {
    return { ok: false, refusal: "booking_reversed", detail: String(b.status) };
  }

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
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) >= MONEY_LIMIT * 100 || Math.round(amount * 100) < 1) return { ok: false, refusal: "invalid_amount", detail: "" };
    if (b.status !== "completed") return { ok: false, refusal: "booking_not_completed", detail: String(b.status) };
    if (!buddyUser) return { ok: false, refusal: "buddy_not_found", detail: "" };
    tipMinor = Math.round(amount * 100);
    const prior = db.entries.find((e) => e.idempotency_key === `booking:${bookingId}:tip:${key}#1`);
    if (prior) {
      if (prior.amount_minor !== tipMinor) return { ok: false, refusal: "idempotency_key_reused", detail: "" };
      tipReplay = true;
    }
  }

  // addons: every refusal first, then attach, re-total and re-term — one step.
  let addonsAdded = 0;
  let addedUsdMinor = 0;
  if (event === "addons") {
    const ids: unknown[] = Array.isArray(a.addon_ids) ? a.addon_ids : [];
    const allowed: unknown[] = Array.isArray(a.allowed_statuses) ? a.allowed_statuses : [];
    if (ids.some((x) => typeof x !== "string" || !UUID_RE.test(x))) return { ok: false, refusal: "invalid_arguments", detail: "addon_ids must be uuids" };
    if (!a.traveler_id || a.traveler_id !== b.traveler_id) return { ok: false, refusal: "not_traveler", detail: "" };
    if (ids.length === 0 || allowed.length === 0) return { ok: false, refusal: "invalid_arguments", detail: "" };
    if (!allowed.includes(b.status)) return { ok: false, refusal: "booking_not_open", detail: String(b.status) };
    const newMode = trimmed(a.payment_mode);
    if (newMode !== null && newMode !== "full_in_app" && newMode !== "deposit_plus_cash") return { ok: false, refusal: "invalid_arguments", detail: "unknown payment_mode" };
    if (!buddyUser) return { ok: false, refusal: "buddy_not_found", detail: "" };
    const total0 = Number(b.total_usd ?? 0);
    if (!Number.isFinite(total0) || total0 < 0) return { ok: false, refusal: "invalid_total", detail: String(b.total_usd) };
    const catalogue = db.addons ?? {};
    const valid = [...new Set(ids as string[])].filter((id) => catalogue[id] && catalogue[id].is_active !== false);
    if (valid.length === 0) return { ok: false, refusal: "no_valid_addons", detail: "" };
    const attached = (db.bookingAddons ??= []);
    const fresh = valid.filter((id) => !attached.some((r) => r.booking_id === bookingId && r.addon_id === id));
    addonsAdded = fresh.length;
    if (addonsAdded === 0) {
      replayed = true;
    } else {
      addedUsdMinor = fresh.reduce((n, id) => n + toMinor(catalogue[id].price_usd), 0);
      const newTotalMinor = toMinor(total0) + addedUsdMinor;
      if (newTotalMinor >= MONEY_LIMIT * 100) return { ok: false, refusal: "invalid_total", detail: "" };
      for (const id of fresh) attached.push({ booking_id: bookingId, addon_id: id, title: catalogue[id].title ?? null, price_usd: Number(catalogue[id].price_usd) });
      const terms = paymentTerms(db, newTotalMinor, newMode ?? b.payment_mode, a.deposit_percent);
      Object.assign(b, {
        total_usd: usd(newTotalMinor),
        addons_total_usd: usd(toMinor(b.addons_total_usd) + addedUsdMinor),
        deposit_usd: usd(terms.deposit_minor),
        cash_balance_usd: usd(terms.cash_balance_minor),
        payment_mode: terms.payment_mode,
        deposit_percent: terms.deposit_percent,
        deposit_rule_applied: terms.deposit_enabled ? (trimmed(a.deposit_rule) ?? b.deposit_rule_applied ?? null) : "no_deposit",
        deposit_reason: terms.deposit_enabled
          ? (trimmed(a.deposit_reason) ?? b.deposit_reason ?? null)
          : "No deposit is taken in the first release (owner ruling 2026-10-04).",
      });
    }
  }

  if (event === "booking_created" || ((event === "tip" || event === "addons") && !hasGross)) {
    if (hasGross) {
      replayed = true;
    } else {
      if (UNFULFILLED.includes(b.status)) return { ok: false, refusal: "booking_not_ledgerable", detail: String(b.status) };
      if (!buddyUser) return { ok: false, refusal: "buddy_not_found", detail: "" };
      const total = Number(b.total_usd ?? 0);
      if (!Number.isFinite(total) || total < 0) return { ok: false, refusal: "invalid_total", detail: String(b.total_usd) };
      // THE MARKET is the buddy's (rb_booking_market) — the booking's own `city` prices nothing.
      const fee = resolveFee(db, { level: market.level, country: market.country, city: market.city, category: b.category });
      feePercent = fee.fee_percent; feeSource = fee.fee_source;
      const totalMinor = toMinor(total);
      const feeMinor = feeMinorOf(totalMinor, fee.fee_percent);
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

  // addons on an already-ledgered booking: ADJUSTMENT entries, so the fold
  // equals the new total; the commission at the rate the booking was ledgered at.
  if (event === "addons" && hasGross && addonsAdded > 0) {
    const es = db.entries.filter((e) => e.booking_id === bookingId);
    const fold = (pred: (e: FakeLedgerEntry) => boolean) => es.filter(pred).reduce((n, e) => n + e.amount_minor, 0);
    const grossFold = fold((e) => e.account === "buddy_payable" && baseReason(db, e) === "booking_gross");
    const feeFold = fold((e) => e.account === "platform_revenue" && baseReason(db, e) === "platform_fee");
    let pct: number | null = db.ledger[bookingId]?.platform_fee_percent ?? null;
    if (pct === null) {
      const fee = resolveFee(db, { level: market.level, country: market.country, city: market.city, category: b.category });
      pct = fee.fee_percent; feePercent = fee.fee_percent; feeSource = fee.fee_source;
    }
    const totalMinor = toMinor(b.total_usd);
    const delta = totalMinor - grossFold;
    const feeDelta = feeMinorOf(totalMinor, pct) - feeFold;
    const n = new Set(es.filter((e) => e.transaction_key.startsWith(`booking:${bookingId}:addons:`)).map((e) => e.transaction_key.split(":")[3])).size + 1;
    const adj = (reason: "booking_gross" | "platform_fee", i: number, account: FakeLedgerEntry["account"], amount: number, ben: string | null) => {
      const tx = `booking:${bookingId}:addons:${n}:${reason}`;
      return append(db, {
        booking_id: bookingId, transaction_key: tx, idempotency_key: `${tx}#${i}`, account, entry_reason: reason,
        amount_minor: amount, reverses_entry_id: null, beneficiary_user_id: ben,
      });
    };
    if (delta !== 0) {
      appended += adj("booking_gross", 0, "traveler_receivable", -delta, null);
      appended += adj("booking_gross", 1, "buddy_payable", delta, buddyUser);
    }
    if (feeDelta !== 0) {
      appended += adj("platform_fee", 0, "buddy_payable", -feeDelta, buddyUser);
      appended += adj("platform_fee", 1, "platform_revenue", feeDelta, null);
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
    fee_percent: feePercent, fee_source: feeSource, rule_version: RULE,
    addons_added: event === "addons" ? addonsAdded : null,
    booking: event === "addons"
      ? {
          total_usd: Number(b.total_usd ?? 0), addons_total_usd: Number(b.addons_total_usd ?? 0),
          deposit_usd: Number(b.deposit_usd ?? 0), cash_balance_usd: Number(b.cash_balance_usd ?? 0),
          payment_mode: b.payment_mode ?? "full_in_app", added_usd: usd(addedUsdMinor),
        }
      : null,
    summary,
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
  // Counted by ENTRIES, not by summary rows: a summary row with no entries
  // contributes $0 to every figure here, so it is not "ledgered". A booking with
  // a price of 0 has no entries by design and is not counted.
  const unledgered = done.filter((b) => toMinor(b.total_usd) !== 0
    && !db.entries.some((e) => e.booking_id === b.id && e.entry_reason === "booking_gross")).length;
  return {
    completedCount: done.length,
    unledgeredCompletedCount: unledgered,
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
  // pending → on_hold → released. A payout that is paid, failed, cancelled,
  // already held or already released cannot be put on hold.
  if (action === "hold" && from !== "pending") {
    return refuse("conflict", { current_status: from, detail: `Payout is ${from}; this transition requires pending.` });
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
  /**
   * "The call COMMITTED and its answer was lost": return true and the function
   * runs — its writes stay — but the caller gets a connection error instead of
   * the answer. This is the case a retry must not turn into a second booking.
   */
  loseAnswer?: (fn: string, args: any) => boolean;
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
    const answer = answerLedgerFunction(db, fn, args, opts);
    if (answer && opts.loseAnswer?.(fn, args)) return answerLost();
    return answer ?? (opts.otherwise ? opts.otherwise(fn, args) : functionNotFound(fn));
  };
}

/** What a client sees when the connection drops after the statement committed. */
export function answerLost(): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code: "08006", message: "connection failure: the server closed the connection before the answer arrived" } };
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
    case "rb_quote_booking": return { data: quoteBookingModel(db, args), error: null };
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
 * about: the quote answers for whatever buddy and price it is handed (owner
 * default 10 %, no deposit), the posting function answers "posted" for whatever
 * booking it is handed, and every other function is absent, exactly as it was
 * for a client with no `.rpc` at all. `calls` records what was asked.
 */
export function acceptingLedgerRpc(calls: Array<{ fn: string; args: any }> = []) {
  return async (fn: string, args: any): Promise<{ data: any; error: any }> => {
    calls.push({ fn, args });
    if (fn === "rb_quote_booking") return acceptedBookingQuote(args);
    if (fn !== "rb_post_booking_ledger") return functionNotFound(fn);
    return acceptedLedgerPosting(args);
  };
}

/**
 * rb_quote_booking's answer for ANY buddy, in the seeded configuration: no fee
 * rule and no override (owner default 10 %), the deposit switch off. For fakes
 * whose rpc surface is a registry of `fn -> (args) => { data, error }`.
 */
export function acceptedBookingQuote(args: any): { data: any; error: null } {
  const id = args?.p_buddy_profile_id ?? "buddy";
  const db = emptyLedgerDb({ buddyProfiles: { [id]: { user_id: "payee" } } });
  return { data: quoteBookingModel(db, { ...args, p_buddy_profile_id: id }), error: null };
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
