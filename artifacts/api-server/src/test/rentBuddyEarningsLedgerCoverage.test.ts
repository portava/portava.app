/**
 * rent_buddy_earnings_ledger — every booking-creation path must write one.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Five routes INSERT into rent_buddy_bookings. The ledger writer was a
 * module-private helper inside rentABuddyMarketplace.ts and so was reachable
 * from only two of them (offer-accept and package-book). The other three —
 * the CANONICAL POST /rent-a-buddy/bookings, rebook, and the spec request —
 * created a booking and no ledger row.
 *
 * GET /rent-a-buddy/me/earnings/ledger reads that table and nothing else. A
 * buddy whose bookings arrived the ordinary way therefore saw
 * `{ ledger: [], total: 0 }` forever, no matter how much work they had done.
 *
 * ── THREE HALVES ────────────────────────────────────────────────────────────
 * 1. CO-LOCATION — that no booking insert exists without a ledger write beside
 *    it — is pinned by reading the routers as text. It is what stops a sixth
 *    creation path from being added later with the same hole; a runtime test
 *    can only cover paths someone remembered to write a test for.
 *
 * 2. THE RESULT IS NOT DISCARDED (PAY-050). Being called is not enough: all five
 *    sites used to end `.catch(() => {})`, so a booking whose ledger failed was
 *    handed back as made. Each site now stops on any result but `written`,
 *    withdraws the booking and answers the named refusal. Pinned as text for
 *    the same reason as (1), and executed here for the two helpers that do it.
 *
 * 3. THE PRICE. This file used to pin the arithmetic against a recording
 *    client: the level's fee rule, gross and net. The arithmetic is SQL since
 *    migration 3824 (PAY-055) and is executed against PostgreSQL by
 *    `src/test/db/rentBuddyLedgerPosting.db.test.ts`; what is asserted here is
 *    that each of those figures still has a database test holding it. Three of
 *    the old assertions changed MEANING, on the owner's rulings of 2026-10-04,
 *    and are recorded at the foot of this file rather than silently replaced.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyEarningsLedgerCoverage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sendBookingLedgerRefusal,
  withdrawUnledgeredBooking,
  type LedgerWriteResult,
} from "../lib/rentBuddyEarningsLedger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(HERE, "../routes");

/**
 * The routers that create bookings. Kept explicit rather than globbed so that a
 * NEW router creating bookings is a deliberate edit to this list, reviewed
 * alongside the ledger write it must carry.
 */
const BOOKING_CREATION_ROUTERS = [
  "rentABuddy.ts",
  "rentABuddySpec.ts",
  "rentABuddyMarketplace.ts",
] as const;

/**
 * `.from("rent_buddy_bookings")` followed by `.insert(` with only whitespace,
 * comments and chained builder calls between them. Deliberately narrow: an
 * `.update(` or a `.select(` on the same table is not a creation site.
 */
const BOOKING_INSERT_RE = /\.from\(\s*["']rent_buddy_bookings["']\s*\)\s*(?:\/\/[^\n]*\n|\s)*\.insert\(/g;
const LEDGER_CALL_RE = /createEarningsLedgerEntry\s*\(/g;

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ── Co-location ──────────────────────────────────────────────────────────────

describe("every rent_buddy_bookings INSERT is accompanied by a ledger write", () => {
  const perFile = BOOKING_CREATION_ROUTERS.map((f) => {
    const src = readFileSync(join(ROUTES, f), "utf8");
    return { f, inserts: count(src, BOOKING_INSERT_RE), ledgers: count(src, LEDGER_CALL_RE) };
  });

  it("finds the five known booking-creation sites, so the scan is not vacuous", () => {
    const total = perFile.reduce((n, r) => n + r.inserts, 0);
    assert.equal(
      total, 5,
      `expected 5 booking-creation sites across ${BOOKING_CREATION_ROUTERS.join(", ")}, ` +
      `found ${total}: ${JSON.stringify(perFile)}. A changed count means a creation ` +
      "path was added or removed — check it writes a ledger row, then update this number.",
    );
  });

  for (const { f, inserts, ledgers } of perFile) {
    it(`${f}: ${inserts} booking insert(s), ${ledgers} ledger write(s)`, () => {
      assert.ok(
        ledgers >= inserts,
        `${f} creates ${inserts} booking(s) but calls createEarningsLedgerEntry ${ledgers} time(s). ` +
        "A booking created without a ledger row is invisible to GET /me/earnings/ledger forever.",
      );
    });
  }
});

// ── The result is not discarded (PAY-050) ────────────────────────────────────

describe("no booking-creation site discards the ledger result", () => {
  for (const f of BOOKING_CREATION_ROUTERS) {
    const src = readFileSync(join(ROUTES, f), "utf8");
    const sites = [...src.matchAll(/createEarningsLedgerEntry\s*\(/g)].map((m) => m.index!);

    it(`${f}: every call is awaited into a result, and none is swallowed`, () => {
      assert.ok(sites.length > 0);
      for (const at of sites) {
        const before = src.slice(Math.max(0, at - 40), at);
        const after = src.slice(at, at + 900);
        const line = src.slice(0, at).split("\n").length;
        assert.match(before, /const ledger = await $/,
          `${f}:${line} — the ledger write is not awaited into \`ledger\`; a fire-and-forget write is PAY-050`);
        assert.equal(/^[^;]*\)\s*\.catch\(/.test(after), false,
          `${f}:${line} — the ledger write's failure is swallowed by .catch()`);
        assert.match(after, /if \(ledger\.status !== "written"\) \{/,
          `${f}:${line} — the result is not checked`);
        const branch = after.slice(after.indexOf('if (ledger.status !== "written") {'));
        assert.match(branch, /withdrawUnledgeredBooking\(/, `${f}:${line} — the unledgered booking is not withdrawn`);
        assert.match(branch, /return sendBookingLedgerRefusal\(res, ledger\);/,
          `${f}:${line} — the request is not answered with the named refusal`);
        assert.ok(
          branch.indexOf("withdrawUnledgeredBooking(") < branch.indexOf("return sendBookingLedgerRefusal("),
          `${f}:${line} — the refusal is sent before the booking is withdrawn`,
        );
      }
    });
  }

  it("the ledger is the FIRST thing done after the insert — nothing references the booking yet when it is withdrawn", () => {
    // Between a booking INSERT and its ledger call there may be the insert's own
    // error handling and nothing that writes: no event, no notification, no
    // thread. Otherwise withdrawing the row would orphan (or cascade away) what
    // was written in between.
    const WRITES = /\.(insert|upsert|update|delete)\(|recordBookingEvent\(|sendPush|notify|emitAnalyticsEvent\(/;

    /**
     * Drop the insert's OWN failure branches — `if (<somethingErr…>) { … return … }`
     * — which end the request and so cannot precede a ledger call. (Offer-accept
     * releases its claim there; that is a write on the path where there is no
     * booking to ledger.) A branch that does not return is kept and scanned.
     */
    function withoutFailureBranches(code: string): string {
      let out = "";
      let i = 0;
      const head = /if \(\s*!?\w*(?:[Ee]rr(?:or)?)\w*[^)]*\)\s*\{/g;
      for (;;) {
        head.lastIndex = i;
        const m = head.exec(code);
        if (!m) return out + code.slice(i);
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < code.length && depth > 0) {
          if (code[j] === "{") depth++;
          else if (code[j] === "}") depth--;
          j++;
        }
        const block = code.slice(m.index, j);
        out += code.slice(i, m.index) + (/\breturn\b/.test(block) ? "" : block);
        i = j;
      }
    }

    let checked = 0;
    for (const f of BOOKING_CREATION_ROUTERS) {
      const src = readFileSync(join(ROUTES, f), "utf8");
      for (const m of src.matchAll(BOOKING_INSERT_RE)) {
        const insertAt = m.index! + m[0].length;
        const ledgerAt = src.indexOf("createEarningsLedgerEntry(", insertAt);
        assert.notEqual(ledgerAt, -1, `${f}: a booking insert with no ledger call after it`);
        const line = src.slice(0, insertAt).split("\n").length;
        // From the end of the insert statement (its `.single();` / `.select();`)
        // to the ledger call.
        const rest = src.slice(insertAt, ledgerAt);
        const stmtEnd = rest.search(/\)\s*;\s*\n/);
        assert.notEqual(stmtEnd, -1, `${f}:${line} — could not find the end of the insert statement`);
        const between = withoutFailureBranches(rest.slice(stmtEnd).replace(/\/\/[^\n]*/g, ""));
        assert.equal(WRITES.test(between), false,
          `${f}:${line} — something is written between the booking insert and its ledger call:\n${between}`);
        assert.ok(between.length < 1500, `${f}:${line} — the ledger call is ${between.length} characters after the insert; is it still the first thing done?`);
        checked++;
      }
    }
    assert.equal(checked, 5);
  });
});

// ── The two helpers that do the refusing ─────────────────────────────────────

function deletingClient(outcome: { error?: any; throws?: boolean } = {}) {
  const ops: Array<{ table: string; op: string; args: any[] }> = [];
  const client = {
    from(table: string) {
      const b: any = {
        delete() { ops.push({ table, op: "delete", args: [] }); return b; },
        eq(c: string, v: any) { ops.push({ table, op: "eq", args: [c, v] }); return b; },
        then(res: (v: any) => void, rej: (e: any) => void) {
          if (outcome.throws) return rej(new Error("network"));
          return res({ data: null, error: outcome.error ?? null });
        },
      };
      return b;
    },
  };
  return { client, ops };
}

describe("withdrawUnledgeredBooking — the booking whose ledger was refused does not stay", () => {
  it("deletes exactly that booking, by id, and nothing else", async () => {
    const { client, ops } = deletingClient();
    assert.equal(await withdrawUnledgeredBooking(client, "bk-9"), true);
    assert.deepEqual(ops, [
      { table: "rent_buddy_bookings", op: "delete", args: [] },
      { table: "rent_buddy_bookings", op: "eq", args: ["id", "bk-9"] },
    ]);
  });

  it("reports false — not a thrown error, not a silent true — when the delete fails or throws", async () => {
    assert.equal(await withdrawUnledgeredBooking(deletingClient({ error: { message: "nope" } }).client, "bk-9"), false);
    assert.equal(await withdrawUnledgeredBooking(deletingClient({ throws: true }).client, "bk-9"), false);
  });

  it("never issues an unfiltered delete: no id, no call", async () => {
    const { client, ops } = deletingClient();
    assert.equal(await withdrawUnledgeredBooking(client, ""), false);
    assert.equal(await withdrawUnledgeredBooking(null, "bk-9"), false);
    assert.deepEqual(ops, []);
  });
});

describe("sendBookingLedgerRefusal — the cause has a NAME, and is never a booking", () => {
  function capture() {
    const out: { status?: number; body?: any } = {};
    const res = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    return { res, out };
  }
  const CASES: Array<[Exclude<LedgerWriteResult, { status: "written" }>, Record<string, unknown>]> = [
    [{ status: "unavailable", error: "ledger_unavailable", detail: "x" }, { error: "ledger_unavailable" }],
    [{ status: "failed", error: "ledger_write_failed", detail: "x" }, { error: "ledger_write_failed" }],
    [{ status: "refused", refusal: "invalid_total", detail: "-5" }, { error: "ledger_refused", refusal: "invalid_total" }],
    [{ status: "skipped", reason: "missing_arguments" }, { error: "ledger_write_failed" }],
  ];
  for (const [result, expected] of CASES) {
    it(`${result.status} → 503 ${JSON.stringify(expected)}`, () => {
      const { res, out } = capture();
      sendBookingLedgerRefusal(res, result);
      assert.equal(out.status, 503);
      assert.equal(out.body.retryable, true);
      for (const [k, v] of Object.entries(expected)) assert.equal(out.body[k], v);
      assert.equal("booking" in out.body, false, "a refusal must not carry a booking");
      assert.match(out.body.message, /not created/);
      assert.match(out.body.message, /Nothing was charged/);
      assert.equal(JSON.stringify(out.body).includes("detail"), false, "the database's detail text is for the log, not the traveller");
    });
  }
});

// ── The price ────────────────────────────────────────────────────────────────
//
// WHAT THIS HALF USED TO ASSERT, against `createEarningsLedgerEntry` and a
// recording client, and what holds each figure now. Three rows changed meaning.
//
//  (a) "uses the buddy level's fee rule and derives gross/net from it"
//      → database test C6 (schedule row for the level), C1/C7 (gross, fee, net).
//
//  (b) "writes NO row when the buddy's level has no fee rule"  — CHANGED.
//      The old writer refused (`fee_unresolved`), because the alternative then
//      was a silent literal 22 that was indistinguishable from a configured
//      rate (`08` §2.6). The owner ruled on 2026-10-04 that the commission is
//      10 % of the pre-tax service price "as a starting value", configurable by
//      product and market. So a level with no row is priced at 10 — and the
//      `08` §2.6 objection is met a different way: the answer carries
//      `fee_source = 'owner_default'`, so "nobody configured this" is never
//      indistinguishable from "somebody configured 10". C1 pins both.
//
//  (c) "writes NO row when the fee table cannot be read" — the read is inside
//      the SQL function's transaction now; if it fails the call fails and
//      nothing is written (`creatorLedgerBookingEntries.test.ts`, the `failed`
//      cases). A schedule row that is READABLE BUT UNUSABLE refuses: C8.
//
//  (d) "keeps the traveller service fee at 0 while rent_buddy_enabled is off"
//      and "reads traveler_service_fee_pct once the lane is live" — CHANGED.
//      The old writer booked the schedule's traveller-side percentage as soon
//      as the master switch was on. The owner's ruling names ONE fee (the
//      commission, deducted from the buddy); whether travellers are charged a
//      service fee on top is ruling R1 and is not made. The SQL function books
//      no traveller-side fee in either flag position — the conservative
//      reading: nobody is charged a fee nobody ruled on. C1 and C6 pin 0, C6
//      with a schedule row that carries traveler_service_fee_pct = 5. This is
//      an OPEN OWNER QUESTION (see the PAY-D handoff), not a decision.
//
//  (e) "writes nothing when the buddy profile cannot be loaded" /
//      "is a no-op on missing arguments" → `creatorLedgerBookingEntries.test.ts`.

describe("the price is asserted against the database, not against a recording client", () => {
  const DB_TEST = "db/rentBuddyLedgerPosting.db.test.ts";
  const src = readFileSync(join(HERE, DB_TEST), "utf8");
  function bodyOf(id: string): string {
    const start = src.indexOf(`test("${id}. `);
    assert.notEqual(start, -1, `${DB_TEST} no longer has a test ${id}`);
    const next = src.indexOf("\n    test(\"", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }
  const HELD: Array<{ what: string; by: string; needles: string[] }> = [
    { what: "(a) the level's schedule row prices the booking", by: "C6",
      needles: ['[r1.fee_percent, r1.fee_source], [25, "fee_schedule"]', "summaryOf(viaSchedule)!.platform_fee_amount, 20"] },
    { what: "(a) a market/product override beats the schedule, most specific first", by: "C6",
      needles: ['[r2.fee_percent, r2.fee_source], [8, "launch_control"]', "[12, 9.6]"] },
    { what: "(a) a booking already priced is not re-priced when configuration changes", by: "C6",
      needles: ["summaryOf(viaSchedule)!.platform_fee_percent, 25"] },
    { what: "(a) gross, fee and net", by: "C1",
      needles: ["s.total_booking_usd, 123.45", "s.platform_fee_amount, 12.35", "s.buddy_net_estimated_amount, 111.1"] },
    { what: "(b) no row for the level → 10, and it SAYS it is the default", by: "C1",
      needles: ["r.fee_percent, 10", 'r.fee_source, "owner_default"'] },
    { what: "(c) an unusable schedule row refuses; nothing is written", by: "C8",
      needles: ["fee_config_invalid", "summaryOf(b), null"] },
    { what: "(d) no traveller-side fee is booked at the default", by: "C1",
      needles: ["s.traveler_service_fee_amount, 0"] },
    { what: "(d) no traveller-side fee is booked even when the schedule row carries one", by: "C6",
      needles: ["summaryOf(viaSchedule)!.traveler_service_fee_amount, 0"] },
    { what: "the booking's payee and traveller are derived from the booking row", by: "C1",
      needles: ["s.buddy_user_id, w.buddyUser", "s.traveler_id, w.traveller"] },
    { what: "is_estimated stays true and the cash balance is not marked confirmed", by: "C2",
      needles: ["s.is_estimated, true", "s.cash_balance_confirmed, false"] },
  ];
  for (const h of HELD) {
    it(`${h.what} → ${h.by}`, () => {
      const body = bodyOf(h.by);
      for (const n of h.needles) {
        assert.ok(body.includes(n), `${DB_TEST} ${h.by} no longer asserts \`${n}\` — "${h.what}" would be asserted nowhere`);
      }
    });
  }

  it("no route file and neither ledger module computes a commission in JavaScript", () => {
    // PAY-055. The retired writer read rent_buddy_fee_rules and multiplied. A
    // fee read from JavaScript on a WRITE path is how the arithmetic comes back.
    const offenders: string[] = [];
    for (const f of ["../lib/rentBuddyEarningsLedger.ts", "../lib/rentBuddyLedgerPosting.ts"]) {
      const code = readFileSync(join(HERE, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      if (/rent_buddy_fee_rules|platform_fee_percent\s*[*/]|Math\.round|toFixed\(|\*\s*100|\/\s*100/.test(code)) offenders.push(f);
      assert.equal(/\.(upsert|insert|update)\(/.test(code), false, `${f} writes a table itself`);
    }
    assert.deepEqual(offenders, []);
  });
});
