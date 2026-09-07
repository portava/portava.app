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
 * ── THE LIVE SCHEDULE (verified against production, 2026-09-07) ─────────────
 * `public.rent_buddy_fee_rules` holds its five seed rows — this is defect M10's
 * verification V2, and it is discharged:
 *
 *   buddy_level       platform_fee_percent  traveler_service_fee_usd  _pct
 *   new                              25.00                      0.00  5.00
 *   rising                           22.00                      0.00  5.00
 *   pro                              15.00                      0.00  5.00
 *   elite                            12.00                      0.00  5.00
 *   city_ambassador                  12.00                      0.00  5.00
 *
 * Those numbers are NOT asserted here. They are operator-editable without a
 * deploy — that is the entire reason the table is the schedule of record — so a
 * test that pinned them would convert a legitimate operator change into a red
 * build. What IS pinned is that whatever the row says is what the caller gets,
 * and that a missing or unreadable row yields no price at all.
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
  it("returns the row's own percentages, whatever they are", async () => {
    const { client } = feeClient({
      row: {
        buddy_level: "pro",
        platform_fee_percent: 15,
        traveler_service_fee_usd: 0,
        traveler_service_fee_pct: 5,
      },
    });
    const res = await resolveFeeSchedule(client, "pro");
    assert.equal(res.status, "resolved");
    assert.deepEqual(res.status === "resolved" ? res.rule : null, {
      buddyLevel: "pro",
      platformFeePercent: 15,
      travelerServiceFeeUsd: 0,
      travelerServiceFeePct: 5,
    });
  });

  it("queries the schedule of record, keyed on buddy_level", async () => {
    const { client, seen } = feeClient({ row: { platform_fee_percent: 12 } });
    await resolveFeeSchedule(client, "elite");
    assert.deepEqual(seen, [["buddy_level", "elite"]]);
    assert.equal(FEE_SCHEDULE_TABLE, "rent_buddy_fee_rules");
  });

  it("accepts numeric strings, which is how PostgREST returns numeric columns", async () => {
    const { client } = feeClient({
      row: { platform_fee_percent: "25.00", traveler_service_fee_usd: "0.00", traveler_service_fee_pct: "5.00" },
    });
    const res = await resolveFeeSchedule(client, "new");
    assert.equal(res.status, "resolved");
    assert.equal(res.status === "resolved" && res.rule.platformFeePercent, 25);
    assert.equal(res.status === "resolved" && res.rule.travelerServiceFeePct, 5);
  });

  it("treats a null/blank level as the column default, which HAS a row", async () => {
    const { client, seen } = feeClient({ row: { platform_fee_percent: 25 } });
    const res = await resolveFeeSchedule(client, null);
    assert.equal(res.status, "resolved");
    assert.deepEqual(seen, [["buddy_level", DEFAULT_BUDDY_LEVEL]]);
    assert.equal(DEFAULT_BUDDY_LEVEL, "new");
  });
});

// ── State 2: no_such_level ───────────────────────────────────────────────────

describe("resolveFeeSchedule — no_such_level", () => {
  it("does NOT invent a percentage when the level has no row", async () => {
    // 'standard' is accepted by PATCH /rent-a-buddy/admin/buddies/:id/level and
    // has never had a fee row (`08` §2.5). It used to silently mean 22 %.
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

  it("treats a present-but-unusable percentage as unknown, not as absent", async () => {
    // A row whose take rate is null/NaN/out-of-range is a BROKEN schedule for a
    // level that exists. Reporting it as 'no such level' would let a malformed
    // row read as a deliberate omission.
    for (const bad of [null, undefined, "", "abc", NaN, -1, 101]) {
      const { client } = feeClient({ row: { platform_fee_percent: bad } });
      const res = await resolveFeeSchedule(client, "new");
      assert.equal(res.status, "read_failed", `platform_fee_percent=${String(bad)} must not resolve`);
    }
  });

  it("has no client at all → read_failed, never a default", async () => {
    const res = await resolveFeeSchedule(null, "new");
    assert.equal(res.status, "read_failed");
  });
});

// ── Arithmetic ───────────────────────────────────────────────────────────────

const RULE: FeeScheduleRule = {
  buddyLevel: "new",
  platformFeePercent: 25,
  travelerServiceFeeUsd: 0,
  travelerServiceFeePct: 5,
};

describe("fee arithmetic", () => {
  it("rounds the platform fee to cents", () => {
    assert.equal(platformFeeUsdFor(100, RULE), 25);
    assert.equal(platformFeeUsdFor(33.33, RULE), 8.33);
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

  it("never produces NaN from a non-numeric booking total", () => {
    assert.equal(platformFeeUsdFor(Number("x"), RULE), 0);
    assert.equal(travelerServiceFeeUsdFor(Number("x"), RULE), 0);
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

  for (const literal of ["DEFAULT_PLATFORM_FEE_PERCENT", "defaultFeePercent"]) {
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
    const readers = files
      .filter((f) => {
        const src = stripComments(readFileSync(f, "utf8"));
        return src.includes(`"${FEE_SCHEDULE_TABLE}"`) && src.includes("platform_fee_percent");
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
