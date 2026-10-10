/**
 * Two owner decisions of 2026-10-04, proved by behaviour.
 *
 *   "Seed the `standard` Buddy level at the approved flat 10% commission so its
 *    fee routes work."
 *
 *   "Change `RENT_BUDDY_FEE_RULE_VERSION` to `/v2`. Preserve `/v1` for
 *    historical records and calculations."
 *
 * ── HOW THE SEED IS TESTED, AND WHY NOT BY READING THE SQL ──────────────────
 * There is no PostgreSQL in the local harness, so this file cannot EXECUTE
 * migration 3602. What it does instead is make the migration's seeded values
 * LOAD-BEARING THROUGH REAL CODE: the INSERT's column list and VALUES tuple are
 * parsed into a row object, that row is handed to the real `resolveFeeSchedule`
 * and the real `createEarningsLedgerEntry`, and the assertions are about what
 * those functions then do.
 *
 * The difference from a source scan is mutation sensitivity. A scan for
 * `/1000/` passes whether or not 1000 is the rate anything resolves. Here,
 * changing the seed to 1500 makes the parsed row an off-flat rate the charge
 * does not share, the real resolver REFUSES it, and the fee-route assertions fail — because the
 * number flows into the code under test rather than being looked at.
 *
 * What this file CANNOT prove, and does not claim to: that `ON CONFLICT DO
 * NOTHING` is idempotent and does not overwrite an operator's edit. Those are
 * PostgreSQL semantics and need a database. They are proved in
 * `src/test/db/rentBuddyStandardSeed.db.test.ts`, which runs in the live-DB CI
 * tier, and the migration asserts them about itself in its own postconditions.
 * The structural checks here are a backstop for that, not a substitute, and are
 * labelled as such.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyStandardSeedAndFeeRuleV2.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FLAT_COMMISSION_BASIS_POINTS,
  platformFeeUsdFor,
  resolveFeeSchedule,
} from "../lib/rentBuddyFeeSchedule.js";
import { createEarningsLedgerEntry } from "../lib/rentBuddyEarningsLedger.js";
import {
  RENT_BUDDY_FEE_RULE_VERSION,
  RENT_BUDDY_FEE_RULE_VERSION_V1,
  RENT_BUDDY_FEE_RULE_VERSION_V2,
  RENT_BUDDY_FEE_RULE_VERSIONS,
  isKnownRentBuddyFeeRuleVersion,
  toEarningsEntryRow,
} from "../lib/creatorLedgerRows.js";
import {
  buildBookingEntries,
  entriesAtRuleVersion,
  historicalBalanceAt,
  recomputeUnderRuleVersion,
} from "../lib/creatorLedgerEntries.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_FILE = "3602_rent_buddy_standard_level_commission_seed.sql";
const seedText = readFileSync(join(SRC, "migrations", SEED_FILE), "utf8");

/** The executable half. These files carry more prose than SQL, and the prose quotes SQL. */
const seedStatements = seedText
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

// ═══════════════════════════════════════════════════════════════════════════
// Turning the migration's INSERT into the row a database would hand back
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Column defaults from the schema of record
 * (`artifacts/api-server/baseline/20260819_baseline_structure.sql:9062#rent_buddy_fee_rules`),
 * plus 3601's two added columns. A column the seed omits takes its default, so
 * these are what the row ACTUALLY carries — modelling the seed without them
 * would test a row no database would ever return.
 */
const COLUMN_DEFAULTS: Record<string, unknown> = {
  buddy_level: undefined,            // NOT NULL, no default
  platform_fee_percent: undefined,   // NOT NULL, no default
  traveler_service_fee_usd: 0,       // DEFAULT 0 NOT NULL
  traveler_service_fee_pct: 0,       // DEFAULT 0 NOT NULL
  platform_fee_basis_points: undefined, // 3601: NOT NULL after backfill
};

interface ParsedSeed {
  columns: string[];
  values: unknown[];
  conflictAction: string;
  row: Record<string, unknown>;
}

/** Parse the single `INSERT INTO public.rent_buddy_fee_rules … ON CONFLICT …` statement. */
function parseSeed(): ParsedSeed {
  const m = seedStatements.match(
    /INSERT\s+INTO\s+public\.rent_buddy_fee_rules\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*(ON\s+CONFLICT[\s\S]*?)\s*;/i,
  );
  assert.ok(m, `${SEED_FILE}: no INSERT INTO public.rent_buddy_fee_rules … VALUES … ; found`);

  const columns = m[1].split(",").map((s) => s.trim());
  const values = m[2].split(",").map((s) => {
    const t = s.trim();
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^null$/i.test(t)) return null;
    return t;
  });
  assert.equal(
    columns.length, values.length,
    `${SEED_FILE}: ${columns.length} column(s) but ${values.length} value(s)`,
  );

  // The row as the database would return it: the seeded columns, and every
  // other column at its default.
  const row: Record<string, unknown> = {};
  for (const [c, d] of Object.entries(COLUMN_DEFAULTS)) row[c] = d;
  columns.forEach((c, i) => { row[c] = values[i]; });

  return { columns, values, conflictAction: m[3].replace(/\s+/g, " ").trim(), row };
}

const seed = parseSeed();
/** The level the migration prices. Read from the SQL, not assumed. */
const SEEDED_LEVEL = seed.row.buddy_level as string;

// ── A fake client answering the tables the fee path touches ──────────────────

interface Rec { table: string; op: string; payload: any }

function feeClient(
  opts: {
    /** The `rent_buddy_fee_rules` row for the level asked about; null = no row. */
    feeRow?: Record<string, unknown> | null;
    feeError?: any;
    buddy?: any;
    rentBuddyEnabled?: boolean;
  } = {},
) {
  const writes: Rec[] = [];
  const table = (t: string) => ({
    _t: t,
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return this; },
    upsert(payload: any) { writes.push({ table: this._t, op: "upsert", payload }); return this; },
    async then(res: (v: any) => void) {
      if (this._t === "rent_buddy_profiles") return res({ data: opts.buddy ?? null, error: null });
      if (this._t === "rent_buddy_fee_rules") {
        return res({ data: opts.feeRow ?? null, error: opts.feeError ?? null });
      }
      if (this._t === "feature_flags") {
        return res({ data: opts.rentBuddyEnabled ? { enabled: true } : null, error: null });
      }
      return res({ data: null, error: null });
    },
  });
  return { client: { from: (t: string) => table(t) }, writes };
}

const BOOKING = {
  id: "bk-standard-1",
  traveler_id: "traveller-1",
  total_usd: 200,
  deposit_usd: 0,
  cash_balance_usd: 200,
  tip_usd: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. `standard` resolves to 1000 basis points, and its fee routes now work
// ═══════════════════════════════════════════════════════════════════════════

describe("the seed prices 'standard' at the approved flat rate", () => {
  it("seeds the 'standard' level and no other", () => {
    assert.equal(SEEDED_LEVEL, "standard", "the owner priced 'standard'");
    const inserts = seedStatements.match(/INSERT\s+INTO/gi) ?? [];
    assert.equal(inserts.length, 1, "exactly one INSERT: this file seeds one level and nothing more");
  });

  it("the seeded row resolves — through the real resolver — to 1000 basis points", async () => {
    const { client } = feeClient({ feeRow: seed.row });
    const res = await resolveFeeSchedule(client, SEEDED_LEVEL);

    assert.equal(res.status, "resolved", `'${SEEDED_LEVEL}' must resolve, not refuse`);
    assert.equal(res.status === "resolved" && res.rule.platformFeeBasisPoints, 1000);
    assert.equal(
      res.status === "resolved" && res.rule.platformFeeBasisPoints,
      FLAT_COMMISSION_BASIS_POINTS,
      "the seeded rate IS the approved flat rate, not a second number that happens to match",
    );
    // 10 % of 200.
    assert.equal(platformFeeUsdFor(200, (res as any).rule), 20);
  });

  it("the seed writes exactly the rate, its mirror and the level — no approval column exists to write (P-6)", () => {
    assert.deepEqual(
      [...seed.columns].sort(), ["buddy_level", "platform_fee_basis_points", "platform_fee_percent"],
      `${SEED_FILE}'s column list is ${seed.columns.join(", ")}`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(seed.row, "commission_override_approval"), false,
      "lead ruling P-6 removed 3601's per-level approval column; the seeded row has none",
    );
  });

  it("the legacy percent mirror agrees with the basis points", () => {
    // 3601 asserts `platform_fee_percent = ROUND(bps/100)` for EVERY row, so a
    // seed that disagreed would make a later re-run of 3601 fail.
    assert.equal(seed.row.platform_fee_percent, Math.round(1000 / 100));
  });

  it("the traveller service fee is seeded at 0 — ruling R1 is unmade", () => {
    assert.ok(
      !seed.columns.includes("traveler_service_fee_pct") &&
      !seed.columns.includes("traveler_service_fee_usd"),
      "the seed must not set a traveller-side price: that is ruling R1 and it is unmade",
    );
    assert.equal(seed.row.traveler_service_fee_usd, 0);
    assert.equal(seed.row.traveler_service_fee_pct, 0);
  });

  it("the FEE ROUTE for a 'standard' buddy now succeeds, where it refused before", async () => {
    // The delta the seed makes, measured on the real ledger writer.
    const buddy = { user_id: "buddy-user-1", buddy_level: SEEDED_LEVEL };

    // BEFORE: no row for this level. Every fee route refuses — and writes nothing.
    const before = feeClient({ buddy, feeRow: null });
    const refused = await createEarningsLedgerEntry(before.client, BOOKING, "buddy-prof-1");
    assert.equal(refused.status, "fee_unresolved", "unpriced level must refuse");
    assert.equal((refused as any).reason, "no_such_level");
    assert.equal(before.writes.length, 0, "a refusal writes NO money record");

    // AFTER: the seeded row. The same call now prices the booking.
    const after = feeClient({ buddy, feeRow: seed.row });
    const written = await createEarningsLedgerEntry(after.client, BOOKING, "buddy-prof-1");
    assert.equal(written.status, "written", "a priced level must write its ledger row");
    assert.equal((written as any).platformFeeBasisPoints, 1000);

    const row = after.writes.find((w) => w.table === "rent_buddy_earnings_ledger")?.payload;
    assert.ok(row, "no summary row written");
    assert.equal(row.platform_fee_basis_points, 1000, "the rate is recorded losslessly");
    assert.equal(row.platform_fee_percent, 10, "the legacy mirror follows the basis points");
    assert.equal(row.platform_fee_amount, 20, "10 % of a $200 booking");
    assert.equal(row.buddy_net_estimated_amount, 180);
    assert.equal(row.is_estimated, true, "still an estimate: no money moved");
    assert.equal(row.in_app_amount_collected, 0, "Portava collected nothing");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The seed is additive and cannot overwrite — STRUCTURAL BACKSTOP ONLY
// ═══════════════════════════════════════════════════════════════════════════
//
// The executable proof is src/test/db/rentBuddyStandardSeed.db.test.ts, which
// needs PostgreSQL. These assertions are about the SHAPE of the statement and
// are honest about being so: they catch a `DO UPDATE` being introduced, which is
// the one mutation that would turn this seed into a rate-resetter.

describe("the seed is a seed, not a reset (structural; executable proof is the .db test)", () => {
  it("resolves the conflict with DO NOTHING, never DO UPDATE", () => {
    assert.match(
      seed.conflictAction, /DO\s+NOTHING$/i,
      `conflict action is "${seed.conflictAction}". DO UPDATE would silently revert an ` +
      "operator's later, deliberate rate edit on every re-run of this migration.",
    );
    assert.ok(
      !/DO\s+UPDATE/i.test(seedStatements),
      "no DO UPDATE anywhere in the file",
    );
  });

  it("targets the unique key that is a level's identity", () => {
    assert.match(seed.conflictAction, /rent_buddy_fee_rules_buddy_level_key/);
  });

  it("issues no UPDATE and no DELETE against the schedule at all", () => {
    assert.ok(
      !/\bUPDATE\s+public\.rent_buddy_fee_rules\b/i.test(seedStatements),
      "an UPDATE against the schedule would make this file able to re-rate a level",
    );
    assert.ok(
      !/\bDELETE\s+FROM\s+public\.rent_buddy_fee_rules\b/i.test(seedStatements),
      "this file deletes nothing",
    );
  });

  it("does not touch the CHECK 3601 installed", () => {
    for (const c of ["rbfr_basis_points_range"]) {
      assert.ok(
        !new RegExp(`DROP\\s+CONSTRAINT[^;]*${c}`, "i").test(seedStatements),
        `${c} must not be dropped`,
      );
      assert.ok(
        !new RegExp(`ADD\\s+CONSTRAINT\\s+${c}`, "i").test(seedStatements),
        `${c} must not be re-stated here — 3601 owns it`,
      );
    }
  });

  it("refuses rather than skips when 3601 has not run", () => {
    // A precondition that is not met must be a REFUSAL. Silently doing nothing
    // would leave 'standard' unpriced on a database an operator believes was
    // seeded — the fee routes would still refuse, with nothing saying why.
    //
    // SCOPED TO THE PRECONDITION BLOCK. A whole-file search for
    // /platform_fee_basis_points[\s\S]*RAISE EXCEPTION/ also matches the
    // postconditions at the far end of the file, and SURVIVES the precondition
    // being replaced by a bare RETURN — that mutation was run against the loose
    // form and lived. Hence the narrowing.
    const blocks = seedStatements.match(/DO \$\$[\s\S]*?END \$\$;/g) ?? [];
    assert.ok(blocks.length >= 2, `expected a precondition and a postcondition block, found ${blocks.length}`);

    const pre = blocks.find((b) => /platform_fee_basis_points[\s\S]*does not exist/.test(b));
    assert.ok(pre, "no precondition block checks for 3601's basis-point column");

    // The guard on the column's absence must END IN A RAISE, with no control
    // flow in it that could carry the apply past the missing column.
    const guard = pre.match(
      /IF NOT EXISTS \([\s\S]*?platform_fee_basis_points[\s\S]*?\) THEN([\s\S]*?)END IF;/,
    );
    assert.ok(guard, "the basis-point check is not an IF NOT EXISTS … THEN … END IF guard");
    assert.match(
      guard[1]!, /RAISE\s+EXCEPTION/i,
      "the precondition must RAISE when 3601 has not run; a RETURN or a NOTICE would let the " +
      "apply report success having seeded nothing",
    );
    assert.ok(
      !/\bRETURN\b/i.test(guard[1]!),
      "a RETURN inside the guard turns the refusal into a silent skip",
    );
    assert.match(guard[1]!, /3601/, "the refusal must name the file an operator has to apply first");
    assert.match(seedText, /PRECONDITION FAILED/);
  });

  it("asserts about itself that a pre-existing row was not modified", () => {
    // The migration's own postcondition is the re-run guarantee; this checks it
    // is actually present, because a postcondition nobody wrote proves nothing.
    // The snapshot, the INSERT and the comparison share ONE DO block, so the
    // comparison runs in the applying transaction and never reads a temp table
    // or session state another request left behind (certify stage 4 re-runs
    // assertion-only blocks on their own; check:migration-session-state).
    const blocks = seedStatements.match(/DO \$\$[\s\S]*?END \$\$;/g) ?? [];
    const seedBlock = blocks.find((b) => /INSERT\s+INTO\s+public\.rent_buddy_fee_rules/i.test(b));
    assert.ok(seedBlock, "the INSERT is not inside the block that proves it changed nothing else");
    assert.match(seedBlock, /v_before[\s\S]*INSERT\s+INTO[\s\S]*was MODIFIED/);
    assert.match(seedBlock, /no business touching/);
    assert.match(seedBlock, /This file deletes nothing/);
    assert.ok(!/\bTEMP(ORARY)?\s+TABLE\b|pg_temp|set_config|current_setting/i.test(seedStatements),
      "no session state: every block must stand on its own request");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. New entries carry /v2
// ═══════════════════════════════════════════════════════════════════════════

describe("new entries are stamped /v2", () => {
  it("the current version IS /v2, and /v1 is still named", () => {
    assert.equal(RENT_BUDDY_FEE_RULE_VERSION, "rent-buddy-fee-schedule/v2");
    assert.equal(RENT_BUDDY_FEE_RULE_VERSION, RENT_BUDDY_FEE_RULE_VERSION_V2);
    assert.equal(RENT_BUDDY_FEE_RULE_VERSION_V1, "rent-buddy-fee-schedule/v1");
    assert.notEqual(RENT_BUDDY_FEE_RULE_VERSION_V1, RENT_BUDDY_FEE_RULE_VERSION_V2);
    assert.deepEqual([...RENT_BUDDY_FEE_RULE_VERSIONS], [
      RENT_BUDDY_FEE_RULE_VERSION_V1,
      RENT_BUDDY_FEE_RULE_VERSION_V2,
    ], "oldest first");
    assert.equal(isKnownRentBuddyFeeRuleVersion(RENT_BUDDY_FEE_RULE_VERSION_V1), true);
    assert.equal(isKnownRentBuddyFeeRuleVersion(RENT_BUDDY_FEE_RULE_VERSION_V2), true);
    assert.equal(
      isKnownRentBuddyFeeRuleVersion("rent-buddy-fee-schedule/v3"), false,
      "an unknown version is not silently treated as current",
    );
  });

  it("the ledger writer stamps /v2 on the rows it appends", async () => {
    const { client, writes } = feeClient({
      buddy: { user_id: "buddy-user-1", buddy_level: SEEDED_LEVEL },
      feeRow: seed.row,
    });
    const res = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.equal(res.status, "written");

    const entries = writes.find((w) => w.table === "rent_buddy_earnings_entries")?.payload;
    assert.ok(Array.isArray(entries) && entries.length > 0, "no entries appended");
    for (const e of entries) {
      assert.equal(e.rule_version, RENT_BUDDY_FEE_RULE_VERSION_V2, "every new entry is /v2");
      assert.match(
        e.transaction_key, /rent-buddy-fee-schedule\/v2$/,
        "the version is part of the transaction key, so /v2 cannot collide with /v1",
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. A /v1 entry is still readable, and still recomputes under /v1
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the substance of "preserve /v1 for historical records and
// calculations". /v1 was the per-level ladder — 'new' was 25 % — so a /v1
// booking is priced at 25 % and must STILL read back as 25 %.

const V1_BOOKING = {
  bookingId: "bk-historical-1",
  beneficiaryUserId: "buddy-user-1",
  totalUsd: 200,
  tipUsd: 0,
  travelerServiceFeeUsd: 0,
  collectedMinor: 0,
};

function v1Entries() {
  const built = buildBookingEntries({
    ...V1_BOOKING,
    ruleVersion: RENT_BUDDY_FEE_RULE_VERSION_V1,
    platformFeeUsd: 50, // the /v1 ladder: 25 % of 200
  });
  assert.equal(built.status, "built");
  return (built as any).entries;
}

describe("a /v1 entry survives the cutover, readable and recomputable", () => {
  it("is still selectable BY VERSION after /v2 becomes current", () => {
    const v1 = v1Entries();
    const v2built = buildBookingEntries({
      ...V1_BOOKING,
      ruleVersion: RENT_BUDDY_FEE_RULE_VERSION,
      platformFeeUsd: 20, // /v2: flat 10 % of 200
    });
    assert.equal(v2built.status, "built");
    const all = [...v1, ...(v2built as any).entries];

    const justV1 = entriesAtRuleVersion(all, RENT_BUDDY_FEE_RULE_VERSION_V1);
    assert.equal(justV1.length, v1.length, "every /v1 entry is still there and still findable");
    assert.deepEqual(justV1, v1, "and byte-for-byte unchanged by /v2's arrival");

    const justV2 = entriesAtRuleVersion(all, RENT_BUDDY_FEE_RULE_VERSION_V2);
    assert.equal(justV2.length, (v2built as any).entries.length);
    assert.ok(justV2.length > 0, "the /v2 read is not vacuous");
  });

  it("/v2 entries cannot collide with /v1 entries for the same booking", () => {
    const v1 = v1Entries();
    const v2 = (buildBookingEntries({
      ...V1_BOOKING,
      ruleVersion: RENT_BUDDY_FEE_RULE_VERSION,
      platformFeeUsd: 20,
    }) as any).entries;

    const k1 = new Set(v1.map((e: any) => e.transactionKey));
    const k2 = new Set(v2.map((e: any) => e.transactionKey));
    for (const k of k2) {
      assert.ok(!k1.has(k), `transaction key ${k} is shared across versions — /v2 would displace /v1`);
    }
    const i1 = new Set(v1.map((e: any) => e.idempotencyKey));
    for (const e of v2) {
      assert.ok(
        !i1.has(e.idempotencyKey),
        "idempotency keys collide across versions, so the append-only upsert would DO NOTHING and lose /v2",
      );
    }
  });

  it("recomputes to the SAME /v1 answer it was written with", () => {
    const v1 = v1Entries();
    // 25 % of 200 = 50 debited from the buddy: 20000 - 5000 = 15000 minor.
    const v1Balance = historicalBalanceAt(v1, RENT_BUDDY_FEE_RULE_VERSION_V1);
    assert.equal(v1Balance.buddy_payable, 15000, "the /v1 ladder priced this booking at 25 %");
    assert.equal(v1Balance.platform_revenue, 5000);

    // Now the booking is recomputed under /v2 — the real §10 path.
    const re = recomputeUnderRuleVersion(v1, {
      attributionId: V1_BOOKING.bookingId,
      ruleVersion: RENT_BUDDY_FEE_RULE_VERSION,
      next: { ...V1_BOOKING, ruleVersion: RENT_BUDDY_FEE_RULE_VERSION, platformFeeUsd: 20 },
    });
    assert.equal(re.status, "recomputed", (re as any).detail);
    const all = [...v1, ...(re as any).entries];

    // THE PRESERVATION PROPERTY: the historical answer is unchanged.
    assert.deepEqual(
      historicalBalanceAt(all, RENT_BUDDY_FEE_RULE_VERSION_V1), v1Balance,
      "the /v1 answer must still be recomputable AFTER a /v2 recomputation — that is what " +
      "'preserve /v1 for historical records and calculations' means",
    );
    // And /v2 states the new answer: 10 % of 200 = 20 ⇒ 18000 minor.
    const v2Balance = historicalBalanceAt(all, RENT_BUDDY_FEE_RULE_VERSION_V2);
    assert.equal(v2Balance.buddy_payable, 18000, "/v2 prices the same booking at the flat 10 %");
    assert.equal(v2Balance.platform_revenue, 2000);
    assert.notDeepEqual(v1Balance, v2Balance, "the two generations say different things, as they must");
  });

  it("refuses to recompute a booking into the version it is already at", () => {
    const v1 = v1Entries();
    const re = recomputeUnderRuleVersion(v1, {
      attributionId: V1_BOOKING.bookingId,
      ruleVersion: RENT_BUDDY_FEE_RULE_VERSION_V1,
      next: { ...V1_BOOKING, ruleVersion: RENT_BUDDY_FEE_RULE_VERSION_V1, platformFeeUsd: 50 },
    });
    assert.equal(re.status, "refused");
    assert.equal((re as any).reason, "same_rule_version");
  });

  it("a /v1 row maps to its table row carrying /v1, not today's version", () => {
    const v1 = v1Entries();
    const rows = v1.map((e: any) => toEarningsEntryRow(e, V1_BOOKING.bookingId));
    for (const r of rows) {
      assert.equal(
        r.rule_version, RENT_BUDDY_FEE_RULE_VERSION_V1,
        "the stored version is the entry's own generation — attribution needs no outside knowledge",
      );
      assert.notEqual(r.rule_version, RENT_BUDDY_FEE_RULE_VERSION);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. An unreadable fee rule still REFUSES — the seed did not create a default
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the risk the seed introduces. Now that 'standard' is "known to be
// 1000", the tempting defect is to treat an unreadable rate as 1000. A fee
// computed from a failed read is money.

describe("an unreadable fee rule refuses — never 1000, never 0", () => {
  const unreadable: Array<[string, any]> = [
    ["the table errored", { feeError: { message: "permission denied" } }],
    ["3601 has not run", { feeError: { message: 'column "platform_fee_basis_points" does not exist' } }],
    ["the rate is NULL", { feeRow: { ...seed.row, platform_fee_basis_points: null } }],
    ["the rate is not a number", { feeRow: { ...seed.row, platform_fee_basis_points: "ten percent" } }],
    ["the rate is a fractional basis point", { feeRow: { ...seed.row, platform_fee_basis_points: 1000.5 } }],
    ["the rate is out of range", { feeRow: { ...seed.row, platform_fee_basis_points: 10001 } }],
  ];

  for (const [name, opts] of unreadable) {
    it(`${name}: the resolver says read_failed, for 'standard' like any level`, async () => {
      const { client } = feeClient(opts);
      const res = await resolveFeeSchedule(client, SEEDED_LEVEL);
      assert.equal(res.status, "read_failed", `'${SEEDED_LEVEL}' must not acquire a rate from a failed read`);
      assert.equal(
        Object.prototype.hasOwnProperty.call(res, "rule"), false,
        "a failed read carries no rate at all",
      );
    });

    it(`${name}: the fee route writes NO money record`, async () => {
      const { client, writes } = feeClient({
        ...opts,
        buddy: { user_id: "buddy-user-1", buddy_level: SEEDED_LEVEL },
      });
      const res = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
      assert.notEqual(res.status, "written", "an unreadable rate must never produce a priced row");
      assert.equal(res.status, "fee_unresolved");
      assert.equal((res as any).reason, "read_failed");
      assert.equal(writes.length, 0, "nothing is appended and no summary row is written");
    });
  }

  it("an off-flat 'standard' row the charge does not share is refused, not rounded to the flat rate", async () => {
    const { client } = feeClient({
      feeRow: { ...seed.row, platform_fee_basis_points: 1500 },
    });
    const res = await resolveFeeSchedule(client, SEEDED_LEVEL);
    assert.equal(res.status, "read_failed");
    assert.match((res as any).message, /the estimate must equal the charge/);
  });

  it("a level with no row still refuses — the seed closed one hole, not the state", async () => {
    const { client } = feeClient({ feeRow: null });
    const res = await resolveFeeSchedule(client, "a_level_an_operator_invented");
    assert.equal(res.status, "no_such_level");
    assert.equal(
      Object.prototype.hasOwnProperty.call(res, "rule"), false,
      "no_such_level must remain a refusal and not become a rate",
    );
  });
});

// ── THE CASE ANOTHER RULE WOULD OTHERWISE EXCUSE (re-stated for lead ruling P-6, 2026-10-08) ──
// Found by mutation: making the rate normaliser return 0 instead of null for an
// unusable value SURVIVED the unreadable cases above, because 0 is not the
// charge's rate and the policy-mismatch refusal caught it on the way past.
// Before P-6 the escape was a row carrying an approval; now it is a charge whose
// policy happens to be 0 bps — a free-commission promotion, say. Then the
// policy check does not fire, so an unreadable rate would resolve as a
// deliberate 0 % and the booking would be priced at no commission at all. The
// rate being unreadable has to refuse on its own, not as a side effect of
// another rule. Imports at the foot so no cited line moves.
import { _setEstimateCommissionRulesForTest } from "../lib/rentBuddyFeeSchedule.js";
import { COMMISSION_RULES } from "../services/payments/bookingPayments/commissionPolicy.js";

describe("an unreadable rate refuses on its own, even when the charge's policy is 0 bps", () => {
  const AT_ZERO = [{ ...COMMISSION_RULES[0], bps: 0, version: "fixture/charge-at-0" }];
  for (const [name, bad] of [["NULL", null], ["unparseable", "zero"]] as const) {
    it(`the rate is ${name} while the charge is 0 bps: read_failed, and the fee route writes no money record`, async () => {
      _setEstimateCommissionRulesForTest(AT_ZERO);
      try {
        const r = await resolveFeeSchedule(feeClient({ feeRow: { ...seed.row, platform_fee_basis_points: bad } }).client, SEEDED_LEVEL);
        assert.equal(r.status, "read_failed", "an unreadable rate must not resolve as 0 %");
        const { client, writes } = feeClient({
          feeRow: { ...seed.row, platform_fee_basis_points: bad },
          buddy: { user_id: "buddy-user-1", buddy_level: SEEDED_LEVEL },
        });
        const res = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
        assert.equal(res.status, "fee_unresolved");
        assert.equal(writes.length, 0, "nothing is appended and no summary row is written");
      } finally { _setEstimateCommissionRulesForTest(null); }
    });
  }
  it("control: a READABLE 0 bps row under a 0 bps charge resolves (the refusal above is about readability)", async () => {
    _setEstimateCommissionRulesForTest(AT_ZERO);
    try {
      const r = await resolveFeeSchedule(feeClient({ feeRow: { ...seed.row, platform_fee_basis_points: 0 } }).client, SEEDED_LEVEL);
      assert.equal(r.status, "resolved");
    } finally { _setEstimateCommissionRulesForTest(null); }
  });
});
