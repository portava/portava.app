/**
 * rent_buddy_fee_rules — ONE take rate, resolved from ONE place, and able to
 * refuse.
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 * Three disagreeing constants expressed the same commission (`08` §2.3):
 * the per-level schedule in `rent_buddy_fee_rules`, `DEFAULT_PLATFORM_FEE_PERCENT
 * = 22` in the ledger writer, `defaultFeePercent = 22` in the buddy dashboard,
 * and `platformFeePct = 0.15` in the earnings-summary route. A `new` buddy was
 * quoted 15 %, ledgered at 25 % and dashboarded at 22 %.
 *
 * Two halves, and the second is what stops the third literal from being
 * reintroduced later:
 *
 *   1. BEHAVIOUR — the resolver returns three distinguishable states and never
 *      a number nobody configured.
 *   2. STRUCTURE — read as text: the deleted literals are gone from src/, and
 *      `rent_buddy_fee_rules` has exactly one pricing reader.
 *
 * ── THE SCHEDULE'S CONTENTS ARE NOT PINNED HERE ────────────────────────────
 * The rate is a flat 10 % — 1000 basis points — across every buddy level
 * (owner decision 2026-10-04), and migration 3601 is what puts it there.
 * `src/test/rentBuddyCommissionBasisPoints.test.ts` asserts THAT: the migration
 * converts faithfully, lands on 1000 for every level, and makes an unapproved
 * override unwritable.
 *
 * This file stays about the RESOLVER, and deliberately does not assert the
 * stored rate: the mechanism by which an approved override can change it is
 * part of the decision, so a test that pinned the number here would have to be
 * edited by the same change that approves one. What IS pinned is that whatever
 * the row says is what the caller gets, that an unapproved off-flat rate is NOT
 * a price, and that a missing or unreadable row yields no price at all.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyFeeSchedule.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDDY_LEVEL,
  FEE_SCHEDULE_TABLE,
  FLAT_COMMISSION_BASIS_POINTS,
  describeFeeScheduleFailure,
  platformFeeUsdFor,
  resolveFeeSchedule,
  travelerServiceFeeUsdFor,
  type FeeScheduleRule,
} from "../lib/rentBuddyFeeSchedule.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── A fake client that answers exactly one table ─────────────────────────────

function feeClient(opts: { row?: any; error?: any; throws?: boolean } = {}) {
  const seen: Array<[string, any]> = [];
  return {
    seen,
    client: {
      from(t: string) {
        return {
          _t: t,
          select() { return this; },
          eq(c: string, v: any) { seen.push([c, v]); return this; },
          async maybeSingle() {
            if (opts.throws) throw new Error("builder blew up");
            return { data: opts.row ?? null, error: opts.error ?? null };
          },
        };
      },
    },
  };
}

// ── State 1: resolved ────────────────────────────────────────────────────────

describe("resolveFeeSchedule — resolved", () => {
  it("returns the row's own rate, whatever it is", async () => {
    const { client } = feeClient({
      row: {
        buddy_level: "pro",
        platform_fee_basis_points: 1000,
        commission_override_approval: null,
        traveler_service_fee_usd: 0,
        traveler_service_fee_pct: 5,
      },
    });
    const res = await resolveFeeSchedule(client, "pro");
    assert.equal(res.status, "resolved");
    assert.deepEqual(res.status === "resolved" ? res.rule : null, {
      buddyLevel: "pro",
      platformFeeBasisPoints: 1000,
      travelerServiceFeeUsd: 0,
      travelerServiceFeePct: 5,
      commissionOverrideApproval: null,
    });
  });

  it("queries the schedule of record, keyed on buddy_level", async () => {
    const { client, seen } = feeClient({ row: { platform_fee_basis_points: 1000 } });
    await resolveFeeSchedule(client, "elite");
    assert.deepEqual(seen, [["buddy_level", "elite"]]);
    assert.equal(FEE_SCHEDULE_TABLE, "rent_buddy_fee_rules");
  });

  it("accepts numeric strings, which is how PostgREST returns numeric columns", async () => {
    const { client } = feeClient({
      row: { platform_fee_basis_points: "1000", traveler_service_fee_usd: "0.00", traveler_service_fee_pct: "5.00" },
    });
    const res = await resolveFeeSchedule(client, "new");
    assert.equal(res.status, "resolved");
    assert.equal(res.status === "resolved" && res.rule.platformFeeBasisPoints, 1000);
    assert.equal(res.status === "resolved" && res.rule.travelerServiceFeePct, 5);
  });

  it("treats a null/blank level as the column default, which HAS a row", async () => {
    const { client, seen } = feeClient({ row: { platform_fee_basis_points: 1000 } });
    const res = await resolveFeeSchedule(client, null);
    assert.equal(res.status, "resolved");
    assert.deepEqual(seen, [["buddy_level", DEFAULT_BUDDY_LEVEL]]);
    assert.equal(DEFAULT_BUDDY_LEVEL, "new");
  });

  it("accepts an off-flat rate ONLY when an approval is recorded with it (and the charge's policy carries it)", async () => {
    // The mechanism the decision keeps: a market override is resolvable, but
    // only with the separate approval beside it. 1050 basis points is 10.5 %,
    // which the old integer-percent column could not express at all.
    const { client } = feeClient({
      row: {
        platform_fee_basis_points: 1050,
        commission_override_approval: "owner-ruling-2026-10-04/market-xx",
      },
    });
    const res = await resolveFeeSchedule(client, "pro", [{ ...COMMISSION_RULES[0], bps: 1050, version: "fixture/charge-at-1050" }]); // lane B's keying: the charge carries 1050 too
    assert.equal(res.status, "resolved");
    assert.equal(res.status === "resolved" && res.rule.platformFeeBasisPoints, 1050);
    assert.equal(
      res.status === "resolved" && res.rule.commissionOverrideApproval,
      "owner-ruling-2026-10-04/market-xx",
    );
  });
});

// ── State 2: no_such_level ───────────────────────────────────────────────────

describe("resolveFeeSchedule — no_such_level", () => {
  it("does NOT invent a percentage when the level has no row", async () => {
    // 'standard' is accepted by PATCH /rent-a-buddy/admin/buddies/:id/level and
    // long had no fee row (`08` §2.5). It used to silently mean 22 %.
    //
    // Migration 3602 now seeds 'standard', so this is no longer a claim about
    // that level's configuration — it is the RESOLVER's contract when a row is
    // absent, which is the property that must not regress. Any level with no
    // row (one an operator invents, or an unseeded schedule) takes this path,
    // and it must still refuse rather than yield a rate.
    const { client } = feeClient({ row: null });
    const res = await resolveFeeSchedule(client, "standard");
    assert.equal(res.status, "no_such_level");
    assert.equal(res.status === "no_such_level" && res.buddyLevel, "standard");
    assert.equal(
      Object.prototype.hasOwnProperty.call(res, "rule"), false,
      "a level with no schedule row must carry no take rate at all",
    );
  });

  it("describes the failure in terms an operator can act on", async () => {
    const { client } = feeClient({ row: null });
    const res = await resolveFeeSchedule(client, "standard");
    assert.notEqual(res.status, "resolved");
    const msg = describeFeeScheduleFailure(res as any);
    assert.match(msg, /rent_buddy_fee_rules/);
    assert.match(msg, /standard/);
  });
});

// ── State 3: read_failed ─────────────────────────────────────────────────────

describe("resolveFeeSchedule — read_failed", () => {
  it("distinguishes an unreadable table from an absent row", async () => {
    const { client } = feeClient({ error: { message: "permission denied" } });
    const res = await resolveFeeSchedule(client, "new");
    assert.equal(res.status, "read_failed");
    assert.match(res.status === "read_failed" ? res.message : "", /permission denied/);
  });

  it("catches a throwing client rather than letting it escape as a 500", async () => {
    const { client } = feeClient({ throws: true });
    const res = await resolveFeeSchedule(client, "new");
    assert.equal(res.status, "read_failed");
  });

  it("treats a present-but-unusable rate as unknown, not as absent", async () => {
    // A row whose take rate is null/NaN/out-of-range/fractional is a BROKEN
    // schedule for a level that exists. Reporting it as 'no such level' would
    // let a malformed row read as a deliberate omission.
    for (const bad of [null, undefined, "", "abc", NaN, -1, 10001, 1000.5]) {
      const { client } = feeClient({ row: { platform_fee_basis_points: bad } });
      const res = await resolveFeeSchedule(client, "new");
      assert.equal(
        res.status, "read_failed",
        `platform_fee_basis_points=${String(bad)} must not resolve`,
      );
    }
  });

  it("refuses an off-flat rate that records no approval", async () => {
    // "Market overrides only when separately approved" has to be a refusal
    // somewhere or it is a sentence. The database CHECK makes such a row
    // unwritable; this makes it unusable on a database that has not run 3601,
    // on a restored dump, or after a hand edit.
    for (const approval of [null, undefined, "", "   "]) {
      const { client } = feeClient({
        row: { platform_fee_basis_points: 1500, commission_override_approval: approval },
      });
      const res = await resolveFeeSchedule(client, "pro");
      assert.equal(
        res.status, "read_failed",
        `1500 bps with approval=${JSON.stringify(approval)} must not resolve`,
      );
      assert.match(
        res.status === "read_failed" ? res.message : "",
        /separately approved/,
        "the refusal must say why, so an operator can act on it",
      );
    }
  });

  it("has no client at all → read_failed, never a default", async () => {
    const res = await resolveFeeSchedule(null, "new");
    assert.equal(res.status, "read_failed");
  });

  it("a database without 3601's column refuses rather than pricing at zero", async () => {
    // PostgREST answers an explicit select of a missing column with 42703. The
    // resolver must read that as "I do not know the rate", never as "no rate".
    const { client } = feeClient({
      error: { message: `column rent_buddy_fee_rules.platform_fee_basis_points does not exist` },
    });
    const res = await resolveFeeSchedule(client, "new");
    assert.equal(res.status, "read_failed");
    assert.match(
      res.status === "read_failed" ? res.message : "",
      /platform_fee_basis_points/,
    );
  });
});

// ── Arithmetic ───────────────────────────────────────────────────────────────

const RULE: FeeScheduleRule = {
  buddyLevel: "new",
  platformFeeBasisPoints: FLAT_COMMISSION_BASIS_POINTS,
  travelerServiceFeeUsd: 0,
  travelerServiceFeePct: 5,
  commissionOverrideApproval: null,
};

describe("fee arithmetic", () => {
  it("rounds the platform fee to cents", () => {
    assert.equal(platformFeeUsdFor(100, RULE), 10);
    assert.equal(platformFeeUsdFor(33.33, RULE), 3.33);
    assert.equal(platformFeeUsdFor(0, RULE), 0);
  });

  it("reads BOTH traveller fee columns — the M4 mismatch", () => {
    // Production carries _usd = 0.00 and _pct = 5.00 on all five rows. Reading
    // only _usd, as the ledger did, made the fee structurally 0 forever.
    assert.equal(travelerServiceFeeUsdFor(100, RULE), 5);
    assert.equal(
      travelerServiceFeeUsdFor(100, { ...RULE, travelerServiceFeeUsd: 2 }), 7,
      "a flat fee and a percentage are additive, as the admin screen presents them",
    );
    assert.equal(
      travelerServiceFeeUsdFor(100, { ...RULE, travelerServiceFeePct: 0 }), 0,
      "an operator who zeroes both columns gets zero",
    );
  });

  it("REFUSES a non-numeric booking total rather than pricing it at zero", () => {
    // This used to return 0 for a non-finite total. A zero fee computed from an
    // unreadable amount is the deleted 22 % literal's sibling: a money figure
    // that looks like a deliberate value. `null` forces the caller to decide.
    assert.equal(platformFeeUsdFor(Number("x"), RULE), null);
    assert.equal(travelerServiceFeeUsdFor(Number("x"), RULE), null);
    assert.equal(platformFeeUsdFor(-1, RULE), null);
  });
});

// ── Structure: the literals are gone and there is one pricing reader ─────────

/**
 * Comments are where the deleted literals are SUPPOSED to appear — this file
 * and both repaired modules name them to explain why they are gone. The scan
 * below must therefore see code only. Crude on purpose: a `//` inside a string
 * literal truncates that line, which for a two-identifier search is harmless
 * and is the trade that keeps this guard dependency-free.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("one take rate, one reader — read as text", () => {
  const files = walk(join(SRC, "lib")).concat(walk(join(SRC, "routes")));

  it("scans a non-trivial number of files, so the scan is not vacuous", () => {
    assert.ok(files.length > 50, `expected to scan src/lib + src/routes, found ${files.length} files`);
  });

  for (const literal of ["DEFAULT_PLATFORM_FEE_PERCENT", "defaultFeePercent", "EARNINGS_SUMMARY_FEE_PCT"]) {
    it(`no file reintroduces \`${literal}\``, () => {
      const hits = files
        .filter((f) => stripComments(readFileSync(f, "utf8")).includes(literal))
        .map((f) => relative(SRC, f));
      assert.deepEqual(
        hits, [],
        `${literal} is a hard-coded take rate. The schedule of record is ` +
        `${FEE_SCHEDULE_TABLE}, because it is the only one an operator can change ` +
        "without a deploy (`08` §2.3). Use resolveFeeSchedule and handle its " +
        "two failure states instead of defaulting to a number.",
      );
    });
  }

  it(`${FEE_SCHEDULE_TABLE} has exactly one pricing reader`, () => {
    // Admin routes that LIST or WRITE the schedule are not pricing readers; they
    // are the operator's editor. What must not exist twice is a path that
    // derives a booking's fee from this table.
    //
    // Keyed on EITHER rate column: the basis points are the rate of record and
    // the percent is the superseded mirror, and a second file touching either
    // one beside the table name is a second take rate in the making.
    const readers = files
      .filter((f) => {
        const src = stripComments(readFileSync(f, "utf8"));
        return src.includes(`"${FEE_SCHEDULE_TABLE}"`)
          && (src.includes("platform_fee_basis_points") || src.includes("platform_fee_percent"));
      })
      .map((f) => relative(SRC, f))
      .sort();

    assert.deepEqual(
      readers,
      ["lib/rentBuddyFeeSchedule.ts", "routes/rentABuddyMarketplace.ts"].sort(),
      "expected the resolver plus the admin fee-rules editor and nothing else. " +
      "A new file touching both the fee table and platform_fee_percent is a " +
      "second take rate in the making — route it through resolveFeeSchedule.",
    );
  });

  it("the ledger writer no longer touches the fee table directly", () => {
    const src = stripComments(readFileSync(join(SRC, "lib/rentBuddyEarningsLedger.ts"), "utf8"));
    assert.equal(
      src.includes(`.from("${FEE_SCHEDULE_TABLE}")`), false,
      "the ledger prices through resolveFeeSchedule so the refusal path cannot be bypassed",
    );
    assert.ok(src.includes("resolveFeeSchedule"), "the ledger must resolve the fee, not assume one");
  });
});

// ── Lane B's keying adopted (2026-10-07): the charge's commission policy IS the rate ──
//
// B's checkout takes the commission by (product, seller market) from
// commissionPolicy.ts; the estimate must say the same number. So a level row is
// a mirror of the policy: an APPROVED off-flat row the charge does not share is
// refused, a market-specific rule (which this estimate has no market for) is
// refused, and across every cent from $0.00 to $2,000.00 the estimate's rounding
// equals the charge's. Imports at the foot so no cited line moves.
import { COMMISSION_RULES, RAB_SERVICE_PRODUCT, commissionMinor, resolveCommission } from "../services/payments/bookingPayments/commissionPolicy.js";
import { applyBasisPoints as applyBps, estimateCommissionPolicy } from "../lib/rentBuddyFeeSchedule.js";

describe("the estimate's rate is the charge's (lane B's (product, seller market) keying)", () => {
  it("an APPROVED off-flat level row the charge does not share is refused — the estimate must equal the charge", async () => {
    const { client } = feeClient({ row: { platform_fee_basis_points: 1050, commission_override_approval: "owner-ruling-2026-10-04/market-xx" } });
    const res = await resolveFeeSchedule(client, "pro");
    assert.equal(res.status, "read_failed");
    assert.match(res.status === "read_failed" ? res.message : "", /the estimate must equal the charge/);
    assert.equal(Object.prototype.hasOwnProperty.call(res, "rule"), false, "no rate is carried out of a refusal");
  });
  it("control: the flat row under the owner's default policy resolves at the policy's 1000 bps", async () => {
    const { client } = feeClient({ row: { platform_fee_basis_points: 1000 } });
    const res = await resolveFeeSchedule(client, "pro");
    assert.equal(res.status, "resolved");
    assert.equal(res.status === "resolved" && res.rule.platformFeeBasisPoints, 1000);
  });
  it("a MARKET-specific commission rule makes the estimate refuse: it is not given the seller market the charge keys on", async () => {
    const rules = [...COMMISSION_RULES, { ...COMMISSION_RULES[0], market: "PH", bps: 1200, version: "fixture/ph-1200" }];
    const policy = estimateCommissionPolicy(rules);
    assert.equal(policy.ok, false);
    assert.match(policy.ok ? "" : policy.detail, /depends on the seller market \(PH have their own rules\)/);
    const { client } = feeClient({ row: { platform_fee_basis_points: 1000 } });
    assert.equal((await resolveFeeSchedule(client, "pro", rules)).status, "read_failed");
  });
  it("the owner's policy today: one `*` rule at 1000 bps, which every market's charge resolves to", () => {
    const policy = estimateCommissionPolicy();
    assert.deepEqual(policy, { ok: true, bps: 1000, version: "rab-commission/owner-2026-10-04/v1" });
    for (const m of ["US", "PH", "JP", "VN", "TH"]) {
      const r = resolveCommission(RAB_SERVICE_PRODUCT, m);
      assert.ok(r.ok && r.bps === policy.bps, m);
    }
  });
  it("rounding: for every cent $0.00..$2,000.00 at the policy's rate, the estimate (applyBasisPoints) equals the charge (commissionMinor)", () => {
    const policy = estimateCommissionPolicy();
    assert.ok(policy.ok);
    const bps = policy.ok ? policy.bps : -1;
    let checked = 0;
    for (let cents = 0; cents <= 200_000; cents++) {
      const estimate = applyBps(cents / 100, bps);
      const charge = commissionMinor(cents, bps);
      if (estimate === null || Math.round(estimate * 100) !== charge) {
        assert.fail(`${cents}c at ${bps} bps: estimate ${estimate} vs charge ${charge}c`);
      }
      checked++;
    }
    assert.equal(checked, 200_001);
  });
});

// ── The estimate-policy seam the fixture suites use cannot reach a hosted process ──
import { _setEstimateCommissionRulesForTest } from "../lib/rentBuddyFeeSchedule.js";

describe("the test-runner-only estimate-policy seam", () => {
  const AT_1500 = [{ ...COMMISSION_RULES[0], bps: 1500, version: "fixture/seam-1500" }];
  const approved1500 = () => feeClient({ row: { platform_fee_basis_points: 1500, commission_override_approval: "fixture-approved-override" } }).client;
  it("under the test runner a set policy is what the estimate reads; cleared, the owner's policy is back", async () => {
    _setEstimateCommissionRulesForTest(AT_1500);
    try {
      assert.equal((await resolveFeeSchedule(approved1500(), "pro")).status, "resolved");
    } finally { _setEstimateCommissionRulesForTest(null); }
    assert.equal((await resolveFeeSchedule(approved1500(), "pro")).status, "read_failed", "cleared: 1500 is not the charge");
  });
  it("a set policy is IGNORED in a production, deployment or dev-host environment", async () => {
    _setEstimateCommissionRulesForTest(AT_1500);
    const saved = { NODE_ENV: process.env["NODE_ENV"], REPLIT_DEPLOYMENT: process.env["REPLIT_DEPLOYMENT"], NODE_TEST_CONTEXT: process.env["NODE_TEST_CONTEXT"] };
    try {
      for (const hosted of [{ NODE_ENV: "production" }, { REPLIT_DEPLOYMENT: "1" }, { NODE_TEST_CONTEXT: undefined }] as Array<Record<string, string | undefined>>) {
        for (const [k, v] of Object.entries(hosted)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        try {
          assert.equal((await resolveFeeSchedule(approved1500(), "pro")).status, "read_failed", JSON.stringify(hosted));
        } finally {
          for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
      }
    } finally { _setEstimateCommissionRulesForTest(null); }
  });
  it("setting it outside the test runner throws", () => {
    const saved = process.env["NODE_TEST_CONTEXT"];
    delete process.env["NODE_TEST_CONTEXT"];
    try {
      assert.throws(() => _setEstimateCommissionRulesForTest(AT_1500), /only under the test runner/);
    } finally { if (saved !== undefined) process.env["NODE_TEST_CONTEXT"] = saved; }
    _setEstimateCommissionRulesForTest(null);
  });
});
