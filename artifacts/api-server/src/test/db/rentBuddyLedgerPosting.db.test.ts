/**
 * rentBuddyLedgerPosting.db.test.ts — migration 3824, EXECUTED.
 *
 * Payments PAY-T12 / PAY-T21 (requirement rows PAY-009, PAY-010, PAY-014,
 * PAY-018, PAY-050, PAY-055, PAY-067, PAY-075). Every assertion here is about
 * rows read back out of a real PostgreSQL after a real call to the functions
 * `3824_rent_buddy_ledger_posting.sql` defines — not about the text of the
 * migration and not about what a function returned.
 *
 * WHAT IS PROVEN
 *   M  the migration applies twice, rolls back, and re-applies, on a clone;
 *      the rollback REFUSES while a settlement entry or an override exists
 *   G  the functions are executable by service_role and by no client role
 *   C  booking_created: one call writes the entries and the summary together;
 *      the summary equals the fold of the entries; the commission comes from
 *      configuration (override → schedule → 10); integer minor-unit rounding;
 *      idempotent, sequentially and under concurrency; a booking the retired
 *      JavaScript writer already ledgered is a replay
 *   T  a tip appends exactly one pair and NO commission entry, and afterwards
 *      the summary, the tips row and the booking's tip_usd all equal the fold
 *   R  cancelling / declining / expiring a booking, and a dispute resolved
 *      against the buddy, append EXACT reversals in the transaction that moves
 *      the status; nothing is updated or deleted; a reversal that cannot be
 *      written aborts the status change
 *   S  is_estimated is cleared by a settlement entry and by nothing else; a
 *      settlement must name a provider (scripted here — no route can post one)
 *   L  rb_buddy_ledger_totals is the fold, and reports 0 collected
 *   P  a payout hold / release and its audit row commit together or not at
 *      all; refusals change nothing
 *   X  the TypeScript callers (lib/rentBuddyLedgerPosting.ts) speak to the real
 *      functions: parameter names, return shapes, and the named error when a
 *      function is absent
 *   Q  ONE market: the rate AND the amount rb_quote_booking shows are the rate
 *      and the amount rb_post_booking_ledger posts, for a booking whose own city
 *      and country are not the buddy's
 *   D  the deposit switch: off (and absent) = 0 deposit; on = integer minor units
 *   A  add-ons are one idempotent ledger event: the fold equals the new total,
 *      commission included, at the rate the booking was ledgered at
 *   U  unledgered is counted by ENTRIES; an unfulfilled booking cannot be revived
 *   K  the creation key is unique per traveller
 *   N  main's 3530 (#610, "nothing collected") and 3824 together: applied in
 *      order, all four of #610's surfaces report 0 collected over real rows,
 *      the scheduled amount and the net survive 3824's no-deposit bookings, and
 *      3530 applied AFTER 3824 is shown to bring a negative net back
 *
 * THE PURE MODEL IS THE SPECIFICATION. `lib/creatorLedgerEntries.ts`
 * (`buildBookingEntries`, `buildReversal`) used to be the writer's arithmetic
 * and had no production caller for reversals. The writer is SQL now; C3 and R1
 * hold the SQL to the model, entry for entry, key for key.
 *
 * Skips without LOCAL_DB_URL, exactly as every suite in this directory does;
 * scripts/local-db/run-tests.sh is the run that refuses skipped > 0.
 *
 * Run: pnpm --filter @workspace/api-server test:db-local
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  HAVE_DB, LOCAL_DB_URL, creatorLedgerPurgeSql, currentDatabaseUrl, exec, psql, rows, scalar, seedUser, useDatabase,
} from "./localDb.js";
import { buildBookingEntries, buildReversal, type LedgerEntry } from "../../lib/creatorLedgerEntries.js";
import { RENT_BUDDY_FEE_RULE_VERSION, toEarningsEntryRow } from "../../lib/creatorLedgerRows.js";
import { collectedInAppUsd, scheduledInAppUsd, withNothingCollected } from "../../lib/rentBuddyCollectedMoney.js";
import {
  LEDGER_REVERSED_NOTE_PREFIX,
  LEDGER_UNAVAILABLE,
  postBookingAddons,
  postBookingLedgerEvent,
  postBookingTip,
  quoteBooking,
  quotePricedBooking,
  readBuddyLedgerTotals,
  transitionPayout,
} from "../../lib/rentBuddyLedgerPosting.js";

const REPO = new URL("../../../../../", import.meta.url);
const sqlFile = (rel: string) => readFileSync(new URL(rel, REPO), "utf8");
const FORWARD = "artifacts/api-server/src/migrations/3824_rent_buddy_ledger_posting.sql";
const ROLLBACK = "db/rollback/2026-10-04-3824-rent-buddy-ledger-posting-rollback.sql";
/** main's #610: the aggregate that reports nothing as collected. Sorts BEFORE 3824. */
const M3530 = "artifacts/api-server/src/migrations/3530_rb_earnings_summary_nothing_collected.sql";

/** The rule generation 3824 stamps. v1 is the retired JavaScript writer's. */
const RULE_V2 = "rent-buddy-fee-schedule/v2";

// Markers that make this suite's configuration rows unmistakable and removable.
const MARKET = `PAYD-Testland-${randomUUID().slice(0, 8)}`;
const LEVEL_25 = `payd_lvl_25_${randomUUID().slice(0, 6)}`;
const LEVEL_BAD = `payd_lvl_bad_${randomUUID().slice(0, 6)}`;

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

// ── psql helpers ─────────────────────────────────────────────────────────────

/** Run a script as `service_role`, in one transaction. */
function asService(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

/** `rb_post_booking_ledger` as the API's role. Returns the function's jsonb. */
function post(bookingId: string, event: string, key: string | null = null, args: Record<string, unknown> = {}): any {
  const out = asService(
    `SELECT public.rb_post_booking_ledger(${q(bookingId)}, ${q(event)}, ${key === null ? "NULL" : q(key)}, ${q(JSON.stringify(args))}::jsonb)::text;`,
  );
  return JSON.parse(out.join("\n"));
}

/** psql, async — so several calls are genuinely in flight at once. */
function psqlAsync(script: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("psql", ["-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-At", currentDatabaseUrl()]);
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (c) => { stdout += c; });
    p.stderr.on("data", (c) => { stderr += c; });
    p.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
    p.stdin.end(script);
  });
}

interface EntryRow {
  id: string; transaction_key: string; account: string; entry_reason: string; amount_minor: number;
  currency: string; cash_settled_minor: number; rule_version: string; attribution_kind: string;
  attribution_id: string; beneficiary_user_id: string | null; reverses_entry_id: string | null;
  provider: string; external_ref: string | null; idempotency_key: string;
}
const entriesOf = (bookingId: string): EntryRow[] =>
  rows<EntryRow>(
    `SELECT id, transaction_key, account, entry_reason, amount_minor::int AS amount_minor, btrim(currency::text) AS currency,
            cash_settled_minor::int AS cash_settled_minor, rule_version, attribution_kind, attribution_id,
            beneficiary_user_id, reverses_entry_id, provider, external_ref, idempotency_key
       FROM public.rent_buddy_earnings_entries WHERE booking_id = ${q(bookingId)} ORDER BY idempotency_key`,
  );

interface SummaryRow {
  booking_id: string; buddy_user_id: string | null; traveler_id: string | null; total_booking_usd: number;
  tip_usd: number; platform_fee_percent: number | null; platform_fee_amount: number;
  traveler_service_fee_amount: number; buddy_gross_amount: number; buddy_net_estimated_amount: number;
  deposit_amount: number; in_app_amount_collected: number; cash_balance_due: number;
  cash_balance_confirmed: boolean; is_estimated: boolean; note: string | null;
}
const summaryOf = (bookingId: string): SummaryRow | null =>
  rows<SummaryRow>(
    `SELECT booking_id, buddy_user_id, traveler_id, total_booking_usd::float8 AS total_booking_usd, tip_usd::float8 AS tip_usd,
            platform_fee_percent, platform_fee_amount::float8 AS platform_fee_amount,
            traveler_service_fee_amount::float8 AS traveler_service_fee_amount,
            buddy_gross_amount::float8 AS buddy_gross_amount, buddy_net_estimated_amount::float8 AS buddy_net_estimated_amount,
            deposit_amount::float8 AS deposit_amount, in_app_amount_collected::float8 AS in_app_amount_collected,
            cash_balance_due::float8 AS cash_balance_due, cash_balance_confirmed, is_estimated, note
       FROM public.rent_buddy_earnings_ledger WHERE booking_id = ${q(bookingId)}`,
  )[0] ?? null;

/**
 * The fold, computed HERE from the entry rows, independently of the function's
 * own projection: the figure each summary column must equal. Minor units.
 */
function fold(entries: EntryRow[]) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const base = (e: EntryRow) => (e.reverses_entry_id ? byId.get(e.reverses_entry_id)!.entry_reason : e.entry_reason);
  const sum = (pred: (e: EntryRow) => boolean) => entries.filter(pred).reduce((n, e) => n + e.amount_minor, 0);
  return {
    gross: sum((e) => e.account === "buddy_payable" && base(e) === "booking_gross"),
    tip: sum((e) => e.account === "buddy_payable" && base(e) === "tip"),
    fee: sum((e) => e.account === "platform_revenue" && base(e) === "platform_fee"),
    net: sum((e) => e.account === "buddy_payable"),
    settled: sum((e) => e.account === "traveler_receivable" && base(e) === "settlement"),
    receivable: sum((e) => e.account === "traveler_receivable"),
    all: sum(() => true),
  };
}

/** Assert the stored summary row IS the fold of the stored entries. */
function assertSummaryIsFold(bookingId: string, label: string): void {
  const f = fold(entriesOf(bookingId));
  const s = summaryOf(bookingId);
  assert.ok(s, `${label}: no summary row`);
  assert.equal(Math.round(s!.total_booking_usd * 100), f.gross, `${label}: total_booking_usd is not the fold`);
  assert.equal(Math.round(s!.tip_usd * 100), f.tip, `${label}: tip_usd is not the fold`);
  assert.equal(Math.round(s!.platform_fee_amount * 100), f.fee, `${label}: platform_fee_amount is not the fold`);
  assert.equal(Math.round(s!.buddy_gross_amount * 100), f.gross + f.tip, `${label}: buddy_gross_amount is not the fold`);
  assert.equal(Math.round(s!.buddy_net_estimated_amount * 100), f.net, `${label}: buddy_net_estimated_amount is not the fold`);
  assert.equal(Math.round(s!.in_app_amount_collected * 100), f.settled, `${label}: in_app_amount_collected is not the fold`);
  assert.equal(s!.is_estimated, !(f.settled > 0 && f.receivable === 0), `${label}: is_estimated is not derived from the entries`);
  assert.equal(f.all, 0, `${label}: the booking's entries do not sum to zero`);
}

function unbalancedTransactions(bookingId: string): number {
  return Number(scalar(
    `SELECT count(*) FROM (SELECT 1 FROM public.rent_buddy_earnings_entries WHERE booking_id = ${q(bookingId)}
                           GROUP BY transaction_key, currency HAVING sum(amount_minor) <> 0) x`,
  ));
}

// ── A PostgREST-shaped rpc client over psql, for the TypeScript callers ──────
//
// The lib functions talk to supabase-js `.rpc(fn, args)`. PostgREST calls the
// function with NAMED arguments and returns a scalar-returning function's value
// directly and a set-returning function's rows as an array. This does exactly
// that, as `service_role`, and relays PostgreSQL's SQLSTATE as `error.code` —
// which is how a missing function (42883) reaches the caller.
const SET_RETURNING = new Set(["rb_resolve_platform_fee_percent", "rb_confirm_booking_cash"]);
function argLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") return `${q(JSON.stringify(v))}::jsonb`;
  return q(String(v));
}
function rpcClient(): any {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`rpcClient: refusing function name ${fn}`);
      const named = Object.entries(args ?? {}).map(([k, v]) => `${k} => ${argLiteral(v)}`).join(", ");
      const sql = SET_RETURNING.has(fn)
        ? `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM public.${fn}(${named}) t;`
        : `SELECT to_json(public.${fn}(${named}))::text;`;
      const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n${sql}`, { single: true });
      if (r.status !== 0) {
        const m = r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
        return { data: null, error: { code: m ? m[1] : "", message: m ? m[2]!.trim() : r.stderr.trim() } };
      }
      return { data: JSON.parse(r.stdout.trim() || "null"), error: null };
    },
  };
}

// ── The world ────────────────────────────────────────────────────────────────

interface World {
  traveller: string; outsider: string; admin: string;
  buddyUser: string; buddyProfile: string;          // level 'new' → no fee row on the harness → owner default
  buddy25User: string; buddy25Profile: string;      // LEVEL_25 → a fee_rules row at 25
  buddyBadUser: string; buddyBadProfile: string;    // LEVEL_BAD → a fee_rules row at 150
  users: string[]; bookings: string[]; payouts: string[];
}
const w = { users: [], bookings: [], payouts: [] } as unknown as World;

function seedBuddy(label: string, level: string): { user: string; profile: string } {
  const user = seedUser(label);
  w.users.push(user);
  const profile = scalar(
    `INSERT INTO public.rent_buddy_profiles (user_id, city, country, buddy_level)
     VALUES (${q(user)}, 'Payd City', ${q(MARKET)}, ${q(level)}) RETURNING id`,
  )!;
  return { user, profile };
}

function seedBooking(o: {
  buddyProfile?: string; total: number; status?: string; category?: string; city?: string;
  deposit?: number; cash?: number; country?: string | null;
}): string {
  const id = scalar(
    `INSERT INTO public.rent_buddy_bookings
       (buddy_id, traveler_id, booking_date, duration_h, city, category, status, total_usd, deposit_usd, cash_balance_usd, country_code)
     VALUES (${q(o.buddyProfile ?? w.buddyProfile)}, ${q(w.traveller)}, current_date, 2, ${q(o.city ?? "Payd City")},
             ${q(o.category ?? "city")}, ${q(o.status ?? "requested")}, ${o.total}, ${o.deposit ?? o.total}, ${o.cash ?? 0},
             ${o.country === null ? "NULL" : q(o.country ?? MARKET)})
     RETURNING id`,
  )!;
  w.bookings.push(id);
  return id;
}

const setStatus = (bookingId: string, status: string) =>
  asService(`UPDATE public.rent_buddy_bookings SET status = ${q(status)}, updated_at = now() WHERE id = ${q(bookingId)};`);

/** `rb_quote_booking` as the API's role. `price` null ⇒ a rate-only quote. */
function quote(buddyProfile: string, o: { category?: string | null; price?: number | string | null; qty?: number | string; mode?: string | null; pct?: number | null } = {}): any {
  const num = (v: number | string | null | undefined) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `${q(v)}::numeric`);
  const out = asService(
    `SELECT public.rb_quote_booking(${q(buddyProfile)}, ${o.category === null ? "NULL" : q(o.category ?? "city")}, ${num(o.price)}, ${num(o.qty ?? 1)}, ` +
    `${o.mode === null || o.mode === undefined ? "NULL" : q(o.mode)}, ${o.pct === null || o.pct === undefined ? "NULL" : String(o.pct)})::text;`,
  );
  return JSON.parse(out.join("\n"));
}

/** The booking row's money and terms, as stored. */
interface TermsRow { status: string; total_usd: number; addons_total_usd: number; deposit_usd: number; cash_balance_usd: number; payment_mode: string; deposit_percent: number | null; deposit_rule_applied: string | null }
const termsOf = (bookingId: string): TermsRow => rows<TermsRow>(
  `SELECT status::text AS status, total_usd::float8 AS total_usd, addons_total_usd::float8 AS addons_total_usd, deposit_usd::float8 AS deposit_usd,
          cash_balance_usd::float8 AS cash_balance_usd, payment_mode::text AS payment_mode, deposit_percent, deposit_rule_applied
     FROM public.rent_buddy_bookings WHERE id = ${q(bookingId)}`,
)[0]!;

/** An add-on of a buddy's. Removed with the buddy's profile (ON DELETE CASCADE). */
function seedAddon(buddyProfile: string, price: number, active = true): string {
  return scalar(
    `INSERT INTO public.rent_buddy_addons (buddy_id, title, price_usd, is_active) VALUES (${q(buddyProfile)}, 'payd add-on ' || ${price}, ${price}, ${active}) RETURNING id`,
  )!;
}
const attachedAddons = (bookingId: string) => rows<{ addon_id: string; price_usd: number }>(
  `SELECT addon_id, price_usd::float8 AS price_usd FROM public.rent_buddy_booking_addons WHERE booking_id = ${q(bookingId)} ORDER BY created_at, addon_id`,
);
const OPEN_STATUSES = ["pending", "requested", "scheduled"];
const addons = (bookingId: string, ids: string[], over: Record<string, unknown> = {}) =>
  post(bookingId, "addons", null, { traveler_id: w.traveller, addon_ids: ids, allowed_statuses: OPEN_STATUSES, ...over });

/** The ONE deposit switch: rent_buddy_global_controls.deposits_enabled on the singleton row (id = 1). */
const SWITCH_ON = `INSERT INTO public.rent_buddy_global_controls (id, deposits_enabled) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET deposits_enabled = true;`;
const SWITCH_OFF = `UPDATE public.rent_buddy_global_controls SET deposits_enabled = false WHERE id = 1;`;
const switchValue = () => scalar(`SELECT deposits_enabled FROM public.rent_buddy_global_controls WHERE id = 1`);

/**
 * Set the switch for the duration of `fn`, and put the singleton row back
 * EXACTLY as it was — including absent, which is how a harness without the
 * seed row starts and is itself a state the function must read as OFF.
 */
function withDepositSwitch<T>(state: "on" | "missing", fn: () => T): T {
  const saved = scalar(`SELECT row_to_json(gc)::text FROM public.rent_buddy_global_controls gc WHERE gc.id = 1`);
  exec(state === "on" ? SWITCH_ON : `DELETE FROM public.rent_buddy_global_controls WHERE id = 1;`);
  try { return fn(); } finally {
    exec(saved
      ? `DELETE FROM public.rent_buddy_global_controls WHERE id = 1;\nINSERT INTO public.rent_buddy_global_controls SELECT * FROM json_populate_record(NULL::public.rent_buddy_global_controls, ${q(saved)}::json);`
      : `DELETE FROM public.rent_buddy_global_controls WHERE id = 1;`);
  }
}

function urlFor(db: string): string { const u = new URL(LOCAL_DB_URL); u.pathname = `/${db}`; return u.toString(); }
const CLONE = `payd_3824_${randomUUID().slice(0, 8)}`;

describe("migration 3824 — the Rent-a-Buddy ledger posting door, executed", { skip: !HAVE_DB }, () => {
  before(() => {
    w.traveller = seedUser("payd_traveller");
    w.outsider = seedUser("payd_outsider");
    w.admin = seedUser("payd_admin");
    w.users.push(w.traveller, w.outsider, w.admin);
    exec(`UPDATE public.profiles SET role = 'admin' WHERE id = ${q(w.admin)};`);

    const b = seedBuddy("payd_buddy", "new");
    w.buddyUser = b.user; w.buddyProfile = b.profile;
    const b25 = seedBuddy("payd_buddy25", LEVEL_25);
    w.buddy25User = b25.user; w.buddy25Profile = b25.profile;
    const bad = seedBuddy("payd_buddybad", LEVEL_BAD);
    w.buddyBadUser = bad.user; w.buddyBadProfile = bad.profile;

    exec(
      `INSERT INTO public.rent_buddy_fee_rules (buddy_level, platform_fee_percent, traveler_service_fee_usd, traveler_service_fee_pct)
       VALUES (${q(LEVEL_25)}, 25, 0, 5), (${q(LEVEL_BAD)}, 150, 0, 0);`,
    );
  });

  after(() => {
    useDatabase(urlFor("postgres"));
    exec(`DROP DATABASE IF EXISTS "${CLONE}";`);
    useDatabase(null);
    const ids = (xs: string[]) => (xs.length ? xs : ["00000000-0000-0000-0000-000000000000"]).map(q).join(",");
    exec(
      // The entries are append-only and 3510 refuses their DELETE; the harness
      // superuser purges this suite's own synthetic rows (localDb's helper).
      `${creatorLedgerPurgeSql(w.users, w.bookings)}\n` +
      `DROP TRIGGER IF EXISTS payd_refuse_reversal ON public.rent_buddy_earnings_entries;\n` +
      `DROP FUNCTION IF EXISTS public.payd_refuse_reversal();\n` +
      `DROP TRIGGER IF EXISTS payd_refuse_audit ON public.rent_buddy_admin_actions;\n` +
      `DROP FUNCTION IF EXISTS public.payd_refuse_audit();\n` +
      `DELETE FROM public.rent_buddy_admin_actions WHERE target_type = 'payout' AND target_id IN (${ids(w.payouts)});\n` +
      `DELETE FROM public.rent_buddy_bookings WHERE id IN (${ids(w.bookings)});\n` +
      `DELETE FROM public.rent_buddy_launch_controls WHERE country_code = ${q(MARKET)};\n` +
      `DELETE FROM public.rent_buddy_fee_rules WHERE buddy_level IN (${q(LEVEL_25)}, ${q(LEVEL_BAD)});\n` +
      `DELETE FROM public.rent_buddy_profiles WHERE user_id IN (${ids(w.users)});\n` +
      `DELETE FROM public.profiles WHERE id IN (${ids(w.users)});\n` +
      `DELETE FROM auth.users WHERE id IN (${ids(w.users)});`,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // M — the migration itself, on a throwaway clone
  // ═══════════════════════════════════════════════════════════════════════════
  describe("M — apply, re-apply, rollback, re-apply (on a clone of the harness)", () => {
    const applyOnClone = (rel: string) => {
      const r = psql(sqlFile(rel));
      return { ok: r.status === 0, stderr: r.stderr };
    };
    const fnCount = () => Number(scalar(
      `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('rb_post_booking_ledger','rb_resolve_platform_fee_percent',
              'rb_booking_ledger_on_unfulfilled','rb_buddy_ledger_totals','rb_admin_payout_transition',
              'rb_quote_booking','rb_booking_market','rb_platform_fee_minor','rb_booking_payment_terms','rb_booking_refuse_uncancel')`,
    ));
    /** Round 2's schema objects: [the un-cancel trigger, the creation_key column, its unique index, the deposit switch column]. */
    const round2 = () => [
      scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.rent_buddy_bookings'::regclass AND tgname = 'rbb_refuse_uncancel'`),
      scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='rent_buddy_bookings' AND column_name='creation_key'`),
      scalar(`SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='rbb_creation_key_once'`),
      scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='rent_buddy_global_controls' AND column_name='deposits_enabled'`),
    ].map(Number);

    /** rb_buddy_earnings_summary as installed: [its search_path setting, whether it reads the payment mode (3824) or deposit_usd alone (3530)]. */
    const summaryFn = () => [
      (scalar(`SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public.rb_buddy_earnings_summary(uuid, numeric)'::regprocedure`) ?? "").replace(/[\s"]+/g, ""),
      scalar(`SELECT (pg_get_functiondef('public.rb_buddy_earnings_summary(uuid, numeric)'::regprocedure) ~ 'payment_mode')::text`),
    ];
    const BY_MODE = ["search_path=public,pg_temp", "true"];
    const AS_3530 = ["search_path=public", "false"];

    before(() => {
      const main = new URL(LOCAL_DB_URL).pathname.slice(1);
      useDatabase(urlFor("postgres"));
      exec(`DROP DATABASE IF EXISTS "${CLONE}";`);
      exec(`CREATE DATABASE "${CLONE}" TEMPLATE "${main}";`);
      useDatabase(urlFor(CLONE));
    });
    after(() => useDatabase(null));

    test("M1. the chain applied 3824: ten functions, the triggers, the columns, the widened vocabulary, the deposit switch OFF", () => {
      assert.equal(fnCount(), 10);
      assert.deepEqual(round2(), [1, 1, 1, 1]);
      assert.equal(scalar(`SELECT column_default || '/' || is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='rent_buddy_global_controls' AND column_name='deposits_enabled'`), "false/NO", "the deposit switch must default to OFF and can never be NULL");
      assert.equal(scalar(`SELECT count(*) FROM public.rent_buddy_global_controls WHERE deposits_enabled`), "0", "no row may be ON after the migration");
      assert.equal(scalar(`SELECT count(*) FROM public.feature_flags WHERE flag ILIKE '%deposit%'`), "0", "the switch is a column: no feature flag for it exists to be toggled from the flag list");
      assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.rent_buddy_bookings'::regclass AND tgname = 'rbb_reverse_ledger_on_unfulfilled'`), "1");
      assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='rent_buddy_launch_controls' AND column_name='platform_fee_percent'`), "1");
      assert.match(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rbee_entry_reason_check'`)!, /settlement/);
      assert.deepEqual(summaryFn(), BY_MODE, "after the chain (… 3530 … 3824) the breakdown aggregate must be 3824's: the in-app share by payment mode, pg_temp last");
    });

    test("M2. re-applying is a no-op that still passes its own postconditions", () => {
      const again = applyOnClone(FORWARD);
      assert.equal(again.ok, true, again.stderr);
      assert.equal(fnCount(), 10);
      assert.deepEqual(round2(), [1, 1, 1, 1]);
      assert.deepEqual(summaryFn(), BY_MODE);
    });

    test("M2b. re-applying does NOT turn an operator's deposit switch back off", () => {
      exec(SWITCH_ON);
      const again = applyOnClone(FORWARD);
      assert.equal(again.ok, true, again.stderr);
      assert.equal(switchValue(), "t", "a re-run of the migration changed a value an operator set");
    });

    test("M7. the rollback REFUSES, changing nothing, while the deposit switch is ON", () => {
      // (left ON by M2b) Rolling back would drop the function that reads the
      // switch and leave an operator's decision pointing at nothing.
      const back = applyOnClone(ROLLBACK);
      assert.equal(back.ok, false);
      assert.match(back.stderr, /ROLLBACK REFUSED \(3824\).*rent_buddy_global_controls\.deposits_enabled is ON/);
      assert.equal(fnCount(), 10, "a refused rollback must change nothing");
      assert.deepEqual(round2(), [1, 1, 1, 1]);
      assert.deepEqual(summaryFn(), BY_MODE, "a refused rollback must not have put 3530's body back either");
      exec(SWITCH_OFF);
    });

    test("M3. the rollback removes exactly what 3824 added and restores 2901's vocabulary", () => {
      const back = applyOnClone(ROLLBACK);
      assert.equal(back.ok, true, back.stderr);
      assert.equal(fnCount(), 0);
      assert.deepEqual(round2(), [0, 0, 0, 0], "the rollback left a round-2 object behind");
      // The breakdown aggregate is NOT dropped (2330 created it, 3530 owns it):
      // it goes back to 3530's body — still reporting nothing as collected.
      assert.deepEqual(summaryFn(), AS_3530, "the rollback must restore 3530's definition of rb_buddy_earnings_summary");
      const empty = JSON.parse(scalar(`SELECT public.rb_buddy_earnings_summary('00000000-0000-0000-0000-000000000000'::uuid, 0.15)::text`)!);
      assert.deepEqual([Number(empty.totalInAppUsd), "totalInAppScheduledUsd" in empty], [0, true], "after the rollback the aggregate must still be #610's, not 2330's");
      assert.deepEqual(
        rows<{ svc: boolean; anon: boolean; authed: boolean; pub: boolean }>(
          `SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
             FROM pg_proc p WHERE p.oid = 'public.rb_buddy_earnings_summary(uuid, numeric)'::regprocedure`)[0],
        { svc: true, anon: false, authed: false, pub: false }, "the rollback changed who may run the aggregate");
      assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.rent_buddy_bookings'::regclass AND tgname = 'rbb_reverse_ledger_on_unfulfilled'`), "0");
      assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='rent_buddy_launch_controls' AND column_name='platform_fee_percent'`), "0");
      assert.doesNotMatch(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rbee_entry_reason_check'`)!, /settlement/);
      // 2901's financial-control boundary was never touched, in either direction.
      assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND pg_get_constraintdef(oid) LIKE '%cash_settled_minor = 0%'`), "1");
    });

    test("M4. it re-applies after the rollback", () => {
      const forward = applyOnClone(FORWARD);
      assert.equal(forward.ok, true, forward.stderr);
      assert.equal(fnCount(), 10);
      assert.deepEqual(round2(), [1, 1, 1, 1]);
      assert.deepEqual(summaryFn(), BY_MODE);
    });

    test("M8. 3824 never rewrites the comment on rent_buddy_bookings — 3820 keeps its rollback record there", () => {
      // 3820_rent_buddy_bookings_write_boundary.sql (main, #596) records what it
      // revoked in the TABLE comment, and its rollback reads it back. 3824 adds a
      // column, an index and two triggers to that table; it must comment on the
      // COLUMN only. Apply, rollback and re-apply all leave the table comment as
      // they found it.
      const comment = () => scalar(`SELECT md5(COALESCE(obj_description('public.rent_buddy_bookings'::regclass), '<none>'))`);
      const had3820 = scalar(`SELECT (COALESCE(obj_description('public.rent_buddy_bookings'::regclass), '') ~ '3820')::text`);
      const before = comment();
      assert.equal(applyOnClone(FORWARD).ok, true);
      assert.equal(comment(), before, "re-applying 3824 changed the table comment");
      assert.equal(applyOnClone(ROLLBACK).ok, true);
      assert.equal(comment(), before, "rolling 3824 back changed the table comment");
      assert.equal(applyOnClone(FORWARD).ok, true);
      assert.equal(comment(), before, "re-applying 3824 after its rollback changed the table comment");
      // Said rather than assumed: on a harness whose chain includes 3820 the
      // record is really there (CI's does; the assertion is skipped only where
      // 3820 was not applied, and says so).
      if (had3820 !== "true") console.warn("M8: this database's rent_buddy_bookings comment carries no 3820 record (3820 not applied here); the unchanged-comment assertions still ran.");
      assert.doesNotMatch(sqlFile(FORWARD), /COMMENT ON TABLE public\.rent_buddy_bookings\b/, "3824 comments on the bookings TABLE");
      assert.doesNotMatch(sqlFile(ROLLBACK), /COMMENT ON TABLE public\.rent_buddy_bookings\b/, "3824's rollback comments on the bookings TABLE");
    });

    test("M5. the rollback REFUSES, changing nothing, while a commission override exists", () => {
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, NULL, NULL, 9);`);
      const back = applyOnClone(ROLLBACK);
      assert.equal(back.ok, false);
      assert.match(back.stderr, /ROLLBACK REFUSED \(3824\).*commission override/);
      assert.equal(fnCount(), 10, "a refused rollback must change nothing");
      exec(`DELETE FROM public.rent_buddy_launch_controls WHERE country_code = ${q(MARKET)};`);
    });

    test("M6. the rollback REFUSES, changing nothing, while a settlement entry exists", () => {
      // The clone carries this suite's seed rows (it was cloned after `before`).
      const bk = scalar(
        `INSERT INTO public.rent_buddy_bookings (buddy_id, traveler_id, booking_date, duration_h, city, category, status, total_usd, deposit_usd, country_code)
         VALUES (${q(w.buddyProfile)}, ${q(w.traveller)}, current_date, 1, 'Payd City', 'city', 'completed', 10, 10, ${q(MARKET)}) RETURNING id`,
      )!;
      assert.equal(post(bk, "booking_created").ok, true);
      assert.equal(post(bk, "settlement", "m6", { provider: "scripted", external_ref: "cap_m6", amount_minor: 1000 }).ok, true);
      const back = applyOnClone(ROLLBACK);
      assert.equal(back.ok, false);
      assert.match(back.stderr, /ROLLBACK REFUSED \(3824\).*settlement/);
      assert.equal(fnCount(), 10, "a refused rollback must change nothing");
      assert.match(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rbee_entry_reason_check'`)!, /settlement/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // N — main's 3530 (#610) and 3824, together, on the clone
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // #610's guarantee: no aggregate reports money as collected while the ledger
  // says 0 — on four surfaces. 3824's: the summary is the fold of the entries,
  // unledgered completed bookings are counted, and no deposit is stored.
  //
  // The two meet in the DATA. 3530 reads the "scheduled" amount from
  // `deposit_usd` and builds the net on it; 3824 stores `deposit_usd = 0`. So
  // the bookings here are of BOTH kinds — the shape #610's own fixtures have
  // (deposit = the in-app share) and the shape 3824 creates (deposit = 0) — and
  // every figure is asserted over the mix.
  //
  //   old   full_in_app        500   deposit 500   cash   0
  //   old   full_in_app        400   deposit 400   cash   0
  //   old   deposit_plus_cash  500   deposit 150   cash 350
  //   new   full_in_app        600   deposit   0   cash   0     ← terms from rb_quote_booking
  //   new   deposit_plus_cash  200   deposit   0   cash 200     ← terms from rb_quote_booking
  //                           ────           ────        ────
  //   gross                   2200   stored  1050   cash 550    in-app share 500+400+150+600+0 = 1650
  //   commission 25 % (this buddy's schedule row) = 550;  net = 1650 + 550 − 550 = 1650 = gross − commission
  describe("N — 3530 (#610: nothing collected) then 3824: both guarantees hold over the same rows", () => {
    const FEE = 0.25;
    let buddy: { user: string; profile: string };
    let newFull = "";
    const ids: string[] = [];
    const summary = (profile = buddy.profile) =>
      JSON.parse(asService(`SELECT public.rb_buddy_earnings_summary(${q(profile)}, ${FEE})::text;`).join("\n"));
    const num = (o: any, keys: string[]) => keys.map((k) => Number(o[k]));
    const insertBooking = (o: { total: number; mode: string; deposit: number; cash: number }) => {
      const id = scalar(
        `INSERT INTO public.rent_buddy_bookings
           (buddy_id, traveler_id, booking_date, duration_h, city, category, status, payment_mode, total_usd, deposit_usd, cash_balance_usd, country_code)
         VALUES (${q(buddy.profile)}, ${q(w.traveller)}, current_date, 2, 'Payd City', 'city', 'requested', ${q(o.mode)}, ${o.total}, ${o.deposit}, ${o.cash}, ${q(MARKET)})
         RETURNING id`,
      )!;
      ids.push(id);
      return id;
    };
    /** A booking with the terms 3824 itself decides (rb_quote_booking), as every creation path now stores them. */
    const insertQuoted = (total: number, mode: string) => {
      const quoted = quote(buddy.profile, { price: total, qty: 1, mode });
      assert.deepEqual([quoted.ok, quoted.deposit_enabled, quoted.deposit_usd], [true, false, 0], `the quote for a ${mode} booking must carry no deposit`);
      return insertBooking({ total, mode, deposit: quoted.deposit_usd, cash: quoted.cash_balance_usd });
    };
    const applyHere = (rel: string) => { const r = psql(sqlFile(rel)); return { ok: r.status === 0, stderr: r.stderr }; };
    const installedByMode = () => scalar(`SELECT (pg_get_functiondef('public.rb_buddy_earnings_summary(uuid, numeric)'::regprocedure) ~ 'payment_mode')::text`);

    before(() => {
      useDatabase(urlFor(CLONE));
      // The order the chain applies them in, done here explicitly: 3530, then 3824.
      const a = applyHere(M3530);
      assert.equal(a.ok, true, a.stderr);
      assert.equal(installedByMode(), "false", "3530 must install ITS body (deposit_usd) — otherwise this group is not exercising the order it names");
      const b = applyHere(FORWARD);
      assert.equal(b.ok, true, b.stderr);
      assert.equal(installedByMode(), "true");

      buddy = seedBuddy("payd_n610", LEVEL_25);
      insertBooking({ total: 500, mode: "full_in_app", deposit: 500, cash: 0 });
      insertBooking({ total: 400, mode: "full_in_app", deposit: 400, cash: 0 });
      insertBooking({ total: 500, mode: "deposit_plus_cash", deposit: 150, cash: 350 });
      newFull = insertQuoted(600, "full_in_app");
      insertQuoted(200, "deposit_plus_cash");
      for (const id of ids) {
        assert.equal(post(id, "booking_created").ok, true, id);   // the WRITER, for every booking
        setStatus(id, "completed");
      }
    });
    after(() => {
      // The clone is dropped by the outer `after`; only the connection is reset.
      useDatabase(null);
    });

    test("N1. what 3824 stores for a booking made while no deposit is taken: deposit 0 in both modes", () => {
      const stored = rows<{ payment_mode: string; total: number; deposit: number; cash: number }>(
        `SELECT payment_mode::text AS payment_mode, total_usd::float8 AS total, deposit_usd::float8 AS deposit, cash_balance_usd::float8 AS cash
           FROM public.rent_buddy_bookings WHERE buddy_id = ${q(buddy.profile)} ORDER BY total_usd, payment_mode`);
      assert.deepEqual(stored, [
        { payment_mode: "deposit_plus_cash", total: 200, deposit: 0, cash: 200 },
        { payment_mode: "full_in_app", total: 400, deposit: 400, cash: 0 },
        { payment_mode: "deposit_plus_cash", total: 500, deposit: 150, cash: 350 },
        { payment_mode: "full_in_app", total: 500, deposit: 500, cash: 0 },
        { payment_mode: "full_in_app", total: 600, deposit: 0, cash: 0 },
      ]);
    });

    test("N2. #610 S3 — rb_buddy_earnings_summary: 0 collected, in total and in every month; the scheduled amount and the net are whole", () => {
      const s = summary();
      // (1) the claim is absent
      assert.equal(Number(s.totalInAppUsd), 0);
      assert.ok(s.monthlyBreakdown.length >= 1);
      for (const m of s.monthlyBreakdown) assert.equal(Number(m.inApp), 0, `month ${m.month} reports money in app`);
      // (2) the rows were read: the scheduled amount is the in-app share of all five
      assert.deepEqual(num(s, ["totalInAppScheduledUsd", "totalCashConfirmedUsd", "totalPlatformFeesUsd", "totalDisputedUsd"]), [1650, 550, 550, 0]);
      assert.equal(s.monthlyBreakdown.reduce((n: number, m: any) => n + Number(m.bookingCount), 0), 5);
      assert.equal(s.monthlyBreakdown.reduce((n: number, m: any) => n + Number(m.inAppScheduled), 0), 1650);
      // (3) the net is what the buddy is owed: gross − commission, and not negative
      assert.equal(Number(s.totalNetUsd), 1650);
      assert.equal(s.monthlyBreakdown.reduce((n: number, m: any) => n + Number(m.totalUsd), 0), 1650, "the months must add up to the net");
    });

    test("N3. #610 S2 — the route's re-statement leaves 3824's answer alone, and the JavaScript definition of the in-app share agrees with the SQL one row for row", () => {
      const s = summary();
      const restated = withNothingCollected(s);
      assert.deepEqual(num(restated, ["totalInAppUsd", "totalInAppScheduledUsd", "totalNetUsd"]), [0, 1650, 1650]);
      assert.deepEqual(restated.monthlyBreakdown.map((m: any) => [Number(m.inApp), Number(m.inAppScheduled)]),
        s.monthlyBreakdown.map((m: any) => [0, Number(m.inAppScheduled)]));

      // The pagination path folds rows with lib/rentBuddyCollectedMoney.ts
      // #scheduledInAppUsd. Over the rows as PostgREST would hand them over:
      const bookingRows = rows<any>(
        `SELECT id, total_usd::float8 AS total_usd, deposit_usd::float8 AS deposit_usd, cash_balance_usd::float8 AS cash_balance_usd, payment_mode::text AS payment_mode, status::text AS status
           FROM public.rent_buddy_bookings WHERE buddy_id = ${q(buddy.profile)} AND status::text IN ('completed', 'disputed')`);
      assert.equal(bookingRows.length, 5);
      const jsScheduled = bookingRows.reduce((n, r) => n + scheduledInAppUsd(r), 0);
      const jsCash = bookingRows.reduce((n, r) => n + Number(r.cash_balance_usd), 0);
      const jsFees = bookingRows.reduce((n, r) => n + Math.round(Number(r.total_usd) * FEE * 100) / 100, 0);
      assert.deepEqual([jsScheduled, jsCash, jsFees, jsScheduled + jsCash - jsFees],
        num(s, ["totalInAppScheduledUsd", "totalCashConfirmedUsd", "totalPlatformFeesUsd", "totalNetUsd"]),
        "the two paths of the breakdown would answer differently");
      assert.equal(collectedInAppUsd(jsScheduled), Number(s.totalInAppUsd));
    });

    test("N4. #610 S1 — the buddy's own summary: the fold reports 0 collected, the stored deposits by their honest name, and it agrees with the rows the WRITER wrote", async () => {
      const totals = await readBuddyLedgerTotals(rpcClient(), buddy.user);
      assert.equal(totals.status, "ok", JSON.stringify(totals));
      if (totals.status !== "ok") return;
      const t = totals.totals;
      // (1) nothing collected — the fold's reading and the module's are the same number
      assert.equal(t.inAppAmountCollectedUsd, 0);
      assert.equal(collectedInAppUsd(t.depositScheduledUsd), t.inAppAmountCollectedUsd);
      // (2) the rows were read
      assert.deepEqual([t.completedCount, t.unledgeredCompletedCount, t.completedTotalUsd, t.depositScheduledUsd], [5, 0, 2200, 1050]);
      // (3) the estimate is the fold of the entries: 25 % of each booking, rounded once each
      assert.deepEqual([t.ledgeredGrossUsd, t.estimatedPlatformFeeUsd, t.estimatedBuddyEarningsUsd], [2200, 550, 1650]);
      assert.deepEqual([t.cashBalanceDueUsd, t.isEstimated], [550, true]);

      // The cross-surface invariant #610 is about, on real rows: what the
      // ledger writer recorded for the same five bookings.
      const written = rows<{ collected: number; scheduled: number; n: number }>(
        `SELECT COALESCE(SUM(in_app_amount_collected), 0)::float8 AS collected, COALESCE(SUM(deposit_amount), 0)::float8 AS scheduled, count(*)::int AS n
           FROM public.rent_buddy_earnings_ledger WHERE booking_id IN (${ids.map(q).join(",")})`)[0]!;
      assert.deepEqual(written, { collected: 0, scheduled: 1050, n: 5 });
      assert.equal(t.inAppAmountCollectedUsd, written.collected, "the dashboard and the ledger disagree about the same bookings");
      assert.equal(t.depositScheduledUsd, written.scheduled);
      for (const id of ids) assertSummaryIsFold(id, `N4 ${id}`);
    });

    test("N5. #610 S4 — the operator figure over the same rows: booked value 1650 in app, 0 collected", () => {
      // The route (GET /admin/marketplace/analytics) is driven over the wire by
      // rentBuddyCollectedMoney.test.ts S4; what it computes per row is this
      // function, and these are the rows.
      const bookingRows = rows<any>(
        `SELECT total_usd::float8 AS total_usd, deposit_usd::float8 AS deposit_usd, payment_mode::text AS payment_mode
           FROM public.rent_buddy_bookings WHERE buddy_id = ${q(buddy.profile)}`);
      const inAppScheduled = bookingRows.reduce((n, r) => n + scheduledInAppUsd(r), 0);
      const depositBooked = bookingRows.reduce((n, r) => n + Number(r.deposit_usd), 0);
      assert.deepEqual([inAppScheduled, collectedInAppUsd(inAppScheduled), depositBooked, collectedInAppUsd(depositBooked)], [1650, 0, 1050, 0]);
    });

    test("N6. a disputed booking still counts as disputed and adds nothing to the scheduled amount or the net (3530's rule, kept)", () => {
      const solo = seedBuddy("payd_n610_d", LEVEL_25);
      exec(
        `INSERT INTO public.rent_buddy_bookings (buddy_id, traveler_id, booking_date, duration_h, city, category, status, payment_mode, total_usd, deposit_usd, cash_balance_usd, country_code)
         VALUES (${q(solo.profile)}, ${q(w.traveller)}, current_date, 2, 'Payd City', 'city', 'disputed', 'full_in_app', 300, 0, 0, ${q(MARKET)}),
                (${q(solo.profile)}, ${q(w.traveller)}, current_date, 2, 'Payd City', 'city', 'completed', 'full_in_app', 100, 0, 0, ${q(MARKET)});`);
      const s = summary(solo.profile);
      assert.deepEqual(num(s, ["totalInAppUsd", "totalInAppScheduledUsd", "totalDisputedUsd", "totalPlatformFeesUsd", "totalNetUsd"]), [0, 100, 300, 25, 75]);
    });

    test("N7. ORDER MATTERS: 3530 applied AFTER 3824 brings the negative net back for a no-deposit full_in_app booking — and re-applying 3824 repairs it", () => {
      // The reason 3824 re-states the function instead of leaving 3530's alone,
      // shown rather than argued. One buddy, one booking: full_in_app, 600,
      // stored by 3824 with no deposit.
      const solo = seedBuddy("payd_n610_o", LEVEL_25);
      exec(
        `INSERT INTO public.rent_buddy_bookings (buddy_id, traveler_id, booking_date, duration_h, city, category, status, payment_mode, total_usd, deposit_usd, cash_balance_usd, country_code)
         SELECT ${q(solo.profile)}, traveler_id, booking_date, duration_h, city, category, 'completed', payment_mode, total_usd, deposit_usd, cash_balance_usd, country_code
           FROM public.rent_buddy_bookings WHERE id = ${q(newFull)};`);
      assert.deepEqual(num(summary(solo.profile), ["totalInAppUsd", "totalInAppScheduledUsd", "totalNetUsd"]), [0, 600, 450]);

      const late = applyHere(M3530);
      assert.equal(late.ok, true, late.stderr);
      assert.equal(installedByMode(), "false");
      const under3530 = summary(solo.profile);
      // #610's guarantee holds under its own body…
      assert.equal(Number(under3530.totalInAppUsd), 0);
      // …and the buddy is told they OWE Portava the commission.
      assert.deepEqual(num(under3530, ["totalInAppScheduledUsd", "totalNetUsd"]), [0, -150]);

      const repaired = applyHere(FORWARD);
      assert.equal(repaired.ok, true, repaired.stderr);
      assert.equal(installedByMode(), "true");
      assert.deepEqual(num(summary(solo.profile), ["totalInAppUsd", "totalInAppScheduledUsd", "totalNetUsd"]), [0, 600, 450]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // G — grants
  // ═══════════════════════════════════════════════════════════════════════════
  describe("G — SECURITY DEFINER, pinned search_path, EXECUTE for service_role only", () => {
    const FNS = [
      "public.rb_post_booking_ledger(uuid, text, text, jsonb)",
      "public.rb_resolve_platform_fee_percent(text, text, text, text)",
      "public.rb_buddy_ledger_totals(uuid)",
      "public.rb_admin_payout_transition(uuid, text, uuid, text)",
      "public.rb_quote_booking(uuid, text, numeric, numeric, text, integer)",
    ];
    /** Called only by the functions above, or by a trigger: executable by NO role. */
    const INTERNAL = [
      "public.rb_booking_market(uuid)",
      "public.rb_platform_fee_minor(bigint, integer)",
      "public.rb_booking_payment_terms(bigint, text, integer)",
      "public.rb_booking_ledger_on_unfulfilled()",
      "public.rb_booking_refuse_uncancel()",
    ];
    test("G1. every callable function: definer, search_path pinned, service_role yes, anon/authenticated/PUBLIC no", () => {
      for (const fn of FNS) {
        const r = rows<{ secdef: boolean; pinned: boolean; svc: boolean; anon: boolean; authed: boolean; pub: boolean }>(
          `SELECT p.prosecdef AS secdef,
                  EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\\_path=%') AS pinned,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS pub
             FROM pg_proc p WHERE p.oid = ${q(fn)}::regprocedure`,
        )[0]!;
        assert.deepEqual(r, { secdef: true, pinned: true, svc: true, anon: false, authed: false, pub: false }, fn);
      }
    });

    // `SET search_path = public` leaves pg_temp searched FIRST for relations, so a
    // session's temporary table of the same name shadowed the real one. Every
    // function now names the order explicitly, with pg_temp last.
    test("G3. every function 3824 defines pins search_path to exactly pg_catalog, public, pg_temp; the internal ones are executable by no role", () => {
      for (const fn of [...FNS, ...INTERNAL]) {
        const cfg = scalar(`SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = ${q(fn)}::regprocedure`)!;
        assert.equal(cfg.replace(/\s+/g, ""), "search_path=pg_catalog,public,pg_temp", fn);
        assert.equal(scalar(`SELECT prosecdef FROM pg_proc WHERE oid = ${q(fn)}::regprocedure`), "t", fn);
      }
      for (const fn of INTERNAL) {
        const r = rows<{ svc: boolean; anon: boolean; authed: boolean; pub: boolean }>(
          `SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
             FROM pg_proc p WHERE p.oid = ${q(fn)}::regprocedure`,
        )[0]!;
        assert.deepEqual(r, { svc: false, anon: false, authed: false, pub: false }, fn);
      }
    });

    test("G4. a TEMPORARY table named like a real one does not change a price, a rate or the deposit switch", () => {
      // The regression: a temp `rent_buddy_fee_rules` made the resolver return 0 %.
      const bk = seedBooking({ buddyProfile: w.buddy25Profile, total: 80 });
      const out = asService(
        `CREATE TEMP TABLE rent_buddy_fee_rules (buddy_level text, platform_fee_percent integer, traveler_service_fee_usd numeric, traveler_service_fee_pct numeric);\n` +
        `INSERT INTO rent_buddy_fee_rules VALUES (${q(LEVEL_25)}, 0, 0, 0);\n` +
        `CREATE TEMP TABLE rent_buddy_global_controls (id integer, deposits_enabled boolean);\n` +
        `INSERT INTO rent_buddy_global_controls VALUES (1, true);\n` +
        `CREATE TEMP TABLE rent_buddy_launch_controls (id uuid DEFAULT gen_random_uuid(), country_code text, city text, category text, platform_fee_percent integer, updated_at timestamptz DEFAULT now());\n` +
        `INSERT INTO rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (NULL, NULL, NULL, 1);\n` +
        // The shadow is real: an unqualified name in THIS session resolves to the temp table.
        `SELECT (SELECT platform_fee_percent FROM rent_buddy_fee_rules WHERE buddy_level = ${q(LEVEL_25)})::text;\n` +
        `SELECT public.rb_quote_booking(${q(w.buddy25Profile)}, 'city', 100, 1, 'deposit_plus_cash', NULL)::text;\n` +
        `SELECT public.rb_post_booking_ledger(${q(bk)}, 'booking_created')::text;`,
      );
      assert.equal(out[0], "0", "the temp table does not shadow the real one in this session — the test proves nothing");
      const quoted = JSON.parse(out[1]!);
      assert.deepEqual([quoted.ok, quoted.fee_percent, quoted.fee_source, quoted.fee_usd, quoted.deposit_enabled, quoted.deposit_usd],
        [true, 25, "fee_schedule", 25, false, 0], "a temporary table changed the quote");
      const posted = JSON.parse(out[2]!);
      assert.deepEqual([posted.ok, posted.fee_percent], [true, 25], "a temporary table changed the rate a booking was ledgered at");
      assert.equal(summaryOf(bk)!.platform_fee_amount, 20);
    });

    test("G5. rb_buddy_earnings_summary as 3824 re-states it: definer, service_role only, pinned to public with pg_temp LAST, and a temporary rent_buddy_bookings changes nothing", () => {
      const fn = "public.rb_buddy_earnings_summary(uuid, numeric)";
      const r = rows<{ secdef: boolean; cfg: string; svc: boolean; anon: boolean; authed: boolean; pub: boolean }>(
        `SELECT p.prosecdef AS secdef, array_to_string(p.proconfig, '|') AS cfg,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
           FROM pg_proc p WHERE p.oid = ${q(fn)}::regprocedure`,
      )[0]!;
      // 3530 pinned `public` alone, which leaves pg_temp searched FIRST for
      // relations. 3824 keeps 3530's pin and spells pg_temp out last: the same
      // effective order as the ten functions in G3 (pg_catalog is implicit).
      assert.deepEqual({ ...r, cfg: r.cfg.replace(/[\s"]+/g, "") },
        { secdef: true, cfg: "search_path=public,pg_temp", svc: true, anon: false, authed: false, pub: false });

      const solo = seedBuddy("payd_g5", "new");
      const bk = seedBooking({ buddyProfile: solo.profile, total: 120, status: "completed", cash: 0 });
      assert.ok(bk);
      const honest = asService(`SELECT public.rb_buddy_earnings_summary(${q(solo.profile)}, 0.25)::text;`).join("\n");
      const out = asService(
        `CREATE TEMP TABLE rent_buddy_bookings (id uuid DEFAULT gen_random_uuid(), buddy_id uuid, status text, payment_mode text, total_usd numeric, deposit_usd numeric, cash_balance_usd numeric, completed_at timestamptz, booking_date date);\n` +
        `INSERT INTO rent_buddy_bookings (buddy_id, status, payment_mode, total_usd, deposit_usd, cash_balance_usd, booking_date) VALUES (${q(solo.profile)}, 'completed', 'full_in_app', 99999, 99999, 0, current_date);\n` +
        // The shadow is real: an unqualified name in THIS session resolves to the temp table.
        `SELECT (SELECT max(total_usd) FROM rent_buddy_bookings WHERE buddy_id = ${q(solo.profile)})::text;\n` +
        `SELECT public.rb_buddy_earnings_summary(${q(solo.profile)}, 0.25)::text;`,
      );
      assert.equal(out[0], "99999", "the temp table does not shadow the real one in this session — the test proves nothing");
      assert.equal(out[1], honest, "a temporary rent_buddy_bookings changed the earnings breakdown");
      assert.deepEqual([Number(JSON.parse(honest).totalInAppScheduledUsd), Number(JSON.parse(honest).totalNetUsd)], [120, 90]);
    });

    test("G2. a signed-in client cannot call the posting function, and nothing is written", () => {
      const bk = seedBooking({ total: 20 });
      const r = psql(
        `SET LOCAL ROLE authenticated;\nSELECT public.rb_post_booking_ledger(${q(bk)}, 'booking_created');`,
        { single: true },
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied for function rb_post_booking_ledger/);
      assert.equal(entriesOf(bk).length, 0);
      assert.equal(summaryOf(bk), null);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // C — booking_created
  // ═══════════════════════════════════════════════════════════════════════════
  describe("C — booking_created: entries and summary together, priced in SQL", () => {
    let bk: string;

    test("C1. one call writes the booking's entries AND its summary, at the owner default of 10 %", () => {
      bk = seedBooking({ total: 123.45, deposit: 123.45 });
      assert.equal(entriesOf(bk).length, 0);
      assert.equal(summaryOf(bk), null);

      const r = post(bk, "booking_created");
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.replayed, false);
      assert.equal(r.entries_appended, 4);
      assert.equal(r.fee_percent, 10);
      assert.equal(r.fee_source, "owner_default", "the harness has no fee row for level 'new' and no override");

      const e = entriesOf(bk);
      assert.deepEqual(
        e.map((x) => [x.entry_reason, x.account, x.amount_minor]).sort(),
        [
          ["booking_gross", "buddy_payable", 12345],
          ["booking_gross", "traveler_receivable", -12345],
          ["platform_fee", "buddy_payable", -1235],     // round(12345 × 10 / 100) = 1234.5 → 1235
          ["platform_fee", "platform_revenue", 1235],
        ].sort(),
      );
      for (const x of e) {
        assert.equal(x.currency, "USD");
        assert.equal(x.rule_version, RULE_V2);
        assert.equal(x.attribution_kind, "booking");
        assert.equal(x.attribution_id, bk);
        assert.equal(x.provider, "none", "no processor is installed (09 §1.1)");
        assert.equal(x.external_ref, null);
        assert.equal(x.cash_settled_minor, 0);
        assert.equal(x.reverses_entry_id, null);
        assert.equal(x.beneficiary_user_id, x.account === "buddy_payable" ? w.buddyUser : null);
      }

      const s = summaryOf(bk)!;
      assert.equal(s.buddy_user_id, w.buddyUser, "the payee is derived from the booking, never passed in");
      assert.equal(s.traveler_id, w.traveller);
      assert.equal(s.platform_fee_percent, 10);
      assert.equal(s.total_booking_usd, 123.45);
      assert.equal(s.platform_fee_amount, 12.35);
      assert.equal(s.buddy_net_estimated_amount, 111.1);
      assert.equal(s.traveler_service_fee_amount, 0, "the traveller-side fee is not booked: the ruling names one fee");
      assertSummaryIsFold(bk, "C1");
    });

    test("C2. every transaction balances, and NOTHING is collected — even for a full-in-app booking", () => {
      assert.equal(unbalancedTransactions(bk), 0);
      const s = summaryOf(bk)!;
      // deposit_usd = total_usd here (payment_mode full_in_app): the worst case
      // of 09 §1.3.1, where the old row recorded the whole booking as collected.
      assert.equal(s.deposit_amount, 123.45, "the in-app share the booking names is a term, copied as before");
      assert.equal(s.in_app_amount_collected, 0, "pay-deposit / pay-full answer 503; nothing was collected");
      assert.equal(s.is_estimated, true);
      assert.equal(s.cash_balance_confirmed, false);
      assert.equal(entriesOf(bk).filter((x) => x.entry_reason === "settlement").length, 0);
    });

    test("C3. the SQL writes exactly what the pure TypeScript model builds — entry for entry, key for key", () => {
      const s = summaryOf(bk)!;
      const model = buildBookingEntries({
        bookingId: bk, beneficiaryUserId: w.buddyUser, ruleVersion: RULE_V2,
        totalUsd: 123.45, tipUsd: 0, platformFeeUsd: s.platform_fee_amount, travelerServiceFeeUsd: 0, collectedMinor: 0,
      });
      assert.equal(model.status, "built");
      if (model.status !== "built") return;
      const shape = (x: { transactionKey: string; idempotencyKey: string; account: string; entryReason: string; amountMinor: number; beneficiaryUserId: string | null }) =>
        `${x.idempotencyKey}|${x.transactionKey}|${x.account}|${x.entryReason}|${x.amountMinor}|${x.beneficiaryUserId}`;
      assert.deepEqual(
        entriesOf(bk).map((x) => shape({
          transactionKey: x.transaction_key, idempotencyKey: x.idempotency_key, account: x.account,
          entryReason: x.entry_reason, amountMinor: x.amount_minor, beneficiaryUserId: x.beneficiary_user_id,
        })).sort(),
        model.entries.map(shape).sort(),
      );
    });

    test("C4. a replay appends nothing and leaves every row as it was", () => {
      const before_ = JSON.stringify([entriesOf(bk), summaryOf(bk)]);
      const r = post(bk, "booking_created");
      assert.equal(r.ok, true);
      assert.equal(r.replayed, true);
      assert.equal(r.entries_appended, 0);
      assert.equal(JSON.stringify([entriesOf(bk), summaryOf(bk)]), before_);
    });

    test("C5. eight concurrent calls for one booking land exactly one set of entries", async () => {
      const b = seedBooking({ total: 60 });
      const script = `SET LOCAL ROLE service_role;\nSELECT public.rb_post_booking_ledger(${q(b)}, 'booking_created')::text;`;
      const results = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(script)));
      for (const r of results) assert.equal(r.status, 0, r.stderr);
      const parsed = results.map((r) => JSON.parse(r.stdout.trim()));
      assert.equal(parsed.filter((p) => p.ok && p.replayed === false).length, 1, "exactly one call may price the booking");
      assert.equal(parsed.filter((p) => p.ok && p.replayed === true).length, 7);
      assert.equal(entriesOf(b).length, 4);
      assert.equal(Number(scalar(`SELECT count(*) FROM public.rent_buddy_earnings_ledger WHERE booking_id = ${q(b)}`)), 1);
      assertSummaryIsFold(b, "C5");
    });

    test("C6. the commission is CONFIGURATION: fee schedule for the level, then a market/product override", () => {
      // The existing schedule row applies while it exists — 3824 does not rewrite it.
      const viaSchedule = seedBooking({ buddyProfile: w.buddy25Profile, total: 80 });
      const r1 = post(viaSchedule, "booking_created");
      assert.deepEqual([r1.fee_percent, r1.fee_source], [25, "fee_schedule"]);
      assert.equal(summaryOf(viaSchedule)!.platform_fee_amount, 20);
      assert.equal(summaryOf(viaSchedule)!.traveler_service_fee_amount, 0,
        "the schedule row carries traveler_service_fee_pct = 5 and the posting function does not book it");
      assertSummaryIsFold(viaSchedule, "C6 schedule");

      // A country-wide override beats the schedule…
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, NULL, NULL, 8);`);
      const viaCountry = seedBooking({ buddyProfile: w.buddy25Profile, total: 80 });
      const r2 = post(viaCountry, "booking_created");
      assert.deepEqual([r2.fee_percent, r2.fee_source], [8, "launch_control"]);
      assert.equal(summaryOf(viaCountry)!.platform_fee_amount, 6.4);

      // …a more specific one (country + category) beats the country-wide one…
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, NULL, 'nightlife', 12);`);
      const viaCategory = seedBooking({ buddyProfile: w.buddy25Profile, total: 80, category: "nightlife" });
      assert.deepEqual([post(viaCategory, "booking_created").fee_percent, summaryOf(viaCategory)!.platform_fee_amount], [12, 9.6]);

      // …and a more specific control that sets NO rate does not hide a broader one.
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, 'Payd City', 'food', NULL);`);
      const viaNullSpecific = seedBooking({ buddyProfile: w.buddy25Profile, total: 80, category: "food" });
      assert.deepEqual([post(viaNullSpecific, "booking_created").fee_percent, post(viaNullSpecific, "booking_created").replayed], [8, true]);

      // A booking already priced is NOT re-priced when configuration changes.
      assert.equal(summaryOf(viaSchedule)!.platform_fee_percent, 25);
      assert.equal(post(viaSchedule, "booking_created").replayed, true);
      assert.equal(summaryOf(viaSchedule)!.platform_fee_amount, 20);

      exec(`DELETE FROM public.rent_buddy_launch_controls WHERE country_code = ${q(MARKET)};`);
    });

    test("C7. arithmetic is integer minor units, rounded once, half away from zero", () => {
      for (const [total, feeMinor] of [[10.05, 101], [0.05, 1], [0.04, 0], [99.99, 1000], [1000, 10000]] as const) {
        const b = seedBooking({ total });
        assert.equal(post(b, "booking_created").ok, true);
        const f = fold(entriesOf(b));
        assert.equal(f.fee, feeMinor, `10 % of ${total}`);
        assert.equal(f.net, Math.round(total * 100) - feeMinor, "net is what the entries sum to — no second subtraction");
        assertSummaryIsFold(b, `C7 ${total}`);
      }
    });

    test("C8. a fee-schedule row outside 0..100 REFUSES the booking's ledger; nothing is written", () => {
      const b = seedBooking({ buddyProfile: w.buddyBadProfile, total: 50 });
      const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\nSELECT public.rb_post_booking_ledger(${q(b)}, 'booking_created');`, { single: true });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /22023/);
      assert.match(r.stderr, /fee_config_invalid/);
      assert.equal(entriesOf(b).length, 0);
      assert.equal(summaryOf(b), null, "a booking is not priced at the default while an operator's row says otherwise");
    });

    test("C9. refusals are returned by name and write nothing", () => {
      assert.deepEqual(
        [post(randomUUID(), "booking_created").refusal, post(bk, "refund").refusal],
        ["booking_not_found", "unknown_event"],
      );
      const cancelled = seedBooking({ total: 40, status: "cancelled_by_traveler" });
      const r = post(cancelled, "booking_created");
      assert.deepEqual([r.ok, r.refusal], [false, "booking_not_ledgerable"]);
      assert.equal(entriesOf(cancelled).length, 0);
      assert.equal(summaryOf(cancelled), null);

      // A negative total is not a bookable earning. (The table has no CHECK
      // that would stop one reaching the function, so the function refuses.)
      const negative = seedBooking({ total: -5 });
      const n = post(negative, "booking_created");
      assert.deepEqual([n.ok, n.refusal], [false, "invalid_total"]);
      assert.equal(entriesOf(negative).length, 0);
      assert.equal(summaryOf(negative), null);
    });

    test("C10. a booking worth nothing gets no entries (an entry of zero states nothing) and a zero summary", () => {
      const b = seedBooking({ total: 0 });
      const r = post(b, "booking_created");
      assert.deepEqual([r.ok, r.entries_appended], [true, 0]);
      assert.equal(entriesOf(b).length, 0);
      assert.deepEqual(
        [summaryOf(b)!.total_booking_usd, summaryOf(b)!.platform_fee_amount, summaryOf(b)!.buddy_net_estimated_amount],
        [0, 0, 0],
      );
    });

    test("C11. a booking the retired JavaScript writer ledgered (v1 keys) is a REPLAY — never booked twice", () => {
      const b = seedBooking({ total: 100 });
      const v1 = buildBookingEntries({
        bookingId: b, beneficiaryUserId: w.buddyUser, ruleVersion: RENT_BUDDY_FEE_RULE_VERSION,
        totalUsd: 100, tipUsd: 0, platformFeeUsd: 22, travelerServiceFeeUsd: 0, collectedMinor: 0,
      });
      assert.equal(v1.status, "built");
      if (v1.status !== "built") return;
      const cols = ["transaction_key", "booking_id", "account", "entry_reason", "amount_minor", "currency", "cash_settled_minor",
        "rule_version", "attribution_kind", "attribution_id", "beneficiary_user_id", "reverses_entry_id", "provider", "external_ref", "idempotency_key"];
      const values = v1.entries.map((e) => {
        const r = toEarningsEntryRow(e, b) as unknown as Record<string, unknown>;
        return `(${cols.map((c) => (r[c] === null ? "NULL" : typeof r[c] === "number" ? String(r[c]) : q(String(r[c])))).join(", ")})`;
      }).join(", ");
      asService(`INSERT INTO public.rent_buddy_earnings_entries (${cols.join(", ")}) VALUES ${values};`);
      assert.equal(entriesOf(b).length, 4);

      const r = post(b, "booking_created");
      assert.deepEqual([r.ok, r.replayed, r.entries_appended], [true, true, 0]);
      assert.equal(entriesOf(b).length, 4, "no v2 entries beside the v1 ones");
      // …and the replay HEALS the summary the two-statement writer could leave missing.
      assert.equal(summaryOf(b)!.platform_fee_amount, 22);
      assertSummaryIsFold(b, "C11");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // T — tips
  // ═══════════════════════════════════════════════════════════════════════════
  describe("T — a tip is one pair, carries no commission, and every copy equals the fold", () => {
    let bk: string;
    const tip = (bookingId: string, key: string, amount: number, by = w.traveller) =>
      post(bookingId, "tip", key, { traveler_id: by, amount_usd: amount, note: null });
    const tipCopies = (bookingId: string) => rows<{ tips: number | null; booking: number | null; summary: number | null }>(
      `SELECT (SELECT amount_usd::float8 FROM public.rent_buddy_tips WHERE booking_id = ${q(bookingId)}) AS tips,
              (SELECT tip_usd::float8 FROM public.rent_buddy_bookings WHERE id = ${q(bookingId)}) AS booking,
              (SELECT tip_usd::float8 FROM public.rent_buddy_earnings_ledger WHERE booking_id = ${q(bookingId)}) AS summary`,
    )[0]!;

    before(() => {
      bk = seedBooking({ total: 200, status: "completed" });
      assert.equal(post(bk, "booking_created").ok, true);
    });

    test("T1. a tip appends exactly one balanced pair, and NO platform-fee entry", () => {
      const feeBefore = entriesOf(bk).filter((e) => e.entry_reason === "platform_fee");
      const r = tip(bk, "tip-one", 15);
      assert.deepEqual([r.ok, r.replayed, r.entries_appended], [true, false, 2], JSON.stringify(r));

      const tips = entriesOf(bk).filter((e) => e.entry_reason === "tip");
      assert.deepEqual(
        tips.map((e) => [e.account, e.amount_minor, e.beneficiary_user_id]).sort(),
        [["buddy_payable", 1500, w.buddyUser], ["traveler_receivable", -1500, null]].sort(),
      );
      assert.equal(new Set(tips.map((e) => e.transaction_key)).size, 1);
      assert.equal(unbalancedTransactions(bk), 0);

      // NO COMMISSION ON TIPS (owner ruling 2026-10-04): the fee entries are the
      // two the booking already had, to the row.
      assert.deepEqual(entriesOf(bk).filter((e) => e.entry_reason === "platform_fee"), feeBefore);
      assert.equal(fold(entriesOf(bk)).fee, 2000, "10 % of the 200.00 service price, and nothing of the 15.00 tip");
      assert.equal(entriesOf(bk).filter((e) => e.account === "platform_revenue" && e.transaction_key.includes(":tip:")).length, 0);
    });

    test("T2. afterwards the summary equals the fold of the entries — and so do the tips row and the booking", () => {
      assertSummaryIsFold(bk, "T2");
      assert.deepEqual(tipCopies(bk), { tips: 15, booking: 15, summary: 15 });
      assert.equal(summaryOf(bk)!.buddy_net_estimated_amount, 200 - 20 + 15, "the buddy keeps the whole tip");
    });

    test("T3. a second tip ADDS; a replay of the first adds nothing; a reused key with another amount is refused", () => {
      assert.equal(tip(bk, "tip-two", 2.5).ok, true);
      assert.deepEqual(tipCopies(bk), { tips: 17.5, booking: 17.5, summary: 17.5 });

      const count = entriesOf(bk).length;
      const replay = tip(bk, "tip-one", 15);
      assert.deepEqual([replay.ok, replay.replayed, replay.entries_appended], [true, true, 0]);
      assert.equal(entriesOf(bk).length, count);
      assert.deepEqual(tipCopies(bk), { tips: 17.5, booking: 17.5, summary: 17.5 });

      const reused = tip(bk, "tip-one", 16);
      assert.deepEqual([reused.ok, reused.refusal], [false, "idempotency_key_reused"]);
      assert.equal(entriesOf(bk).length, count);
      assertSummaryIsFold(bk, "T3");
    });

    test("T4. twelve concurrent tips with distinct keys all land; none is lost", async () => {
      const b = seedBooking({ total: 100, status: "completed" });
      assert.equal(post(b, "booking_created").ok, true);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => psqlAsync(
        `SET LOCAL ROLE service_role;\nSELECT public.rb_post_booking_ledger(${q(b)}, 'tip', ${q(`c-${i}`)}, ${q(JSON.stringify({ traveler_id: w.traveller, amount_usd: 1 }))}::jsonb)::text;`,
      )));
      for (const r of results) assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(tipCopies(b), { tips: 12, booking: 12, summary: 12 });
      assert.equal(entriesOf(b).filter((e) => e.entry_reason === "tip").length, 24);
      assertSummaryIsFold(b, "T4");
    });

    test("T5. refusals: not the traveller, not completed, not positive, no key — and nothing is written", () => {
      const b = seedBooking({ total: 50, status: "scheduled" });
      const snapshot = () => JSON.stringify([entriesOf(bk), tipCopies(bk), entriesOf(b), tipCopies(b)]);
      const before_ = snapshot();
      assert.equal(tip(bk, "x1", 5, w.outsider).refusal, "not_traveler");
      assert.equal(tip(bk, "x2", 0).refusal, "invalid_amount");
      assert.equal(tip(bk, "x3", -4).refusal, "invalid_amount");
      assert.equal(tip(bk, "x4", 0.004).refusal, "invalid_amount");
      assert.equal(tip(b, "x5", 5).refusal, "booking_not_completed");
      assert.equal(post(bk, "tip", null, { traveler_id: w.traveller, amount_usd: 5 }).refusal, "event_key_required");
      assert.equal(post(bk, "tip", "has spaces", { traveler_id: w.traveller, amount_usd: 5 }).refusal, "event_key_required");
      assert.equal(snapshot(), before_);
      // The refused tip on the un-ledgered `scheduled` booking did not ledger it either.
      assert.equal(entriesOf(b).length, 0);
    });

    test("T6. a tip left before 3824 (in rent_buddy_tips, in no entry) is carried over once, so the fold stays whole", () => {
      const b = seedBooking({ total: 100, status: "completed" });
      assert.equal(post(b, "booking_created").ok, true);
      exec(
        `INSERT INTO public.rent_buddy_tips (booking_id, traveler_id, buddy_user_id, amount_usd) VALUES (${q(b)}, ${q(w.traveller)}, ${q(w.buddyUser)}, 3);\n` +
        `UPDATE public.rent_buddy_bookings SET tip_usd = 3 WHERE id = ${q(b)};`,
      );
      assert.equal(tip(b, "after-legacy", 2).entries_appended, 4, "the carried-over pair and the new pair");
      assert.deepEqual(tipCopies(b), { tips: 5, booking: 5, summary: 5 });
      assert.equal(tip(b, "after-legacy-2", 1).entries_appended, 2, "carried over ONCE");
      assert.deepEqual(tipCopies(b), { tips: 6, booking: 6, summary: 6 });
      assertSummaryIsFold(b, "T6");
    });

    // `carried-over` is the transaction T6's legacy tip is carried into the
    // entries under. A caller's key of the same spelling collided with it: ON
    // CONFLICT DO NOTHING dropped the NEW tip and the call still answered ok.
    test("T8. the event key `carried-over` is RESERVED: refused by name, in any case, and nothing is written", () => {
      const b = seedBooking({ total: 100, status: "completed" });
      assert.equal(post(b, "booking_created").ok, true);
      exec(
        `INSERT INTO public.rent_buddy_tips (booking_id, traveler_id, buddy_user_id, amount_usd) VALUES (${q(b)}, ${q(w.traveller)}, ${q(w.buddyUser)}, 3);\n` +
        `UPDATE public.rent_buddy_bookings SET tip_usd = 3 WHERE id = ${q(b)};`,
      );
      const before_ = JSON.stringify([entriesOf(b), tipCopies(b)]);
      for (const key of ["carried-over", "CARRIED-OVER", "Carried-Over", "  carried-over  "]) {
        const r = tip(b, key, 2);
        assert.deepEqual([r.ok, r.refusal], [false, "event_key_reserved"], key);
      }
      assert.equal(JSON.stringify([entriesOf(b), tipCopies(b)]), before_, "a refused tip wrote something");
      // The tip, sent under a key of the caller's own, is NOT dropped.
      const ok = tip(b, "mine-1", 2);
      assert.deepEqual([ok.ok, ok.entries_appended], [true, 4], "the carried-over pair and the new pair");
      assert.deepEqual(tipCopies(b), { tips: 5, booking: 5, summary: 5 });
      assertSummaryIsFold(b, "T8");
    });

    test("T9. NaN, ±Infinity and an amount at or above 10^8 are REFUSED (`invalid_amount`) — not raised as an overflow", () => {
      const snapshot = () => JSON.stringify([entriesOf(bk), tipCopies(bk)]);
      const before_ = snapshot();
      for (const amount of ["NaN", "Infinity", "-Infinity", 100000000, 1e9, 99999999.999]) {
        const out = psql(
          `SET LOCAL ROLE service_role;\nSELECT public.rb_post_booking_ledger(${q(bk)}, 'tip', ${q(`t9-${String(amount)}`.replace(/[^A-Za-z0-9_.:-]/g, "_"))}, ` +
          `${q(JSON.stringify({ traveler_id: w.traveller, amount_usd: amount, note: null }))}::jsonb)::text;`,
          { single: true },
        );
        assert.equal(out.status, 0, `${String(amount)} RAISED instead of being refused: ${out.stderr}`);
        const r = JSON.parse(out.stdout.trim().split("\n").pop()!);
        assert.deepEqual([r.ok, r.refusal], [false, "invalid_amount"], String(amount));
      }
      assert.equal(tip(bk, "t9-text", "abc" as any).refusal, "invalid_arguments");
      assert.equal(snapshot(), before_);
    });

    test("T7. a tip on a completed booking that was never ledgered ledgers it first, in the same call", () => {
      const b = seedBooking({ total: 70, status: "completed" });
      const r = tip(b, "first", 7);
      assert.deepEqual([r.ok, r.entries_appended], [true, 6], JSON.stringify(r));
      assert.equal(fold(entriesOf(b)).gross, 7000);
      assert.equal(fold(entriesOf(b)).fee, 700);
      assertSummaryIsFold(b, "T7");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R — reversal
  // ═══════════════════════════════════════════════════════════════════════════
  describe("R — an unfulfilled booking's earning entries are reversed, exactly, in the transition's own transaction", () => {
    test("R1. cancelling appends the exact negation of every earning entry; nothing is updated or deleted", () => {
      const bk = seedBooking({ buddyProfile: w.buddy25Profile, total: 80 });
      assert.equal(post(bk, "booking_created").ok, true);
      const originals = entriesOf(bk);
      assert.equal(originals.length, 4);

      setStatus(bk, "cancelled_by_traveler");   // the cancel route's write — nothing else

      const all = entriesOf(bk);
      const reversals = all.filter((e) => e.entry_reason === "reversal");
      assert.equal(reversals.length, 4);
      // The originals are byte-for-byte what they were: corrections are new rows.
      assert.deepEqual(all.filter((e) => e.entry_reason !== "reversal"), originals);
      for (const o of originals) {
        const r = reversals.find((x) => x.reverses_entry_id === o.id);
        assert.ok(r, `no reversal names ${o.idempotency_key}`);
        assert.equal(r!.amount_minor, -o.amount_minor);
        assert.equal(r!.account, o.account);
        assert.equal(r!.rule_version, o.rule_version, "a reversal is a fact about the ORIGINAL computation");
        assert.equal(r!.beneficiary_user_id, o.beneficiary_user_id);
      }
      assert.equal(unbalancedTransactions(bk), 0);

      // Held to the pure model, key for key.
      const asModel: LedgerEntry[] = originals.map((o) => ({
        entryId: o.idempotency_key, transactionKey: o.transaction_key, account: o.account as LedgerEntry["account"],
        amountMinor: o.amount_minor, currency: o.currency, entryReason: o.entry_reason as LedgerEntry["entryReason"],
        ruleVersion: o.rule_version, attributionKind: "booking", attributionId: o.attribution_id,
        beneficiaryUserId: o.beneficiary_user_id, reversesEntryId: null, provider: o.provider,
        externalRef: o.external_ref, idempotencyKey: o.idempotency_key,
      }));
      const expected: string[] = [];
      for (const tx of new Set(asModel.map((e) => e.transactionKey))) {
        const built = buildReversal(asModel, { transactionKey: tx });
        assert.equal(built.status, "reversed");
        if (built.status === "reversed") {
          for (const e of built.entries) expected.push(`${e.idempotencyKey}|${e.transactionKey}|${e.account}|${e.amountMinor}|${e.reversesEntryId}`);
        }
      }
      const idemOf = new Map(originals.map((o) => [o.id, o.idempotency_key]));
      assert.deepEqual(
        reversals.map((r) => `${r.idempotency_key}|${r.transaction_key}|${r.account}|${r.amount_minor}|${idemOf.get(r.reverses_entry_id!)}`).sort(),
        expected.sort(),
      );

      // The fold is zero in every account, and the summary says so.
      const f = fold(all);
      assert.deepEqual([f.gross, f.fee, f.net, f.receivable], [0, 0, 0, 0]);
      const s = summaryOf(bk)!;
      assert.deepEqual([s.total_booking_usd, s.platform_fee_amount, s.buddy_net_estimated_amount], [0, 0, 0]);
      assert.ok(s.note?.startsWith(LEDGER_REVERSED_NOTE_PREFIX), `note = ${s.note}`);
      assert.equal(s.is_estimated, true, "a reversal is not a settlement: nothing clears is_estimated but one");
      assertSummaryIsFold(bk, "R1");
    });

    test("R2. every unfulfilled status reverses — including `cancelled`, the dispute resolved AGAINST the buddy", () => {
      for (const status of ["cancelled_by_buddy", "declined", "expired"]) {
        const b = seedBooking({ total: 30 });
        assert.equal(post(b, "booking_created").ok, true);
        setStatus(b, status);
        assert.deepEqual([fold(entriesOf(b)).net, entriesOf(b).length], [0, 8], status);
      }
      // resolve-dispute: disputed → cancelled when it favours the traveller.
      const lost = seedBooking({ total: 30, status: "disputed" });
      assert.equal(post(lost, "booking_created").ok, true);
      setStatus(lost, "cancelled");
      assert.deepEqual([fold(entriesOf(lost)).net, entriesOf(lost).length], [0, 8]);
      assert.match(summaryOf(lost)!.note ?? "", /cancelled/);

      // …and `completed`, the dispute resolved FOR the buddy, reverses nothing.
      const won = seedBooking({ total: 30, status: "disputed" });
      assert.equal(post(won, "booking_created").ok, true);
      setStatus(won, "completed");
      assert.deepEqual([fold(entriesOf(won)).net, entriesOf(won).length], [2700, 4]);
    });

    test("R3. reversal is idempotent: a second transition, or an explicit call, appends nothing", () => {
      const b = seedBooking({ total: 30 });
      assert.equal(post(b, "booking_created").ok, true);
      setStatus(b, "cancelled_by_traveler");
      const snapshot = JSON.stringify(entriesOf(b));
      setStatus(b, "expired");
      const again = post(b, "reversal");
      assert.deepEqual([again.ok, again.replayed, again.entries_appended], [true, true, 0]);
      assert.equal(JSON.stringify(entriesOf(b)), snapshot);
      assert.equal(Number(scalar(
        `SELECT count(*) FROM (SELECT reverses_entry_id FROM public.rent_buddy_earnings_entries
                               WHERE booking_id = ${q(b)} AND reverses_entry_id IS NOT NULL
                               GROUP BY 1 HAVING count(*) > 1) x`)), 0, "at most one reversal per entry");
    });

    test("R4. if the reversal cannot be written, the status change does not happen either", () => {
      const b = seedBooking({ total: 30 });
      assert.equal(post(b, "booking_created").ok, true);
      exec(
        `CREATE OR REPLACE FUNCTION public.payd_refuse_reversal() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN
           IF NEW.entry_reason = 'reversal' AND NEW.booking_id = ${q(b)}::uuid THEN
             RAISE EXCEPTION 'payd: scripted failure of the reversal insert';
           END IF;
           RETURN NEW;
         END $f$;
         CREATE TRIGGER payd_refuse_reversal BEFORE INSERT ON public.rent_buddy_earnings_entries
           FOR EACH ROW EXECUTE FUNCTION public.payd_refuse_reversal();`,
      );
      try {
        const r = psql(`SET LOCAL ROLE service_role;\nUPDATE public.rent_buddy_bookings SET status = 'cancelled_by_traveler' WHERE id = ${q(b)};`, { single: true });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /scripted failure of the reversal insert/);
      } finally {
        exec(`DROP TRIGGER IF EXISTS payd_refuse_reversal ON public.rent_buddy_earnings_entries;\nDROP FUNCTION IF EXISTS public.payd_refuse_reversal();`);
      }
      // Observed from a separate connection, after the failed transaction ended.
      assert.equal(scalar(`SELECT status::text FROM public.rent_buddy_bookings WHERE id = ${q(b)}`), "requested",
        "a booking must not become cancelled with its earning entries standing");
      assert.equal(entriesOf(b).length, 4);
      // With the obstacle gone the same cancellation goes through, whole.
      setStatus(b, "cancelled_by_traveler");
      assert.equal(fold(entriesOf(b)).net, 0);
    });

    test("R5. a live booking cannot be reversed, and a never-ledgered booking has nothing to reverse", () => {
      const live = seedBooking({ total: 30, status: "scheduled" });
      assert.equal(post(live, "booking_created").ok, true);
      const r = post(live, "reversal");
      assert.deepEqual([r.ok, r.refusal], [false, "booking_not_reversible"]);
      assert.equal(entriesOf(live).length, 4);

      const never = seedBooking({ total: 30 });
      setStatus(never, "declined");            // the trigger runs and finds nothing
      assert.equal(entriesOf(never).length, 0);
      assert.equal(summaryOf(never), null, "no summary row is invented for a booking that was never ledgered");
      assert.equal(post(never, "reversal").outcome, "nothing_to_reverse");
    });

    test("R6. scope: the reversal covers the EARNING entries; a tip is a separate transaction and is left standing", () => {
      // Not reachable through the API (a tip needs `completed`, which nothing
      // moves to an unfulfilled status). Pinned so the scope is a decision on
      // record, not an accident: whether an upheld dispute returns a tip is an
      // owner refund rule nobody has made.
      const b = seedBooking({ total: 100, status: "completed" });
      assert.equal(post(b, "tip", "r6", { traveler_id: w.traveller, amount_usd: 9 }).ok, true);
      exec(`UPDATE public.rent_buddy_bookings SET status = 'cancelled' WHERE id = ${q(b)};`);
      const f = fold(entriesOf(b));
      assert.deepEqual([f.gross, f.fee, f.tip, f.net], [0, 0, 900, 900]);
      assertSummaryIsFold(b, "R6");
    });

    test("R7. the entries are append-only for the API's role: UPDATE and DELETE are both refused", () => {
      const b = seedBooking({ total: 30 });
      assert.equal(post(b, "booking_created").ok, true);
      const upd = psql(`SET LOCAL ROLE service_role;\nUPDATE public.rent_buddy_earnings_entries SET amount_minor = 1 WHERE booking_id = ${q(b)};`, { single: true });
      assert.notEqual(upd.status, 0);
      const del = psql(`SET LOCAL ROLE service_role;\nDELETE FROM public.rent_buddy_earnings_entries WHERE booking_id = ${q(b)};`, { single: true });
      assert.notEqual(del.status, 0);
      assert.equal(entriesOf(b).length, 4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // S — settlement
  // ═══════════════════════════════════════════════════════════════════════════
  describe("S — is_estimated is cleared by a settlement entry and by nothing else", () => {
    let bk: string;
    const settle = (key: string, args: Record<string, unknown>) => post(bk, "settlement", key, args);

    before(() => {
      bk = seedBooking({ total: 100, status: "completed" });
      assert.equal(post(bk, "booking_created").ok, true);
      assert.equal(post(bk, "tip", "s-tip", { traveler_id: w.traveller, amount_usd: 5 }).ok, true);
    });

    test("S1. created and tipped — and still an estimate: no event but a settlement touches the flag", () => {
      assert.equal(summaryOf(bk)!.is_estimated, true);
      assert.equal(summaryOf(bk)!.in_app_amount_collected, 0);
    });

    test("S2. a settlement must name a provider and its reference: there is no processor to name today", () => {
      const before_ = JSON.stringify(entriesOf(bk));
      assert.equal(settle("s2a", { amount_minor: 100 }).refusal, "settlement_provider_required");
      assert.equal(settle("s2b", { provider: "none", external_ref: "x", amount_minor: 100 }).refusal, "settlement_provider_required");
      assert.equal(settle("s2c", { provider: "scripted", amount_minor: 100 }).refusal, "settlement_provider_required");
      assert.equal(settle("s2d", { provider: "scripted", external_ref: "cap", amount_minor: 0 }).refusal, "invalid_amount");
      assert.equal(settle("s2e", { provider: "scripted", external_ref: "cap", amount_minor: 99999 }).refusal, "settlement_exceeds_receivable");
      assert.equal(post(bk, "settlement", null, { provider: "scripted", external_ref: "cap", amount_minor: 100 }).refusal, "event_key_required");
      assert.equal(JSON.stringify(entriesOf(bk)), before_);
      assert.equal(summaryOf(bk)!.is_estimated, true);
    });

    test("S3. the TABLE refuses a settlement row that names no provider, whoever writes it", () => {
      const r = psql(
        `SET LOCAL ROLE service_role;
         INSERT INTO public.rent_buddy_earnings_entries
           (transaction_key, booking_id, account, entry_reason, amount_minor, rule_version, attribution_kind, attribution_id, idempotency_key)
         VALUES ('t', ${q(bk)}, 'traveler_receivable', 'settlement', 100, 'x', 'booking', ${q(bk)}, 'payd-s3');`,
        { single: true },
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /rbee_settlement_names_provider/);
      // …and 2901's boundary is intact: the single-sided column cannot assert a settlement at all.
      const c = psql(
        `SET LOCAL ROLE service_role;
         INSERT INTO public.rent_buddy_earnings_entries
           (transaction_key, booking_id, account, entry_reason, amount_minor, cash_settled_minor, rule_version, attribution_kind, attribution_id, idempotency_key)
         VALUES ('t', ${q(bk)}, 'buddy_payable', 'tip', 100, 100, 'x', 'booking', ${q(bk)}, 'payd-s3b');`,
        { single: true },
      );
      assert.notEqual(c.status, 0);
      assert.match(c.stderr, /cash_settled_minor/);
    });

    test("S4. a scripted PARTIAL settlement is recorded as collected and the row is still an estimate", () => {
      const r = settle("cap-1", { provider: "scripted", external_ref: "cap_1", amount_minor: 4000 });
      assert.deepEqual([r.ok, r.entries_appended], [true, 2], JSON.stringify(r));
      const pair = entriesOf(bk).filter((e) => e.entry_reason === "settlement");
      assert.deepEqual(
        pair.map((e) => [e.account, e.amount_minor, e.provider, e.external_ref, e.cash_settled_minor]).sort(),
        [["cash_external", -4000, "scripted", "cap_1", 0], ["traveler_receivable", 4000, "scripted", "cap_1", 0]].sort(),
      );
      assert.equal(summaryOf(bk)!.in_app_amount_collected, 40);
      assert.equal(summaryOf(bk)!.is_estimated, true, "6500 minor units are still owed");
      assertSummaryIsFold(bk, "S4");
    });

    test("S5. the settlement that leaves nothing owing clears is_estimated — the only thing that can", () => {
      const replay = settle("cap-1", { provider: "scripted", external_ref: "cap_1", amount_minor: 4000 });
      assert.deepEqual([replay.ok, replay.replayed, replay.entries_appended], [true, true, 0]);
      assert.equal(settle("cap-1", { provider: "scripted", external_ref: "cap_1", amount_minor: 4001 }).refusal, "idempotency_key_reused");

      const r = settle("cap-2", { provider: "scripted", external_ref: "cap_2", amount_minor: 6500 });
      assert.equal(r.ok, true, JSON.stringify(r));
      const s = summaryOf(bk)!;
      assert.equal(s.in_app_amount_collected, 105);
      assert.equal(s.is_estimated, false);
      assert.equal(unbalancedTransactions(bk), 0);
      assertSummaryIsFold(bk, "S5");
      // Nothing more can be settled against it.
      assert.equal(settle("cap-3", { provider: "scripted", external_ref: "cap_3", amount_minor: 1 }).refusal, "settlement_exceeds_receivable");
    });

    test("S6. a booking with no unreversed earning cannot be settled", () => {
      const b = seedBooking({ total: 50 });
      assert.equal(post(b, "settlement", "s6", { provider: "scripted", external_ref: "c", amount_minor: 100 }).refusal, "booking_not_ledgered");
      assert.equal(post(b, "booking_created").ok, true);
      setStatus(b, "declined");
      assert.equal(post(b, "settlement", "s6b", { provider: "scripted", external_ref: "c", amount_minor: 100 }).refusal, "booking_not_ledgered");
      assert.equal(summaryOf(b)!.is_estimated, true, "fully reversed and owing nothing is still not `settled`");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // L — the earnings summary, folded in SQL
  // ═══════════════════════════════════════════════════════════════════════════
  describe("L — rb_buddy_ledger_totals is the fold over a buddy's completed bookings", () => {
    test("L1. gross, commission, net and tips come from the entries; collected is 0; an unledgered booking is counted, not priced", () => {
      const solo = seedBuddy("payd_solo", "new");
      const a = seedBooking({ buddyProfile: solo.profile, total: 100, status: "completed", cash: 0 });
      const b = seedBooking({ buddyProfile: solo.profile, total: 50.5, status: "completed", deposit: 15.15, cash: 35.35 });
      const unledgered = seedBooking({ buddyProfile: solo.profile, total: 999, status: "completed" });
      const cancelled = seedBooking({ buddyProfile: solo.profile, total: 70 });
      const upcoming = seedBooking({ buddyProfile: solo.profile, total: 40, status: "scheduled" });
      for (const x of [a, b, cancelled, upcoming]) assert.equal(post(x, "booking_created").ok, true);
      setStatus(cancelled, "cancelled_by_buddy");
      assert.equal(post(a, "tip", "l1", { traveler_id: w.traveller, amount_usd: 4 }).ok, true);

      const t = JSON.parse(asService(`SELECT public.rb_buddy_ledger_totals(${q(solo.user)})::text;`).join("\n"));
      assert.deepEqual(t, {
        completedCount: 3,
        unledgeredCompletedCount: 1,
        completedTotalUsd: 1149.5,
        depositScheduledUsd: 1114.15,          // 100 + 15.15 + 999: the stored deposit_usd of ALL three, a term and never a collection
        ledgeredGrossUsd: 150.5,
        estimatedPlatformFeeUsd: 15.05,        // 10.00 + 5.05, each rounded once per booking
        estimatedBuddyEarningsUsd: 135.45,     // gross − commission; tips are reported apart
        tipsTotalUsd: 4,
        tipCount: 1,
        inAppAmountCollectedUsd: 0,
        cashBalanceDueUsd: 35.35,
        cashBalanceConfirmedUsd: 0,
        isEstimated: true,
      });
      assert.ok(unledgered);
    });

    test("L2. a buddy with nothing completed gets zeros that say `estimated`, not a claim of settlement", () => {
      const none = seedBuddy("payd_none", "new");
      const t = JSON.parse(asService(`SELECT public.rb_buddy_ledger_totals(${q(none.user)})::text;`).join("\n"));
      assert.deepEqual([t.completedCount, t.estimatedBuddyEarningsUsd, t.inAppAmountCollectedUsd, t.isEstimated], [0, 0, 0, true]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P — payout hold / release
  // ═══════════════════════════════════════════════════════════════════════════
  describe("P — a payout transition and its audit row commit together or not at all", () => {
    const seedPayout = (status = "pending"): string => {
      const bk = seedBooking({ total: 120, status: "completed" });
      const id = scalar(
        `INSERT INTO public.rent_buddy_payouts (booking_id, buddy_id, amount_usd, status)
         VALUES (${q(bk)}, ${q(w.buddyProfile)}, 120, ${q(status)}) RETURNING id`,
      )!;
      w.payouts.push(id);
      return id;
    };
    const transition = (id: string, action: string, admin: string, reason: string | null) => JSON.parse(asService(
      `SELECT public.rb_admin_payout_transition(${q(id)}, ${q(action)}, ${q(admin)}, ${reason === null ? "NULL" : q(reason)})::text;`,
    ).join("\n"));
    const payout = (id: string) => rows<{ status: string; hold_reason: string | null; held_by: string | null; released_by: string | null; notes: string | null }>(
      `SELECT status, hold_reason, held_by, released_by, notes FROM public.rent_buddy_payouts WHERE id = ${q(id)}`,
    )[0]!;
    const audits = (id: string) => rows<{ action: string; admin_id: string; notes: string; details: any }>(
      `SELECT action, admin_id, notes, details FROM public.rent_buddy_admin_actions
        WHERE target_type = 'payout' AND target_id = ${q(id)} ORDER BY created_at, action`,
    );

    test("P1. hold then release: each moves the status AND writes its audit row, with who and why", () => {
      const id = seedPayout();
      const held = transition(id, "hold", w.admin, "  fraud review  ");
      assert.deepEqual([held.ok, held.from_status, held.to_status], [true, "pending", "on_hold"]);
      assert.deepEqual(payout(id), { status: "on_hold", hold_reason: "fraud review", held_by: w.admin, released_by: null, notes: null });
      assert.equal(audits(id).length, 1);
      assert.deepEqual(
        [audits(id)[0]!.action, audits(id)[0]!.admin_id, audits(id)[0]!.notes, audits(id)[0]!.details.from_status, audits(id)[0]!.details.to_status],
        ["payout_held", w.admin, "fraud review", "pending", "on_hold"],
      );

      const released = transition(id, "release", w.admin, "cleared by review");
      assert.deepEqual([released.ok, released.from_status, released.to_status], [true, "on_hold", "released"]);
      assert.deepEqual(
        [payout(id).status, payout(id).released_by, payout(id).notes, payout(id).hold_reason],
        ["released", w.admin, "cleared by review", "fraud review"],
      );
      assert.deepEqual(audits(id).map((a) => a.action).sort(), ["payout_held", "payout_released"]);
      assert.equal(typeof released.audit_id, "string");
    });

    test("P2. a FAILING AUDIT INSERT LEAVES THE STATUS UNCHANGED", () => {
      const id = seedPayout();
      exec(
        `CREATE OR REPLACE FUNCTION public.payd_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN
           IF NEW.target_type = 'payout' AND NEW.target_id = ${q(id)} THEN
             RAISE EXCEPTION 'payd: scripted failure of the audit insert';
           END IF;
           RETURN NEW;
         END $f$;
         CREATE TRIGGER payd_refuse_audit BEFORE INSERT ON public.rent_buddy_admin_actions
           FOR EACH ROW EXECUTE FUNCTION public.payd_refuse_audit();`,
      );
      try {
        const r = psql(
          `SET LOCAL ROLE service_role;\nSELECT public.rb_admin_payout_transition(${q(id)}, 'hold', ${q(w.admin)}, 'will not be audited');`,
          { single: true },
        );
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /scripted failure of the audit insert/);
      } finally {
        exec(`DROP TRIGGER IF EXISTS payd_refuse_audit ON public.rent_buddy_admin_actions;\nDROP FUNCTION IF EXISTS public.payd_refuse_audit();`);
      }
      // Read from a separate connection, after the failed call's transaction ended.
      assert.deepEqual(payout(id), { status: "pending", hold_reason: null, held_by: null, released_by: null, notes: null },
        "if the audit row cannot be written the money state does not move (09 §10)");
      assert.equal(audits(id).length, 0);
      // …and with the obstacle removed the same hold goes through, whole.
      assert.equal(transition(id, "hold", w.admin, "now audited").ok, true);
      assert.equal(payout(id).status, "on_hold");
      assert.equal(audits(id).length, 1);
    });

    test("P3. refusals change nothing and audit nothing", () => {
      const id = seedPayout();
      const snap = () => JSON.stringify([payout(id), audits(id)]);
      const before_ = snap();
      assert.equal(transition(id, "release", w.admin, "never held").refusal, "conflict");
      assert.equal(transition(id, "release", w.admin, "never held").current_status, "pending");
      assert.equal(transition(id, "hold", w.outsider, "not an admin").refusal, "not_admin");
      assert.equal(transition(id, "hold", w.admin, "   ").refusal, "reason_required");
      assert.equal(transition(id, "hold", w.admin, null).refusal, "reason_required");
      assert.equal(transition(id, "approve", w.admin, "no such action").refusal, "unknown_action");
      assert.equal(transition(randomUUID(), "hold", w.admin, "no such payout").refusal, "not_found");
      assert.equal(snap(), before_);

      assert.equal(transition(id, "hold", w.admin, "first").ok, true);
      const held = snap();
      const again = transition(id, "hold", w.admin, "second");
      assert.deepEqual([again.refusal, again.current_status], ["conflict", "on_hold"]);
      assert.equal(snap(), held, "a refused re-hold must not overwrite held_by or the reason");
    });

    // paid → on_hold → released would "release" money that had already left.
    test("P5. only a PENDING payout can be held: paid, processing, failed, cancelled, released — refused, unchanged, unaudited", () => {
      for (const status of ["paid", "processing", "failed", "cancelled", "released", "something_else"]) {
        const id = seedPayout(status);
        const before_ = JSON.stringify([payout(id), audits(id)]);
        const held = transition(id, "hold", w.admin, "too late");
        assert.deepEqual([held.ok, held.refusal, held.current_status], [false, "conflict", status], status);
        // …so it cannot be released (again) either.
        const released = transition(id, "release", w.admin, "again");
        assert.deepEqual([released.ok, released.refusal, released.current_status], [false, "conflict", status], status);
        assert.equal(JSON.stringify([payout(id), audits(id)]), before_, `${status}: a refused transition changed or audited something`);
      }
    });

    test("P4. two simultaneous releases: exactly one applies, one audit row, and it names the winner", async () => {
      const id = seedPayout();
      const second = seedUser("payd_admin2");
      w.users.push(second);
      exec(`UPDATE public.profiles SET role = 'admin' WHERE id = ${q(second)};`);
      assert.equal(transition(id, "hold", w.admin, "review").ok, true);

      const call = (admin: string) => psqlAsync(
        `SET LOCAL ROLE service_role;\nSELECT public.rb_admin_payout_transition(${q(id)}, 'release', ${q(admin)}, 'release by ' || ${q(admin)})::text;`,
      );
      const [a, b] = await Promise.all([call(w.admin), call(second)]);
      assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
      const ra = JSON.parse(a.stdout.trim()); const rb = JSON.parse(b.stdout.trim());
      assert.deepEqual([ra.ok, rb.ok].sort(), [false, true]);
      const winner = ra.ok ? w.admin : second;
      assert.equal(payout(id).released_by, winner);
      const released = audits(id).filter((x) => x.action === "payout_released");
      assert.equal(released.length, 1);
      assert.equal(released[0]!.admin_id, winner);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Q — one market: what checkout is shown is what is posted
  // ═══════════════════════════════════════════════════════════════════════════
  describe("Q — the rate and the AMOUNT quoted are the rate and the amount posted", () => {
    const OTHER = `${MARKET}-elsewhere`;
    after(() => exec(`DELETE FROM public.rent_buddy_launch_controls WHERE country_code IN (${q(MARKET)}, ${q(OTHER)});`));

    // The defect: the quote resolved the commission for the buddy's PROFILE city
    // and the posting for the city on the BOOKING row — a request-supplied string
    // on the canonical route. This test FAILS if the two differ.
    test("Q1. a booking whose own city and country are not the buddy's is posted at the quoted rate, to the cent", () => {
      // An override for the place the REQUEST names. It must price nothing.
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(OTHER)}, 'Request City', NULL, 3), (${q(OTHER)}, NULL, NULL, 4);`);
      const shown = quote(w.buddy25Profile, { price: 33.33, qty: 3 });
      assert.deepEqual([shown.ok, shown.priced, shown.market_country, shown.market_city], [true, true, MARKET, "Payd City"]);
      assert.deepEqual([shown.fee_percent, shown.fee_source, shown.total_minor, shown.fee_minor], [25, "fee_schedule", 9999, 2500]);

      const bk = seedBooking({ buddyProfile: w.buddy25Profile, total: shown.total_usd, city: "Request City", country: OTHER });
      const posted = post(bk, "booking_created");
      assert.equal(posted.ok, true, JSON.stringify(posted));
      assert.equal(posted.fee_percent, shown.fee_percent, "the rate posted is not the rate quoted");
      const f = fold(entriesOf(bk));
      assert.equal(f.gross, shown.total_minor, "the gross posted is not the price quoted");
      assert.equal(f.fee, shown.fee_minor, "the commission posted is not the commission quoted");
      assert.equal(f.net, shown.total_minor - shown.fee_minor);
      assert.equal(summaryOf(bk)!.platform_fee_amount, shown.fee_usd);
      assert.equal(summaryOf(bk)!.buddy_net_estimated_amount, shown.buddy_net_usd);
      assertSummaryIsFold(bk, "Q1");
    });

    test("Q2. an override on the BUDDY's market applies to both — whatever the booking row says", () => {
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, 'Payd City', NULL, 7);`);
      for (const [city, country] of [["Request City", OTHER], ["Payd City", MARKET], ["", null]] as const) {
        const shown = quote(w.buddy25Profile, { price: 123.45 });
        const bk = seedBooking({ buddyProfile: w.buddy25Profile, total: 123.45, city, country });
        const posted = post(bk, "booking_created");
        assert.deepEqual([shown.fee_percent, shown.fee_source, posted.fee_percent, posted.fee_source], [7, "launch_control", 7, "launch_control"], `${city}/${String(country)}`);
        assert.equal(fold(entriesOf(bk)).fee, shown.fee_minor, `${city}/${String(country)}`);
        assert.equal(shown.fee_minor, 864, "7 % of 123.45 = 8.6415 → 8.64");
      }
      exec(`DELETE FROM public.rent_buddy_launch_controls WHERE country_code = ${q(MARKET)};`);
    });

    test("Q3. the quote trims the buddy's market exactly as the posting does, and a blank one is NULL (no market override can match)", () => {
      const padded = seedBuddy("payd_padded", "new");
      exec(`UPDATE public.rent_buddy_profiles SET country = '  ' || ${q(MARKET)} || '  ', city = '  ' WHERE id = ${q(padded.profile)};`);
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, NULL, NULL, 6);`);
      const shown = quote(padded.profile, { price: 50 });
      assert.deepEqual([shown.market_country, shown.market_city, shown.fee_percent], [MARKET, null, 6]);
      const bk = seedBooking({ buddyProfile: padded.profile, total: 50, city: "anything" });
      assert.equal(post(bk, "booking_created").fee_percent, 6);
      exec(`DELETE FROM public.rent_buddy_launch_controls WHERE country_code = ${q(MARKET)};`);
    });

    test("Q4. a rate-only quote prices nothing; refusals are named; nothing is ever written", () => {
      const before_ = scalar(`SELECT count(*) FROM public.rent_buddy_earnings_entries`);
      const rate = quote(w.buddyProfile, { price: null });
      assert.deepEqual([rate.ok, rate.priced, rate.fee_percent, rate.fee_source, rate.tip_commission_percent, rate.deposit_enabled], [true, false, 10, "owner_default", 0, false]);
      assert.equal("total_usd" in rate, false);
      assert.deepEqual(
        [
          quote(randomUUID(), { price: 10 }).refusal,
          quote(w.buddyProfile, { price: "NaN" }).refusal,
          quote(w.buddyProfile, { price: "Infinity" }).refusal,
          quote(w.buddyProfile, { price: -1 }).refusal,
          quote(w.buddyProfile, { price: 10, qty: 0 }).refusal,
          quote(w.buddyProfile, { price: 10, qty: "NaN" }).refusal,
          quote(w.buddyProfile, { price: 100000000 }).refusal,
          quote(w.buddyProfile, { price: 50000, qty: 2000 }).refusal,
          quote(w.buddyProfile, { price: 10, mode: "barter" }).refusal,
          quote(w.buddyProfile, { price: 10, mode: "deposit_plus_cash", pct: 101 }).refusal,
        ],
        ["buddy_not_found", "invalid_total", "invalid_total", "invalid_total", "invalid_total", "invalid_total", "invalid_total", "invalid_total", "invalid_payment_mode", "invalid_arguments"],
      );
      assert.equal(quote(w.buddyProfile, { price: 99999999.99 }).total_minor, 9999999999, "the largest price a booking can carry is quoted");
      assert.equal(quote(w.buddyProfile, { price: 0 }).total_minor, 0, "a free booking is a price");
      assert.equal(scalar(`SELECT count(*) FROM public.rent_buddy_earnings_entries`), before_);
    });

    test("Q5. the arithmetic is the posting's: rate × hours rounded once, the commission rounded once, in minor units", () => {
      for (const [price, qty, totalMinor, feeMinor] of [[20, 2.5, 5000, 500], [33.333, 3, 10000, 1000], [0.05, 1, 5, 1], [0.04, 1, 4, 0], [10.05, 1, 1005, 101]] as const) {
        const r = quote(w.buddyProfile, { price, qty });
        assert.deepEqual([r.total_minor, r.fee_minor, r.total_usd * 100 === r.total_minor || Math.round(r.total_usd * 100) === r.total_minor], [totalMinor, feeMinor, true], `${price} × ${qty}`);
        const bk = seedBooking({ total: r.total_usd });
        assert.equal(post(bk, "booking_created").ok, true);
        assert.deepEqual([fold(entriesOf(bk)).gross, fold(entriesOf(bk)).fee], [totalMinor, feeMinor], `${price} × ${qty}: posted ≠ quoted`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // D — the deposit switch (owner ruling 2026-10-04: no deposit in the first release)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("D — one switch decides whether any deposit exists; it is OFF", () => {
    const terms = (r: any) => [r.payment_mode, r.deposit_enabled, r.deposit_percent, r.deposit_usd, r.cash_balance_usd];

    test("D1. OFF (as seeded): every booking's deposit is 0; a deposit_plus_cash booking's cash balance is the whole price", () => {
      assert.notEqual(switchValue(), "t", "the switch must be OFF (or its singleton row absent) on the harness");
      assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33, mode: "deposit_plus_cash" })), ["deposit_plus_cash", false, 0, 0, 33.33]);
      assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33, mode: "deposit_plus_cash", pct: 40 })), ["deposit_plus_cash", false, 0, 0, 33.33], "a percentage is POLICY; with the switch off it takes nothing");
      assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33, mode: "full_in_app" })), ["full_in_app", false, 0, 0, 0]);
      assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33 })), ["full_in_app", false, 0, 0, 0], "no mode named = full in-app, the column's default");
    });

    test("D2. a MISSING singleton row is OFF — absence is never read as permission", () => {
      withDepositSwitch("missing", () => {
        assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33, mode: "deposit_plus_cash", pct: 40 })), ["deposit_plus_cash", false, 0, 0, 33.33]);
        assert.equal(quote(w.buddyProfile, { price: null }).deposit_enabled, false);
      });
    });

    test("D3. ON: the split is integer minor units — it sums to the price exactly; full in-app is the whole price", () => {
      withDepositSwitch("on", () => {
        assert.equal(quote(w.buddyProfile, { price: null }).deposit_enabled, true);
        // 30 % (the literal the canonical route carried) when the caller names none.
        assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33, mode: "deposit_plus_cash" })), ["deposit_plus_cash", true, 30, 10, 23.33]);
        assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33, mode: "deposit_plus_cash", pct: 40 })), ["deposit_plus_cash", true, 40, 13.33, 20]);
        assert.deepEqual(terms(quote(w.buddyProfile, { price: 33.33, mode: "full_in_app", pct: 40 })), ["full_in_app", true, 100, 33.33, 0]);
        for (const price of [0.01, 0.03, 19.99, 100.01, 99999999.99]) {
          for (const pct of [0, 20, 25, 35, 40, 100]) {
            const r = quote(w.buddyProfile, { price, mode: "deposit_plus_cash", pct });
            assert.equal(Math.round(r.deposit_usd * 100) + Math.round(r.cash_balance_usd * 100), r.total_minor, `${price} at ${pct} %: deposit + cash ≠ price`);
            assert.ok(r.deposit_usd >= 0 && r.cash_balance_usd >= 0, `${price} at ${pct} %`);
          }
        }
      });
      // …and it is OFF again afterwards.
      assert.equal(quote(w.buddyProfile, { price: 33.33, mode: "deposit_plus_cash" }).deposit_usd, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A — add-ons: one idempotent ledger event
  // ═══════════════════════════════════════════════════════════════════════════
  describe("A — an add-on is priced INTO the ledger: the fold equals the booking's new total", () => {
    // The defect: total 100 → 150 on the booking row, `booking_created` re-posted
    // as a replay, the ledger's gross still 100 — so the commission and the
    // buddy's earnings excluded every add-on.
    test("A1. 100 + 50: four ADJUSTMENT entries; gross 150, commission 15, net 135; the join row; the booking's totals", () => {
      const bk = seedBooking({ total: 100, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);
      const originals = entriesOf(bk);
      const addon = seedAddon(w.buddyProfile, 50);

      const r = addons(bk, [addon]);
      assert.deepEqual([r.ok, r.event, r.replayed, r.entries_appended, r.addons_added], [true, "addons", false, 4, 1], JSON.stringify(r));
      assert.deepEqual(r.booking, { total_usd: 150, addons_total_usd: 50, deposit_usd: 0, cash_balance_usd: 0, payment_mode: "full_in_app", added_usd: 50 });

      const all = entriesOf(bk);
      assert.equal(all.length, 8);
      // Append-only: the originals are byte-for-byte what they were.
      assert.deepEqual(all.filter((e) => originals.some((o) => o.id === e.id)), originals);
      const adj = all.filter((e) => !originals.some((o) => o.id === e.id));
      assert.deepEqual(adj.map((e) => `${e.transaction_key.replace(bk, "<bk>")}|${e.account}|${e.entry_reason}|${e.amount_minor}`).sort(), [
        "booking:<bk>:addons:1:booking_gross|buddy_payable|booking_gross|5000",
        "booking:<bk>:addons:1:booking_gross|traveler_receivable|booking_gross|-5000",
        "booking:<bk>:addons:1:platform_fee|buddy_payable|platform_fee|-500",
        "booking:<bk>:addons:1:platform_fee|platform_revenue|platform_fee|500",
      ]);
      assert.ok(adj.every((e) => e.rule_version === RULE_V2 && e.reverses_entry_id === null && e.provider === "none"));
      assert.ok(adj.filter((e) => e.account === "buddy_payable").every((e) => e.beneficiary_user_id === w.buddyUser));
      assert.equal(unbalancedTransactions(bk), 0);

      const f = fold(all);
      assert.deepEqual([f.gross, f.fee, f.net], [15000, 1500, 13500], "the fold does not equal the new total");
      const s = summaryOf(bk)!;
      assert.deepEqual([s.total_booking_usd, s.platform_fee_amount, s.buddy_net_estimated_amount, s.platform_fee_percent], [150, 15, 135, 10]);
      assert.equal(scalar(`SELECT addons_usd::float8 FROM public.rent_buddy_earnings_ledger WHERE booking_id = ${q(bk)}`), "50");
      assertSummaryIsFold(bk, "A1");
      assert.deepEqual([termsOf(bk).total_usd, termsOf(bk).addons_total_usd], [150, 50]);
      assert.deepEqual(attachedAddons(bk), [{ addon_id: addon, price_usd: 50 }]);
      assert.equal(Math.round(termsOf(bk).total_usd * 100), f.gross, "the booking's total and the ledger's gross disagree");
    });

    test("A2. a retry attaches, prices and ledgers NOTHING — idempotent by state, not by a key the client must remember", () => {
      const bk = seedBooking({ total: 100, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);
      const addon = seedAddon(w.buddyProfile, 50);
      assert.equal(addons(bk, [addon]).ok, true);
      const before_ = JSON.stringify([entriesOf(bk), summaryOf(bk), termsOf(bk), attachedAddons(bk)]);
      for (let i = 0; i < 3; i++) {
        const r = addons(bk, [addon, addon]);
        assert.deepEqual([r.ok, r.replayed, r.entries_appended, r.addons_added, r.booking.total_usd, r.booking.added_usd], [true, true, 0, 0, 150, 0]);
      }
      assert.equal(JSON.stringify([entriesOf(bk), summaryOf(bk), termsOf(bk), attachedAddons(bk)]), before_);
    });

    test("A3. six concurrent attaches of one add-on: attached once, priced once, ledgered once", async () => {
      const bk = seedBooking({ total: 100, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);
      const addon = seedAddon(w.buddyProfile, 50);
      const script = `SET LOCAL ROLE service_role;\nSELECT public.rb_post_booking_ledger(${q(bk)}, 'addons', NULL, ` +
        `${q(JSON.stringify({ traveler_id: w.traveller, addon_ids: [addon], allowed_statuses: OPEN_STATUSES }))}::jsonb)::text;`;
      const results = await Promise.all(Array.from({ length: 6 }, () => psqlAsync(script)));
      for (const r of results) assert.equal(r.status, 0, r.stderr);
      const parsed = results.map((r) => JSON.parse(r.stdout.trim()));
      assert.equal(parsed.filter((p) => p.ok && p.addons_added === 1).length, 1, "exactly one call may attach the add-on");
      assert.equal(parsed.filter((p) => p.ok && p.addons_added === 0 && p.replayed === true).length, 5);
      assert.equal(attachedAddons(bk).length, 1);
      assert.equal(termsOf(bk).total_usd, 150, "an add-on was priced in more than once");
      assert.deepEqual([fold(entriesOf(bk)).gross, fold(entriesOf(bk)).fee, entriesOf(bk).length], [15000, 1500, 8]);
      assertSummaryIsFold(bk, "A3");
    });

    test("A4. successive add-ons: each is its own adjustment, and the commission is round(total × rate) — not a sum of roundings", () => {
      const bk = seedBooking({ buddyProfile: w.buddy25Profile, total: 33.33, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);                    // 25 % of 33.33 = 8.3325 → 8.33
      assert.equal(fold(entriesOf(bk)).fee, 833);
      const tiny = seedAddon(w.buddy25Profile, 0.1);
      const tiny2 = seedAddon(w.buddy25Profile, 0.1);
      const big = seedAddon(w.buddy25Profile, 50);

      assert.equal(addons(bk, [tiny]).ok, true);                             // 33.43 → 8.3575 → 8.36
      assert.deepEqual([fold(entriesOf(bk)).gross, fold(entriesOf(bk)).fee], [3343, 836]);
      assert.equal(addons(bk, [tiny2]).ok, true);                            // 33.53 → 8.3825 → 8.38
      assert.deepEqual([fold(entriesOf(bk)).gross, fold(entriesOf(bk)).fee], [3353, 838], "0.025 + 0.025 rounded separately would be 8.39");
      const r = addons(bk, [big, tiny]);                                     // 83.53 → 20.8825 → 20.88; `tiny` is already attached
      assert.deepEqual([r.addons_added, r.booking.added_usd, r.booking.total_usd], [1, 50, 83.53]);
      const f = fold(entriesOf(bk));
      assert.deepEqual([f.gross, f.fee, f.net], [8353, 2088, 6265]);
      assert.equal(f.fee, Math.round(f.gross * 25 / 100), "the fee fold is not round(total × rate)");
      assert.deepEqual(
        [...new Set(entriesOf(bk).map((e) => e.transaction_key).filter((k) => k.includes(":addons:")))].map((k) => k.split(":").slice(3).join(":")).sort(),
        ["1:booking_gross", "1:platform_fee", "2:booking_gross", "2:platform_fee", "3:booking_gross", "3:platform_fee"],
      );
      assert.equal(unbalancedTransactions(bk), 0);
      assertSummaryIsFold(bk, "A4");
    });

    test("A5. the booking keeps the RATE it was ledgered at: a later override or schedule change does not re-rate the add-on", () => {
      const bk = seedBooking({ buddyProfile: w.buddy25Profile, total: 100, deposit: 0 });
      assert.equal(post(bk, "booking_created").fee_percent, 25);
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, NULL, NULL, 5);`);
      try {
        const addon = seedAddon(w.buddy25Profile, 50);
        assert.equal(addons(bk, [addon]).ok, true);
        assert.deepEqual([summaryOf(bk)!.platform_fee_percent, summaryOf(bk)!.platform_fee_amount, summaryOf(bk)!.buddy_net_estimated_amount], [25, 37.5, 112.5]);
      } finally {
        exec(`DELETE FROM public.rent_buddy_launch_controls WHERE country_code = ${q(MARKET)};`);
      }
    });

    test("A6. a booking that was never ledgered is ledgered in the same call, at its NEW total — no adjustment needed", () => {
      const bk = seedBooking({ total: 100, deposit: 0 });
      const addon = seedAddon(w.buddyProfile, 50);
      const r = addons(bk, [addon]);
      assert.deepEqual([r.ok, r.entries_appended, r.fee_percent, r.fee_source], [true, 4, 10, "owner_default"]);
      assert.ok(entriesOf(bk).every((e) => !e.transaction_key.includes(":addons:")));
      assert.deepEqual([fold(entriesOf(bk)).gross, fold(entriesOf(bk)).fee], [15000, 1500]);
      assertSummaryIsFold(bk, "A6");
    });

    test("A7. refusals are named and write NOTHING — not the join row, not the total, not an entry", () => {
      const bk = seedBooking({ total: 100, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);
      const addon = seedAddon(w.buddyProfile, 50);
      const inactive = seedAddon(w.buddyProfile, 20, false);
      const started = seedBooking({ total: 100, status: "in_progress" });
      const snapshot = () => JSON.stringify([entriesOf(bk), termsOf(bk), attachedAddons(bk), entriesOf(started), termsOf(started), attachedAddons(started)]);
      const before_ = snapshot();

      assert.equal(addons(bk, [addon], { traveler_id: w.outsider }).refusal, "not_traveler");
      assert.equal(addons(bk, [addon], { traveler_id: null }).refusal, "not_traveler");
      assert.equal(addons(started, [addon]).refusal, "booking_not_open");
      assert.equal(addons(bk, [addon], { allowed_statuses: ["scheduled"] }).refusal, "booking_not_open");
      assert.equal(addons(bk, [inactive]).refusal, "no_valid_addons");
      assert.equal(addons(bk, [randomUUID()]).refusal, "no_valid_addons");
      assert.equal(addons(bk, []).refusal, "invalid_arguments");
      assert.equal(addons(bk, [addon], { allowed_statuses: [] }).refusal, "invalid_arguments");
      assert.equal(addons(bk, ["not-a-uuid"]).refusal, "invalid_arguments", "a bad id must be a refusal, not a raised cast error");
      assert.equal(addons(bk, [addon], { payment_mode: "barter" }).refusal, "invalid_arguments");
      assert.equal(addons(bk, [addon], { deposit_percent: 101 }).refusal, "invalid_arguments");
      assert.equal(post(randomUUID(), "addons", null, { traveler_id: w.traveller, addon_ids: [addon], allowed_statuses: OPEN_STATUSES }).refusal, "booking_not_found");
      assert.equal(snapshot(), before_);

      // An inactive add-on beside an active one: only the active one attaches.
      const mixed = addons(bk, [inactive, addon]);
      assert.deepEqual([mixed.ok, mixed.addons_added, mixed.booking.total_usd], [true, 1, 150]);
      assert.deepEqual(attachedAddons(bk).map((a) => a.addon_id), [addon]);
    });

    test("A8. a total that would overflow the money column is refused, not raised", () => {
      const bk = seedBooking({ total: 99999990, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);
      const addon = seedAddon(w.buddyProfile, 50);
      // (bigint amounts: entriesOf() reads amount_minor as an int for the model comparison)
      const entryState = () => scalar(`SELECT count(*) || ':' || COALESCE(sum(abs(amount_minor)), 0) FROM public.rent_buddy_earnings_entries WHERE booking_id = ${q(bk)}`);
      const before_ = JSON.stringify([entryState(), termsOf(bk)]);
      assert.equal(entryState(), "4:21999997800", "gross 99,999,990.00 twice and 10 % of it twice");
      const r = addons(bk, [addon]);
      assert.deepEqual([r.ok, r.refusal], [false, "invalid_total"]);
      assert.equal(JSON.stringify([entryState(), termsOf(bk)]), before_);
      assert.deepEqual(attachedAddons(bk), []);
    });

    test("A9. cancelling a booking with add-ons reverses EVERY earning entry, adjustments included: the fold is zero", () => {
      const bk = seedBooking({ total: 100, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);
      assert.equal(addons(bk, [seedAddon(w.buddyProfile, 50)]).ok, true);
      setStatus(bk, "cancelled_by_traveler");
      const all = entriesOf(bk);
      assert.equal(all.length, 16, "8 earning entries and their 8 reversals");
      const f = fold(all);
      assert.deepEqual([f.gross, f.fee, f.net, f.receivable], [0, 0, 0, 0]);
      assert.equal(unbalancedTransactions(bk), 0);
      assertSummaryIsFold(bk, "A9");
      // …and add-ons cannot be attached to it afterwards.
      assert.equal(addons(bk, [seedAddon(w.buddyProfile, 5)]).refusal, "booking_not_open");
    });

    test("A10. the payment terms are re-derived under the ONE switch: no deposit while it is off; integer cents when it is on", () => {
      const cash = seedBooking({ total: 100, deposit: 0, cash: 100 });
      exec(`UPDATE public.rent_buddy_bookings SET payment_mode = 'deposit_plus_cash' WHERE id = ${q(cash)};`);
      assert.equal(post(cash, "booking_created").ok, true);
      const r = addons(cash, [seedAddon(w.buddyProfile, 33.33)], { deposit_percent: 40, deposit_rule: "new_traveler", deposit_reason: "First-time traveler" });
      assert.deepEqual(r.booking, { total_usd: 133.33, addons_total_usd: 33.33, deposit_usd: 0, cash_balance_usd: 133.33, payment_mode: "deposit_plus_cash", added_usd: 33.33 });
      assert.deepEqual(
        [termsOf(cash).deposit_usd, termsOf(cash).cash_balance_usd, termsOf(cash).deposit_percent, termsOf(cash).deposit_rule_applied],
        [0, 133.33, 0, "no_deposit"], "a deposit was stored while the owner's switch is off",
      );
      assert.deepEqual([summaryOf(cash)!.deposit_amount, summaryOf(cash)!.cash_balance_due], [0, 133.33], "the summary's terms did not follow the booking's");

      withDepositSwitch("on", () => {
        const on = seedBooking({ total: 100, deposit: 0, cash: 100 });
        exec(`UPDATE public.rent_buddy_bookings SET payment_mode = 'deposit_plus_cash' WHERE id = ${q(on)};`);
        assert.equal(post(on, "booking_created").ok, true);
        const x = addons(on, [seedAddon(w.buddyProfile, 33.33)], { deposit_percent: 40, deposit_rule: "new_traveler", deposit_reason: "First-time traveler" });
        assert.deepEqual([x.booking.deposit_usd, x.booking.cash_balance_usd], [53.33, 80], "40 % of 133.33 = 53.332 → 53.33; the rest is cash");
        assert.deepEqual([termsOf(on).deposit_percent, termsOf(on).deposit_rule_applied], [40, "new_traveler"]);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // U — unledgered bookings are counted truthfully; an unfulfilled booking stays so
  // ═══════════════════════════════════════════════════════════════════════════
  describe("U — unledgered is counted by ENTRIES, and a cancelled booking cannot come back", () => {
    const totals = (user: string) => JSON.parse(asService(`SELECT public.rb_buddy_ledger_totals(${q(user)})::text;`).join("\n"));

    // The defect: the count was `completed bookings with no SUMMARY row`. A
    // completed booking with a summary row and no entries — what 2330's writer
    // left, and 2901 backfilled nothing — contributes $0 to every figure and was
    // not counted, so a buddy's earnings silently omitted it.
    test("U1. a completed booking with a summary ROW and no entries is unledgered: counted, and contributes no money", () => {
      const solo = seedBuddy("payd_u1", "new");
      const ledgered = seedBooking({ buddyProfile: solo.profile, total: 100, status: "completed" });
      assert.equal(post(ledgered, "booking_created").ok, true);
      const rowOnly = seedBooking({ buddyProfile: solo.profile, total: 80, status: "completed" });
      exec(
        `INSERT INTO public.rent_buddy_earnings_ledger (booking_id, buddy_user_id, traveler_id, total_booking_usd, platform_fee_percent, platform_fee_amount, buddy_gross_amount, buddy_net_estimated_amount)
         VALUES (${q(rowOnly)}, ${q(solo.user)}, ${q(w.traveller)}, 80, 22, 17.6, 80, 62.4);`,
      );
      const neither = seedBooking({ buddyProfile: solo.profile, total: 60, status: "completed" });
      const free = seedBooking({ buddyProfile: solo.profile, total: 0, status: "completed" });
      assert.equal(post(free, "booking_created").ok, true);     // a zero summary, no entries — by design
      assert.ok(neither);

      const t = totals(solo.user);
      assert.equal(t.completedCount, 4);
      assert.equal(t.unledgeredCompletedCount, 2, "the booking with a summary row and no entries was not counted");
      assert.deepEqual([t.ledgeredGrossUsd, t.estimatedPlatformFeeUsd, t.estimatedBuddyEarningsUsd], [100, 10, 90],
        "a summary row with no entries was folded in — the entries are the record");
      assert.equal(t.completedTotalUsd, 240);
      assert.equal(t.isEstimated, true);
    });

    test("U2. posting `booking_created` for the row-only booking ledgers it — the count drops; nothing is backfilled by itself", () => {
      const solo = seedBuddy("payd_u2", "new");
      const rowOnly = seedBooking({ buddyProfile: solo.profile, total: 80, status: "completed" });
      exec(
        `INSERT INTO public.rent_buddy_earnings_ledger (booking_id, buddy_user_id, traveler_id, total_booking_usd, platform_fee_percent, platform_fee_amount, buddy_gross_amount, buddy_net_estimated_amount)
         VALUES (${q(rowOnly)}, ${q(solo.user)}, ${q(w.traveller)}, 80, 22, 17.6, 80, 62.4);`,
      );
      assert.equal(totals(solo.user).unledgeredCompletedCount, 1);
      assert.equal(entriesOf(rowOnly).length, 0, "the read must not write");
      // An explicit posting prices it at TODAY's configuration (10), not the 22
      // on the old row: which rate an old booking is owed is the backfill's
      // question, and it is why no backfill runs in this migration.
      const r = post(rowOnly, "booking_created");
      assert.deepEqual([r.ok, r.fee_percent], [true, 10]);
      assert.equal(totals(solo.user).unledgeredCompletedCount, 0);
    });

    // The defect: cancel → the earning entries are reversed → the status is
    // written back to a live one → `booking_created` answered ok/replayed and
    // appended nothing: a live booking whose ledger folds to zero. No route
    // revives a booking (cancelled, cancelled_by_*, declined, expired are
    // terminal in lib/stateMachines/registry.ts), so the TABLE refuses it.
    test("U3. an unfulfilled booking cannot be moved back to a live status: 23514, and nothing changes", () => {
      for (const dead of ["cancelled", "cancelled_by_traveler", "cancelled_by_buddy", "declined", "expired"]) {
        const bk = seedBooking({ total: 40 });
        assert.equal(post(bk, "booking_created").ok, true);
        setStatus(bk, dead);
        const before_ = JSON.stringify([entriesOf(bk), termsOf(bk).status]);
        for (const live of ["requested", "pending", "scheduled", "in_progress", "completed", "disputed"]) {
          const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\nUPDATE public.rent_buddy_bookings SET status = ${q(live)} WHERE id = ${q(bk)};`, { single: true });
          assert.notEqual(r.status, 0, `${dead} → ${live} was allowed`);
          assert.match(r.stderr, /23514/, `${dead} → ${live}: ${r.stderr}`);
        }
        assert.equal(JSON.stringify([entriesOf(bk), termsOf(bk).status]), before_);
        // Unfulfilled → unfulfilled is still a move the lifecycle makes (R3).
        setStatus(bk, "expired");
        assert.equal(termsOf(bk).status, "expired");
        // Any other column of a dead booking can still be written.
        asService(`UPDATE public.rent_buddy_bookings SET notes = 'support note' WHERE id = ${q(bk)};`);
      }
    });

    test("U4. if a revived booking exists anyway, re-posting REFUSES it by name — never ok/replayed over a ledger that folds to zero", () => {
      const bk = seedBooking({ total: 40, status: "completed" });
      assert.equal(post(bk, "booking_created").ok, true);
      setStatus(bk, "cancelled");
      // Only a superuser bypassing triggers can make this state.
      exec(`SET session_replication_role = replica;\nUPDATE public.rent_buddy_bookings SET status = 'completed' WHERE id = ${q(bk)};\nSET session_replication_role = origin;`);
      const before_ = JSON.stringify(entriesOf(bk));
      const r = post(bk, "booking_created");
      assert.deepEqual([r.ok, r.refusal], [false, "booking_reversed"], JSON.stringify(r));
      const tipped = post(bk, "tip", "u4", { traveler_id: w.traveller, amount_usd: 5 });
      assert.deepEqual([tipped.ok, tipped.refusal], [false, "booking_reversed"], "a tip must not be recorded on a booking whose earnings were reversed");
      assert.equal(JSON.stringify(entriesOf(bk)), before_);
      exec(`SET session_replication_role = replica;\nUPDATE public.rent_buddy_bookings SET status = 'cancelled' WHERE id = ${q(bk)};\nSET session_replication_role = origin;`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // K — the creation key
  // ═══════════════════════════════════════════════════════════════════════════
  describe("K — a retried create cannot make a second booking: creation_key is unique per traveller", () => {
    const insertKeyed = (traveller: string, key: string | null) => psql(
      `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\nINSERT INTO public.rent_buddy_bookings (buddy_id, traveler_id, booking_date, duration_h, city, category, status, total_usd, creation_key)
       VALUES (${q(w.buddyProfile)}, ${q(traveller)}, current_date, 1, 'Payd City', 'city', 'requested', 10, ${key === null ? "NULL" : q(key)}) RETURNING id;`,
      { single: true },
    );
    const track = (r: { status: number; stdout: string }) => { if (r.status === 0) w.bookings.push(r.stdout.trim().split("\n")[0]!); return r; };

    test("K1. the same traveller and key twice: the second INSERT is a unique violation naming the index the API looks for", () => {
      const key = `book:${w.buddyProfile}:attempt-${randomUUID()}`;
      assert.equal(track(insertKeyed(w.traveller, key)).status, 0);
      const second = insertKeyed(w.traveller, key);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /23505/);
      assert.match(second.stderr, /rbb_creation_key_once/, "lib/rentBuddyEarningsLedger.ts#isCreationKeyConflict matches on this name");
      assert.equal(scalar(`SELECT count(*) FROM public.rent_buddy_bookings WHERE traveler_id = ${q(w.traveller)} AND creation_key = ${q(key)}`), "1");
    });

    test("K2. the key is scoped by the ACTING USER: another traveller may use the same key; no key at all is never a conflict", () => {
      const key = `book:${w.buddyProfile}:attempt-${randomUUID()}`;
      assert.equal(track(insertKeyed(w.traveller, key)).status, 0);
      assert.equal(track(insertKeyed(w.outsider, key)).status, 0);
      assert.equal(track(insertKeyed(w.traveller, null)).status, 0);
      assert.equal(track(insertKeyed(w.traveller, null)).status, 0);
    });

    test("K3. the key has a bounded shape", () => {
      const tooLong = insertKeyed(w.traveller, "x".repeat(401));
      assert.notEqual(tooLong.status, 0);
      assert.match(tooLong.stderr, /rbb_creation_key_shape/);
      const empty = insertKeyed(w.traveller, "");
      assert.notEqual(empty.status, 0);
      assert.match(empty.stderr, /rbb_creation_key_shape/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // X — the TypeScript callers against the real functions
  // ═══════════════════════════════════════════════════════════════════════════
  describe("X — lib/rentBuddyLedgerPosting.ts speaks to the real functions", () => {
    test("X1. postBookingLedgerEvent / postBookingTip: stored state, and the summary read back unconverted", async () => {
      const bk = seedBooking({ total: 64, status: "completed" });
      const created = await postBookingLedgerEvent(rpcClient(), bk, "booking_created");
      assert.equal(created.status, "posted", JSON.stringify(created));
      if (created.status !== "posted") return;
      assert.deepEqual([created.replayed, created.entriesAppended, created.feePercent, created.feeSource], [false, 4, 10, "owner_default"]);
      assert.deepEqual(
        [created.summary?.totalBookingUsd, created.summary?.platformFeeAmount, created.summary?.buddyNetEstimatedAmount, created.summary?.inAppAmountCollected, created.summary?.isEstimated],
        [64, 6.4, 57.6, 0, true],
      );
      assert.equal(entriesOf(bk).length, 4);

      const tipped = await postBookingTip(rpcClient(), { bookingId: bk, travelerId: w.traveller, amountUsd: 6, eventKey: "x1" });
      assert.equal(tipped.status, "posted", JSON.stringify(tipped));
      if (tipped.status === "posted") assert.equal(tipped.summary?.tipUsd, 6);
      assert.equal(scalar(`SELECT amount_usd::float8 FROM public.rent_buddy_tips WHERE booking_id = ${q(bk)}`), "6");

      const refused = await postBookingTip(rpcClient(), { bookingId: bk, travelerId: w.outsider, amountUsd: 6, eventKey: "x1b" });
      assert.deepEqual([refused.status, (refused as any).refusal], ["refused", "not_traveler"]);
    });

    test("X2. quoteBooking and readBuddyLedgerTotals read the database's own answers", async () => {
      const rate = await quoteBooking(rpcClient(), { buddyProfileId: w.buddy25Profile, category: "city" });
      assert.equal(rate.status, "ok", JSON.stringify(rate));
      if (rate.status !== "ok") return;
      assert.deepEqual(
        [rate.quote.feePercent, rate.quote.feeSource, rate.quote.marketCountry, rate.quote.marketCity, rate.quote.priced, rate.quote.totalUsd, rate.quote.depositEnabled],
        [25, "fee_schedule", MARKET, "Payd City", false, null, false],
      );
      const dflt = await quoteBooking(rpcClient(), { buddyProfileId: w.buddyProfile, category: null });
      assert.deepEqual(dflt.status === "ok" && [dflt.quote.feePercent, dflt.quote.feeSource], [10, "owner_default"]);

      const totals = await readBuddyLedgerTotals(rpcClient(), w.buddy25User);
      assert.equal(totals.status, "ok");
      if (totals.status === "ok") assert.equal(totals.totals.inAppAmountCollectedUsd, 0);
    });

    test("X5. quotePricedBooking and postBookingAddons: the lib reads the database's price, terms and add-on answer", async () => {
      const priced = await quotePricedBooking(rpcClient(), { buddyProfileId: w.buddy25Profile, category: "city", unitPriceUsd: 33.33, quantity: 3, paymentMode: "deposit_plus_cash" });
      assert.deepEqual(priced, { status: "ok", quote: {
        feePercent: 25, feeSource: "fee_schedule", totalUsd: 99.99, feeUsd: 25, paymentMode: "deposit_plus_cash",
        depositEnabled: false, depositPercent: 0, depositUsd: 0, cashBalanceUsd: 99.99,
      } });
      const refused = await quotePricedBooking(rpcClient(), { buddyProfileId: randomUUID(), unitPriceUsd: 10 });
      assert.deepEqual([refused.status, (refused as any).refusal], ["refused", "buddy_not_found"]);
      const badMode = await quoteBooking(rpcClient(), { buddyProfileId: w.buddyProfile, unitPriceUsd: 10, paymentMode: "barter" });
      assert.deepEqual([badMode.status, (badMode as any).refusal], ["refused", "invalid_payment_mode"]);

      const bk = seedBooking({ total: 100, deposit: 0 });
      assert.equal(post(bk, "booking_created").ok, true);
      const addon = seedAddon(w.buddyProfile, 50);
      const attached = await postBookingAddons(rpcClient(), { bookingId: bk, travelerId: w.traveller, addonIds: [addon], allowedStatuses: OPEN_STATUSES });
      assert.deepEqual(attached, { status: "attached", addonsAdded: 1, replayed: false, entriesAppended: 4,
        booking: { totalUsd: 150, addonsTotalUsd: 50, depositUsd: 0, cashBalanceUsd: 0, paymentMode: "full_in_app", addedUsd: 50 } });
      const again = await postBookingAddons(rpcClient(), { bookingId: bk, travelerId: w.traveller, addonIds: [addon], allowedStatuses: OPEN_STATUSES });
      assert.deepEqual(again.status === "attached" && [again.addonsAdded, again.replayed, again.entriesAppended, again.booking.totalUsd, again.booking.addedUsd], [0, true, 0, 150, 0]);
      const notMine = await postBookingAddons(rpcClient(), { bookingId: bk, travelerId: w.outsider, addonIds: [addon], allowedStatuses: OPEN_STATUSES });
      assert.deepEqual([notMine.status, (notMine as any).refusal], ["refused", "not_traveler"]);
      assertSummaryIsFold(bk, "X5");
    });

    test("X3. transitionPayout applies and refuses through the real function", async () => {
      const bk = seedBooking({ total: 10, status: "completed" });
      const id = scalar(`INSERT INTO public.rent_buddy_payouts (booking_id, buddy_id, amount_usd, status) VALUES (${q(bk)}, ${q(w.buddyProfile)}, 10, 'pending') RETURNING id`)!;
      w.payouts.push(id);
      const held = await transitionPayout(rpcClient(), { payoutId: id, action: "hold", adminId: w.admin, reason: "x3" });
      assert.deepEqual([held.status, (held as any).toStatus], ["applied", "on_hold"]);
      const again = await transitionPayout(rpcClient(), { payoutId: id, action: "hold", adminId: w.admin, reason: "x3 again" });
      assert.deepEqual([again.status, (again as any).refusal, (again as any).currentStatus], ["refused", "conflict", "on_hold"]);
    });

    test("X4. with the function ABSENT the caller reports the NAMED error, and nothing was written a second way", async () => {
      // A clone with 3824 rolled back is exactly "the migration is not applied".
      const main = new URL(LOCAL_DB_URL).pathname.slice(1);
      const absent = `${CLONE}_absent`;
      const bk = seedBooking({ total: 33, status: "completed" });
      useDatabase(urlFor("postgres"));
      exec(`DROP DATABASE IF EXISTS "${absent}";`);
      exec(`CREATE DATABASE "${absent}" TEMPLATE "${main}";`);
      useDatabase(urlFor(absent));
      try {
        // This suite's own settlement rows and overrides would make the rollback
        // refuse (M5/M6); a clone has no reader but this test, so clear them here.
        exec(
          `SET session_replication_role = replica;\nDELETE FROM public.rent_buddy_earnings_entries WHERE entry_reason = 'settlement';\nSET session_replication_role = origin;\n` +
          `UPDATE public.rent_buddy_launch_controls SET platform_fee_percent = NULL WHERE platform_fee_percent IS NOT NULL;`,
        );
        const back = psql(sqlFile(ROLLBACK));
        assert.equal(back.status, 0, back.stderr);

        const created = await postBookingLedgerEvent(rpcClient(), bk, "booking_created");
        assert.deepEqual([created.status, (created as any).error], ["unavailable", LEDGER_UNAVAILABLE]);
        const tipped = await postBookingTip(rpcClient(), { bookingId: bk, travelerId: w.traveller, amountUsd: 5, eventKey: "x4" });
        assert.deepEqual([tipped.status, (tipped as any).error], ["unavailable", LEDGER_UNAVAILABLE]);
        const payout = await transitionPayout(rpcClient(), { payoutId: randomUUID(), action: "hold", adminId: w.admin, reason: "x4" });
        assert.deepEqual([payout.status, (payout as any).error], ["unavailable", LEDGER_UNAVAILABLE]);
        // The quote is absent too: creation is refused BEFORE a booking is inserted.
        const quoted = await quotePricedBooking(rpcClient(), { buddyProfileId: w.buddyProfile, unitPriceUsd: 10 });
        assert.deepEqual([quoted.status, (quoted as any).error], ["unavailable", LEDGER_UNAVAILABLE]);
        const addonsAbsent = await postBookingAddons(rpcClient(), { bookingId: bk, travelerId: w.traveller, addonIds: [randomUUID()], allowedStatuses: OPEN_STATUSES });
        assert.deepEqual([addonsAbsent.status, (addonsAbsent as any).error], ["unavailable", LEDGER_UNAVAILABLE]);

        // No read-modify-write happened in its place.
        assert.equal(entriesOf(bk).length, 0);
        assert.equal(summaryOf(bk), null);
        assert.equal(scalar(`SELECT count(*) FROM public.rent_buddy_tips WHERE booking_id = ${q(bk)}`), "0");
        assert.equal(scalar(`SELECT COALESCE(tip_usd, 0)::float8 FROM public.rent_buddy_bookings WHERE id = ${q(bk)}`), "0");
      } finally {
        useDatabase(urlFor("postgres"));
        exec(`DROP DATABASE IF EXISTS "${absent}";`);
        useDatabase(null);
      }
    });
  });
});
