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
import {
  LEDGER_REVERSED_NOTE_PREFIX,
  LEDGER_UNAVAILABLE,
  postBookingLedgerEvent,
  postBookingTip,
  readBuddyLedgerTotals,
  resolvePlatformFeePercent,
  transitionPayout,
} from "../../lib/rentBuddyLedgerPosting.js";

const REPO = new URL("../../../../../", import.meta.url);
const sqlFile = (rel: string) => readFileSync(new URL(rel, REPO), "utf8");
const FORWARD = "artifacts/api-server/src/migrations/3824_rent_buddy_ledger_posting.sql";
const ROLLBACK = "db/rollback/2026-10-04-3824-rent-buddy-ledger-posting-rollback.sql";

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
              'rb_booking_ledger_on_unfulfilled','rb_buddy_ledger_totals','rb_admin_payout_transition')`,
    ));

    before(() => {
      const main = new URL(LOCAL_DB_URL).pathname.slice(1);
      useDatabase(urlFor("postgres"));
      exec(`DROP DATABASE IF EXISTS "${CLONE}";`);
      exec(`CREATE DATABASE "${CLONE}" TEMPLATE "${main}";`);
      useDatabase(urlFor(CLONE));
    });
    after(() => useDatabase(null));

    test("M1. the chain applied 3824: five functions, the trigger, the column, the widened vocabulary", () => {
      assert.equal(fnCount(), 5);
      assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.rent_buddy_bookings'::regclass AND tgname = 'rbb_reverse_ledger_on_unfulfilled'`), "1");
      assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='rent_buddy_launch_controls' AND column_name='platform_fee_percent'`), "1");
      assert.match(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rbee_entry_reason_check'`)!, /settlement/);
    });

    test("M2. re-applying is a no-op that still passes its own postconditions", () => {
      const again = applyOnClone(FORWARD);
      assert.equal(again.ok, true, again.stderr);
      assert.equal(fnCount(), 5);
    });

    test("M3. the rollback removes exactly what 3824 added and restores 2901's vocabulary", () => {
      const back = applyOnClone(ROLLBACK);
      assert.equal(back.ok, true, back.stderr);
      assert.equal(fnCount(), 0);
      assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.rent_buddy_bookings'::regclass AND tgname = 'rbb_reverse_ledger_on_unfulfilled'`), "0");
      assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='rent_buddy_launch_controls' AND column_name='platform_fee_percent'`), "0");
      assert.doesNotMatch(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rbee_entry_reason_check'`)!, /settlement/);
      // 2901's financial-control boundary was never touched, in either direction.
      assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND pg_get_constraintdef(oid) LIKE '%cash_settled_minor = 0%'`), "1");
    });

    test("M4. it re-applies after the rollback", () => {
      const forward = applyOnClone(FORWARD);
      assert.equal(forward.ok, true, forward.stderr);
      assert.equal(fnCount(), 5);
    });

    test("M5. the rollback REFUSES, changing nothing, while a commission override exists", () => {
      exec(`INSERT INTO public.rent_buddy_launch_controls (country_code, city, category, platform_fee_percent) VALUES (${q(MARKET)}, NULL, NULL, 9);`);
      const back = applyOnClone(ROLLBACK);
      assert.equal(back.ok, false);
      assert.match(back.stderr, /ROLLBACK REFUSED \(3824\).*commission override/);
      assert.equal(fnCount(), 5, "a refused rollback must change nothing");
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
      assert.equal(fnCount(), 5, "a refused rollback must change nothing");
      assert.match(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rbee_entry_reason_check'`)!, /settlement/);
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

    test("X2. resolvePlatformFeePercent and readBuddyLedgerTotals read the database's own answers", async () => {
      const fee = await resolvePlatformFeePercent(rpcClient(), { buddyLevel: LEVEL_25, countryCode: MARKET, city: "Payd City", category: "city" });
      assert.deepEqual(fee, { status: "ok", feePercent: 25, feeSource: "fee_schedule" });
      const dflt = await resolvePlatformFeePercent(rpcClient(), { buddyLevel: "standard", countryCode: null, city: null, category: null });
      assert.deepEqual(dflt, { status: "ok", feePercent: 10, feeSource: "owner_default" });

      const totals = await readBuddyLedgerTotals(rpcClient(), w.buddy25User);
      assert.equal(totals.status, "ok");
      if (totals.status === "ok") assert.equal(totals.totals.inAppAmountCollectedUsd, 0);
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
