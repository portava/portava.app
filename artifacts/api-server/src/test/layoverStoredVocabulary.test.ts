/**
 * The layover decision record's stored vocabularies: what each writer CAN send
 * against what the CHECK it writes into admits (census-layover §73, migration
 * 3792).
 *
 * THE DEFECT THIS PINS SHUT. 2700's `layover_certified_computations.verdict`
 * CHECK listed four verdicts. The engine's union gained `entry_unverified` on
 * 2026-09-22 (LayoverSafetyEngine.ts:1204, returned at :1397 for every roomy
 * layover whose entry corridor is unconfirmed, which is every roomy layover
 * while `entry_requirements` is uncurated). `ledgerRowFor` sends the verdict
 * unmapped (layoverLedger.ts:513), so once 2700 and 2992 are applied and
 * `layover_decision_persistence_enabled` is ON, `persistDecision` would have
 * failed the CHECK and stored nothing for those sessions. No test saw it,
 * because `fakeLayoverDb` models no CHECK and no database suite wrote the table.
 *
 * HOW THIS CANNOT RECUR. Neither side below is a list somebody maintains:
 *   - the writer's vocabulary is read from the program by the TypeScript checker
 *     (`ReturnType<typeof ledgerRowFor>["verdict"]`), so a sixth verdict appears
 *     here the moment the engine's union gains it;
 *   - the database's vocabulary is read from the NEWEST migration that states the
 *     CHECK, so a widening is checked without editing this file.
 * A sixth verdict is therefore red here until a migration admits it.
 *
 * THE SWEEP. The same comparison runs for every other enumerated CHECK on the
 * 2700 and 2992 tables, against the value each table's writer actually sends.
 * The writers are found by scanning production code, and the set is pinned, so
 * a new writer has to join the sweep. The range CHECKs (`>= 0`, `<=` between
 * two instants) are swept over a grid of real certified records. All of them
 * hold today; the verdict was the only defect.
 *
 * The real database answer is src/test/db/layoverCertifiedVerdict.db.test.ts,
 * which stores a decision for each of the five verdicts on the replayed chain.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/layoverStoredVocabulary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MIGRATIONS_DIR,
  newestCheckVocabulary,
  writeSites,
  writerVocabulary,
} from "./helpers/layoverStoredVocabulary.js";
import { ledgerRowFor } from "../services/airport/layoverLedger.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "../services/airport/LayoverFeasibility.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import {
  certifiedComputationRowFor,
  returnPlanRowFor,
  timeBudgetRowFor,
} from "../services/layover/LayoverDecisionStore.js";
import { recordTravellerCheckpoint } from "../services/layover/LayoverCheckpointStore.js";
import { layoverOutcomeRow } from "../services/layover/LayoverOutcomeStore.js";
import { insertConstraintVersion } from "../services/layover/LayoverConstraintStore.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";

const CERTIFIED = "layover_certified_computations";
const TABLES = [
  CERTIFIED,
  "layover_time_budgets",
  "layover_return_plans",
  "layover_constraints",
  "layover_checkpoints",
  "layover_outcomes",
] as const;
const THIS_MIGRATION = "3792_layover_certified_verdict_admits_entry_unverified.sql";

const minus = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x)).sort();

// ── real certified records, one per scenario ────────────────────────────────

const HOUR = 3_600_000;
/** 10:00 Asia/Taipei: off every time-of-day band. */
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const AIRPORT: FeasibilityAirport = {
  id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
  domesticBufferMin: 60, internationalBufferMin: 120,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
};
const PERMITTED: EntryEligibility = {
  state: "permitted", corridor: { passportCountry: "NZ", destinationCountry: "TW" }, status: "visa_free",
};
const UNCURATED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };

function session(hours: number, over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-1",
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

function certify(hours: number, entry: EntryEligibility | null, over: Partial<FeasibilitySession> = {}, at = NOW) {
  return certifySessionFeasibility(AIRPORT, session(hours, over), { nowMs: at, entry });
}

/** A record the engine itself certified as `entry_unverified`: eleven hours, an uncurated corridor. */
function roomyUnverified(): LayoverFeasibilityRecord {
  const r = certify(11, UNCURATED);
  assert.equal(r.verdict, "entry_unverified", "fixture: an eleven-hour layover with an uncurated corridor");
  return r;
}

// ── 1. the verdict ──────────────────────────────────────────────────────────

describe("layover_certified_computations.verdict: the CHECK admits every verdict its writer can send (3792)", () => {
  it("the writer's verdict type IS the engine's union, read by the compiler, and it includes entry_unverified", () => {
    const engine = writerVocabulary("EngineVerdict");
    const writer = writerVocabulary("CertifiedRowVerdict");
    assert.deepEqual(writer, engine, "ledgerRowFor's verdict is no longer the engine's union: re-derive what the column receives");
    assert.ok(engine.includes("entry_unverified"), "non-vacuous: the member 2700 missed is in the union");
    assert.ok(engine.length >= 5, `the union has ${engine.length} member(s)`);
  });

  it("the payload carries the verdict UNMAPPED, for every member, through the full post-2992 row", () => {
    // This is why the CHECK is the place that must admit the union: nothing
    // between the engine and the INSERT translates it.
    const base = roomyUnverified();
    for (const v of writerVocabulary("EngineVerdict")) {
      const rec = { ...base, verdict: v } as LayoverFeasibilityRecord;
      assert.equal(ledgerRowFor("u", "s", rec).verdict, v);
      assert.equal(certifiedComputationRowFor("u", "s", rec).verdict, v);
    }
    assert.equal(certifiedComputationRowFor("u", "s", roomyUnverified()).verdict, "entry_unverified");
  });

  it("the NEWEST migration stating the CHECK admits every verdict the writer can send", () => {
    const check = newestCheckVocabulary(CERTIFIED, "verdict");
    assert.deepEqual(
      minus(writerVocabulary("CertifiedRowVerdict"), check.values),
      [],
      `${check.file}'s verdict CHECK refuses verdicts the engine produces; persistDecision would fail on them`,
    );
    assert.equal(check.nullable, false);
  });

  it("...and admits nothing the engine cannot produce (a retired verdict must be argued, not left in silently)", () => {
    // Narrowing the CHECK when a verdict retires would fail on stored rows, so a
    // retired member belongs in this list with its reason; it is empty today.
    const RETIRED: string[] = [];
    const check = newestCheckVocabulary(CERTIFIED, "verdict");
    assert.deepEqual(minus(check.values, [...writerVocabulary("CertifiedRowVerdict"), ...RETIRED]), []);
  });

  it("3792 is that migration; without it the reader sees 2700's four and names entry_unverified as refused", () => {
    assert.equal(newestCheckVocabulary(CERTIFIED, "verdict").file, THIS_MIGRATION);
    // POSITIVE CONTROL: the same reader over the tree WITHOUT 3792 finds the
    // defect, so the assertion above is not satisfied by a reader that cannot see.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lay2700-"));
    try {
      for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
        if (f.endsWith(".sql") && f !== THIS_MIGRATION) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
      }
      const before = newestCheckVocabulary(CERTIFIED, "verdict", dir);
      assert.equal(before.file, "2700_layover_certified_feasibility.sql");
      assert.deepEqual(before.values, ["no", "stay_airside", "tight", "yes"]);
      assert.deepEqual(minus(writerVocabulary("CertifiedRowVerdict"), before.values), ["entry_unverified"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3792 refuses on a database without 2700 by naming it, and says it is pressed with 2700 and 2992 before the flip", () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, THIS_MIGRATION), "utf8");
    const pre = /DO \$pre\$[\s\S]*?END \$pre\$;/.exec(sql)?.[0] ?? "";
    assert.match(pre, /to_regclass\('public\.layover_certified_computations'\) IS NULL/);
    assert.match(pre, /RAISE EXCEPTION 'PRECONDITION FAILED \(3792\): [^']*2700_layover_certified_feasibility\.sql has not been applied/);
    assert.match(pre, /pressed WITH 2700 and 2992/);
    assert.match(pre, /before layover_decision_persistence_enabled is turned on/);
    // It never creates the table it alters.
    assert.doesNotMatch(sql.replace(/^\s*--.*$/gm, ""), /CREATE\s+TABLE/i);
  });
});

// ── 2. the sweep ────────────────────────────────────────────────────────────

describe("the sweep: every enumerated CHECK on the 2700/2992 tables admits what its writer sends", () => {
  it("the write sites are exactly the six this sweep covers, each with a literal table name", () => {
    const { sites, dynamicFroms } = writeSites(TABLES, [
      "CERTIFIED_COMPUTATION_TABLE", "TIME_BUDGET_TABLE", "RETURN_PLAN_TABLE",
    ]);
    assert.deepEqual(dynamicFroms, [], "a .from(CONSTANT) write is invisible to this sweep and to check:write-path-columns");
    assert.deepEqual(
      sites.map((s) => `${s.table} ${s.verb} ${s.payload} @ ${s.file}`).sort(),
      [
        "layover_certified_computations insert certifiedComputationRowFor( @ services/layover/LayoverDecisionStore.ts",
        "layover_checkpoints insert row @ services/layover/LayoverCheckpointStore.ts",
        "layover_constraints insert { @ services/layover/LayoverConstraintStore.ts",
        "layover_outcomes upsert row @ services/layover/LayoverOutcomeStore.ts",
        "layover_return_plans insert returnPlanRowFor( @ services/layover/LayoverDecisionStore.ts",
        "layover_time_budgets insert timeBudgetRowFor( @ services/layover/LayoverDecisionStore.ts",
      ],
      "a new writer of a 2700/2992 table must join this sweep",
    );
  });

  // [table, column, the writer's vocabulary as the compiler reads it]
  const TYPED: Array<[string, string, Parameters<typeof writerVocabulary>[0]]> = [
    [CERTIFIED, "confidence", "CertifiedRowConfidence"],
    [CERTIFIED, "buffer_percentile", "CertifiedRowBufferPercentile"],
    ["layover_time_budgets", "buffer_percentile", "RecordBufferPercentile"],
    ["layover_return_plans", "confidence", "RecordConfidence"],
    ["layover_return_plans", "risk_band", "RiskBand"],
    ["layover_constraints", "baggage_mode", "BaggageMode"],
    ["layover_constraints", "entry_permission_state", "EntryPermission"],
    ["layover_checkpoints", "checkpoint_type", "CheckpointType"],
    ["layover_outcomes", "boarding_outcome", "OutcomeBoarding"],
  ];
  for (const [table, column, alias] of TYPED) {
    it(`${table}.${column} admits every ${alias}`, () => {
      const check = newestCheckVocabulary(table, column);
      assert.deepEqual(minus(writerVocabulary(alias), check.values), [], `${check.file}'s CHECK refuses values the writer can send`);
    });
  }

  it("risk_band is NULL for stay_airside and the CHECK allows NULL; every other band is one the CHECK lists", () => {
    assert.equal(newestCheckVocabulary("layover_return_plans", "risk_band").nullable, true);
    const airside = certify(11, PERMITTED, { wantsToLeave: false });
    assert.equal(airside.verdict, "stay_airside");
    assert.equal(returnPlanRowFor("snap:x", "s", airside).risk_band, null);
    assert.equal(returnPlanRowFor("snap:x", "s", roomyUnverified()).risk_band, "MODERATE");
  });

  it("the children pass the record's values through: time budget percentile, return plan confidence", () => {
    const r = roomyUnverified();
    assert.equal(timeBudgetRowFor("snap:x", "s", r).buffer_percentile, r.inputs.bufferPercentile);
    assert.equal(returnPlanRowFor("snap:x", "s", r).confidence, r.confidence);
  });

  it("layover_checkpoints: the store's literal source and confidence are values the CHECK lists", async () => {
    const tables: Record<string, Record<string, unknown>[]> = {
      feature_flags: [{ flag: "layover_decision_persistence_enabled", enabled: true }],
      layover_checkpoints: [],
    };
    const out = await recordTravellerCheckpoint(makeLayoverDb(tables) as never, {
      sessionId: "s", type: "LANDSIDE_EXIT", operationId: "op-1", nowMs: NOW, departureTime: new Date(NOW + 6 * HOUR).toISOString(),
    });
    assert.ok(out.ok, JSON.stringify(out));
    const row = tables.layover_checkpoints![0]!;
    assert.ok(newestCheckVocabulary("layover_checkpoints", "source").values.includes(String(row.source)), String(row.source));
    assert.ok(newestCheckVocabulary("layover_checkpoints", "confidence").values.includes(String(row.confidence)), String(row.confidence));
    const key = String(row.dedup_key);
    assert.ok(key.length >= 1 && key.length <= 200, "2992: dedup_key length BETWEEN 1 AND 200");
  });

  it("layover_outcomes: both close outcomes write a boarding_outcome the CHECK lists, and nothing it would refuse", () => {
    const listed = newestCheckVocabulary("layover_outcomes", "boarding_outcome").values;
    for (const o of ["completed", "cancelled"] as const) {
      const row = layoverOutcomeRow("s", o, NOW, { leftAirport: true, actualAirportReturnAt: new Date(NOW - 60_000).toISOString() });
      assert.ok(listed.includes(String(row.boarding_outcome)), `${o} -> ${String(row.boarding_outcome)}`);
      assert.ok(!("anonymization_state" in row), "not sent: 2992's default 'IDENTIFIED' applies");
      // layover_outcomes_return_not_after_completion
      if (row.completed_at !== null) assert.ok(Date.parse(String(row.actual_airport_return_at)) <= Date.parse(String(row.completed_at)));
    }
  });

  it("layover_constraints: the store sends only CHECKed columns it owns; the rest take 2992's listed defaults", async () => {
    const tables: Record<string, Record<string, unknown>[]> = { layover_constraints: [] };
    const out = await insertConstraintVersion(makeLayoverDb(tables) as never, {
      sessionId: "s",
      set: { version: 1, baggageMode: "UNKNOWN", recheckRequired: null, airportChangeRequired: null },
      snapshotId: null, entryPermissionState: "UNKNOWN", criticalUnknowns: [],
    });
    assert.ok(out.ok, JSON.stringify(out));
    const row = tables.layover_constraints![0]!;
    for (const unsent of ["mobility_profile", "buffer_profile", "arrival_terminal", "departure_terminal", "minimum_boarding_buffer_min"]) {
      assert.ok(!(unsent in row) || row[unsent] === undefined, `${unsent} is sent; sweep its CHECK`);
    }
    assert.ok(Number(row.version) >= 1, "2992: version >= 1");
  });

  it("the range CHECKs hold over a grid of real certified records (>= 0, integers, recommended <= hard)", () => {
    let n = 0;
    const verdicts = new Set<string>();
    for (const hours of [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 11, 14, 20]) {
      for (const flight of [{}, { flightType: "domestic" as const, immigrationRequired: false }]) {
        for (const extra of [{}, { checkedBags: true }, { wantsToLeave: false }]) {
          for (const entry of [PERMITTED, UNCURATED]) {
            for (const at of [NOW, NOW + 13 * HOUR]) {
              const r = certify(hours, entry, { ...flight, ...extra }, at);
              verdicts.add(r.verdict);
              const cc = certifiedComputationRowFor("u", "s", r);
              const tb = timeBudgetRowFor("snap:x", "s", r);
              const rp = returnPlanRowFor("snap:x", "s", r);
              const where = `${hours}h ${JSON.stringify({ ...flight, ...extra })} ${entry.state} @${at}`;
              for (const [label, v] of [
                ["certified.total_buffer_min", cc.total_buffer_min], ["certified.usable_minutes", cc.usable_minutes],
                ["budget.scheduled_minutes", tb.scheduled_minutes], ["budget.exit_min", tb.exit_min],
                ["budget.total_buffer_min", tb.total_buffer_min], ["budget.usable_minutes", tb.usable_minutes],
              ] as const) {
                assert.ok(Number.isInteger(v) && (v as number) >= 0, `${label} = ${String(v)} at ${where}`);
              }
              for (const [label, v] of [["budget.return_min", tb.return_min], ["budget.outbound_min", tb.outbound_min]] as const) {
                assert.ok(v === null || (Number.isInteger(v) && (v as number) >= 0), `${label} = ${String(v)} at ${where}`);
              }
              assert.ok(Date.parse(String(rp.recommended_return_by)) <= Date.parse(String(rp.hard_return_by)), where);
              n++;
            }
          }
        }
      }
    }
    assert.equal(n, 14 * 2 * 3 * 2 * 2);
    // Non-vacuous: the grid reaches every verdict the engine has.
    assert.deepEqual([...verdicts].sort(), writerVocabulary("EngineVerdict"));
  });
});
