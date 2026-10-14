/**
 * The §20 decision record on a REAL database: `persistDecision` stores a
 * decision for every verdict the engine can certify, against the tables 2700,
 * 2992 and 3623 actually create and the CHECK 3792 actually leaves.
 *
 * WHY THIS FILE EXISTS (census-layover §73, migration 3792). 2700's verdict
 * CHECK listed four verdicts. The engine also certifies `entry_unverified`, for
 * every roomy layover whose entry corridor is unconfirmed, and the writer sends
 * it unmapped. On the chain without 3792 the parent INSERT fails with 23514 and
 * `persistDecision` returns `write_failed`. Nothing caught that, because the
 * unit suites run on `fakeLayoverDb`, which models no CHECK, and no database
 * suite wrote this table. This one does, through the store's own statements.
 *
 * ── THE STORE'S OWN STATEMENTS ARE WHAT RUN ─────────────────────────────────
 * `psqlClient` below turns the supabase-js calls `persistDecision` makes (the
 * flag read, the snapshot read, three inserts) into SQL, run as `service_role`.
 * The INSERT's column list is the PAYLOAD'S KEYS, so a column, a type or a CHECK
 * the database refuses is a database error here, never a silent pass.
 *
 * ── THE FLAG ────────────────────────────────────────────────────────────────
 * `persistDecision` refuses while `layover_decision_persistence_enabled` is OFF,
 * which is the seed. This suite turns it ON in the throwaway database for its
 * own run and puts back exactly the value it found in `after()`. The suites run
 * one file at a time (`run-tests.sh`, --test-concurrency=1), so no other suite
 * ever sees it ON.
 *
 * Skips when LOCAL_DB_URL is unset; `scripts/local-db/run-tests.sh` is the run
 * that refuses skipped > 0.
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HAVE_DB, deleteUser, exec, jsonLiteral, psql, rows, scalar, seedUser } from "./localDb.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "../../services/airport/LayoverFeasibility.js";
import type { EntryEligibility } from "../../services/airport/layoverEntryGate.js";
import { snapshotIdFor } from "../../services/airport/layoverLedger.js";
import {
  DECISION_PERSISTENCE_FLAG,
  persistDecision,
  riskBandFor,
} from "../../services/layover/LayoverDecisionStore.js";
import { writerVocabulary } from "../helpers/layoverStoredVocabulary.js";

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`refusing to interpolate identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
};
const lit = (v: unknown) => `'${String(v).replace(/'/g, "''")}'`;

/** Run one statement as the service role and report it the way supabase-js would. */
function run(sql: string): { data: any; error: { message: string; code?: string } | null } {
  const r = psql(`\\set VERBOSITY verbose\nSET ROLE service_role;\n${sql}`);
  if (r.status !== 0) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr);
    return { data: null, error: { message: m?.[2] ?? r.stderr.trim(), code: m?.[1] } };
  }
  const text = r.stdout.trim();
  return { data: text ? JSON.parse(text) : null, error: null };
}

/** The slice of the supabase-js surface `persistDecision` uses, over psql. */
function psqlClient(): any {
  return {
    from(table: string) {
      const where: string[] = [];
      let cols = "*";
      let insert: Record<string, unknown> | null = null;
      const list = () => {
        if (insert) {
          const keys = Object.keys(insert).map(ident).join(", ");
          return run(
            `WITH ins AS (INSERT INTO public.${ident(table)} (${keys}) SELECT ${keys} FROM jsonb_populate_record(NULL::public.${ident(table)}, ${jsonLiteral(insert)}) RETURNING ${cols}) SELECT COALESCE(json_agg(ins), '[]'::json)::text FROM ins;`,
          );
        }
        return run(
          `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (SELECT ${cols} FROM public.${ident(table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}) t;`,
        );
      };
      const b: any = {
        select(c?: string) { cols = c && c !== "*" ? c.split(",").map((x) => ident(x.trim())).join(", ") : "*"; return b; },
        insert(payload: Record<string, unknown>) { insert = payload; return b; },
        eq(col: string, v: unknown) { where.push(`${ident(col)} = ${lit(v)}`); return b; },
        maybeSingle() {
          const r = list();
          if (r.error) return Promise.resolve(r);
          const arr = r.data as unknown[];
          return Promise.resolve({ data: arr[0] ?? null, error: null });
        },
        then(onF: any, onR: any) { return Promise.resolve(list()).then(onF, onR); },
      };
      return b;
    },
  };
}

// ── one real certified record per verdict ───────────────────────────────────

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
/** What production sees for every corridor while `entry_requirements` is uncurated. */
const UNCURATED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };

function certify(sessionId: string, hours: number, entry: EntryEligibility, over: Partial<FeasibilitySession> = {}) {
  const s: FeasibilitySession = {
    id: sessionId,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
  return certifySessionFeasibility(AIRPORT, s, { nowMs: NOW, entry });
}

// ── 3792 and its rollback, as files: the body between BEGIN; and COMMIT;, and the $post$ block ──

function blocksOf(file: URL): { body: string; post: string } {
  const sql = readFileSync(file, "utf8");
  const body = /^BEGIN;\n([\s\S]*?)^COMMIT;$/m.exec(sql)?.[1];
  const post = /^DO \$post\$[\s\S]*?^END \$post\$;$/m.exec(sql)?.[0];
  if (!body || !post) throw new Error(`${file.pathname}: could not find the BEGIN/COMMIT body and the $post$ block`);
  return { body, post };
}
const MIGRATION = blocksOf(new URL("../../migrations/3792_layover_certified_verdict_admits_entry_unverified.sql", import.meta.url));
const ROLLBACK_FILE = blocksOf(
  new URL("../../../../../db/rollback/2026-10-14-3792-layover-certified-verdict-admits-entry-unverified-rollback.sql", import.meta.url),
);
/** One line per single-column verdict CHECK: its admitted values, sorted and comma-joined. */
const VERDICT_CHECKS = `SELECT string_agg(m[1], ',' ORDER BY m[1])
  FROM pg_constraint con
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
  CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(con.oid), '''([a-z_]+)''::text', 'g') AS x(m)
 WHERE con.conrelid = 'public.layover_certified_computations'::regclass
   AND con.contype = 'c' AND att.attname = 'verdict' AND cardinality(con.conkey) = 1
 GROUP BY con.oid;`;
const FIVE = "entry_unverified,no,stay_airside,tight,yes";

/** The shortest window, in quarter hours, the engine certifies `tight`. Searched, not assumed. */
function tightHours(): number {
  for (let h = 2; h <= 8; h += 0.25) if (certify("probe", h, PERMITTED).verdict === "tight") return h;
  throw new Error("no window between 2h and 8h certifies `tight`; the fixture needs re-deriving");
}

describe("layover_certified_computations — persistDecision against 2700 + 2992 + 3623 + 3792", { skip: !HAVE_DB }, () => {
  let user = "";
  let flagWas: boolean | null = null;
  const db = psqlClient();
  const sessions: string[] = [];

  function seedSession(hours: number): string {
    const id = randomUUID();
    exec(
      `INSERT INTO public.layover_sessions (id, user_id, arrival_time, departure_time, flight_type) ` +
      `VALUES ('${id}', '${user}', '${new Date(NOW).toISOString()}', '${new Date(NOW + hours * HOUR).toISOString()}', 'international');`,
    );
    sessions.push(id);
    return id;
  }

  /** A real certified record for each verdict, each on its own seeded session. */
  function fixtures(): Array<{ verdict: string; sessionId: string; record: LayoverFeasibilityRecord }> {
    const out: Array<{ verdict: string; sessionId: string; record: LayoverFeasibilityRecord }> = [];
    const add = (hours: number, entry: EntryEligibility, over: Partial<FeasibilitySession> = {}) => {
      const sessionId = seedSession(hours);
      const record = certify(sessionId, hours, entry, over);
      out.push({ verdict: record.verdict, sessionId, record });
    };
    add(11, PERMITTED);                          // yes
    add(tightHours(), PERMITTED);                // tight
    add(1, PERMITTED);                           // no: insufficient usable time
    add(11, UNCURATED);                          // entry_unverified: THE row 2700 refused
    add(11, PERMITTED, { wantsToLeave: false }); // stay_airside
    return out;
  }

  before(() => {
    user = seedUser("lay2700");
    const found = rows<{ enabled: boolean }>(
      `SELECT enabled FROM public.feature_flags WHERE flag = ${lit(DECISION_PERSISTENCE_FLAG)}`,
    );
    assert.equal(found.length, 1, `${DECISION_PERSISTENCE_FLAG} has no row; 2992 seeds it`);
    flagWas = found[0]!.enabled;
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = ${lit(DECISION_PERSISTENCE_FLAG)};`);
  });
  after(() => {
    if (!HAVE_DB) return;
    if (flagWas !== null) {
      exec(`UPDATE public.feature_flags SET enabled = ${flagWas ? "true" : "false"} WHERE flag = ${lit(DECISION_PERSISTENCE_FLAG)};`);
    }
    if (sessions.length) exec(`DELETE FROM public.layover_sessions WHERE id IN (${sessions.map(lit).join(", ")});`);
    deleteUser(user);
  });

  it("the live verdict CHECK is ONE constraint and it admits every verdict the engine's union has", () => {
    const defs = rows<{ def: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
        WHERE con.conrelid = 'public.layover_certified_computations'::regclass
          AND con.contype = 'c' AND att.attname = 'verdict'`,
    );
    assert.equal(defs.length, 1, JSON.stringify(defs));
    for (const v of writerVocabulary("EngineVerdict")) {
      assert.ok(defs[0]!.def.includes(`'${v}'::text`), `the live CHECK does not admit ${v}: ${defs[0]!.def}`);
    }
  });

  it("a roomy layover with an unconfirmed corridor is STORED, with its time budget and return plan (refused by 2700's CHECK alone)", async () => {
    const sessionId = seedSession(11);
    const record = certify(sessionId, 11, UNCURATED);
    assert.equal(record.verdict, "entry_unverified");
    const out = await persistDecision(db, user, sessionId, record);
    assert.deepEqual(out, { ok: true, snapshotId: snapshotIdFor(sessionId, record.inputHash), state: "recorded", unwritten: [] });

    const stored = rows<{ verdict: string; snapshot_id: string; snapshot_version: number }>(
      `SELECT verdict, snapshot_id, snapshot_version FROM public.layover_certified_computations WHERE session_id = '${sessionId}'`,
    );
    assert.deepEqual(stored, [{ verdict: "entry_unverified", snapshot_id: out.ok ? out.snapshotId : "", snapshot_version: 1 }]);
    assert.equal(scalar(`SELECT count(*) FROM public.layover_time_budgets WHERE session_id = '${sessionId}'`), "1");
    assert.equal(
      scalar(`SELECT risk_band FROM public.layover_return_plans WHERE session_id = '${sessionId}'`),
      "MODERATE",
      "entry_unverified is the risky band, not the refused one (riskBandFor)",
    );
  });

  it("every verdict the engine can certify is stored; the fixtures cover the whole union, read by the compiler", async () => {
    const all = fixtures();
    assert.deepEqual(all.map((f) => f.verdict).sort(), writerVocabulary("EngineVerdict"), "a verdict without a fixture here is a verdict nothing stores-tests");
    for (const f of all) {
      const out = await persistDecision(db, user, f.sessionId, f.record);
      assert.ok(out.ok && out.state === "recorded" && out.unwritten.length === 0, `${f.verdict}: ${JSON.stringify(out)}`);
      assert.equal(scalar(`SELECT verdict FROM public.layover_certified_computations WHERE session_id = '${f.sessionId}'`), f.verdict);
      const band = riskBandFor(f.record);
      assert.equal(scalar(`SELECT coalesce(risk_band, '<null>') FROM public.layover_return_plans WHERE session_id = '${f.sessionId}'`), band ?? "<null>", f.verdict);
    }
  });

  it("the same computation again is `already_recorded`, read back through the stored row's replay", async () => {
    const sessionId = seedSession(11);
    const record = certify(sessionId, 11, UNCURATED);
    assert.equal((await persistDecision(db, user, sessionId, record)).ok, true);
    const again = await persistDecision(db, user, sessionId, record);
    assert.ok(again.ok && again.state === "already_recorded", JSON.stringify(again));
    assert.equal(scalar(`SELECT count(*) FROM public.layover_certified_computations WHERE session_id = '${sessionId}'`), "1");
  });

  // ── 3792's own blocks, and its rollback, each inside a transaction that is
  // ROLLED BACK: the shared database leaves every case exactly as it found it.

  it("3792's postcondition passes ALONE at the chain end, as the live applier runs it (its own request)", () => {
    const r = psql(`BEGIN;\n${MIGRATION.post}\nROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
  });

  it("3792's postcondition refuses every loosening of the verdict CHECK", () => {
    const T = "public.layover_certified_computations";
    const C = "layover_certified_computations_verdict_check";
    for (const [loosen, expect] of [
      [`ALTER TABLE ${T} ADD CONSTRAINT lay2700_second CHECK (verdict <> 'zzz');`, /2 single-column CHECK/],
      [`ALTER TABLE ${T} DROP CONSTRAINT ${C};`, /0 single-column CHECK/],
      [`ALTER TABLE ${T} DROP CONSTRAINT ${C}; ALTER TABLE ${T} ADD CONSTRAINT ${C} CHECK (verdict IN ('yes','tight','no','stay_airside')) NOT VALID;`, /not a plain enumerated list/],
      [`DELETE FROM ${T} WHERE verdict = 'entry_unverified'; ALTER TABLE ${T} DROP CONSTRAINT ${C}; ALTER TABLE ${T} ADD CONSTRAINT ${C} CHECK (verdict IN ('yes','tight','no','stay_airside'));`, /does not admit entry_unverified/],
      [`ALTER TABLE ${T} DROP CONSTRAINT ${C}; ALTER TABLE ${T} ADD CONSTRAINT ${C} CHECK (verdict IN ('yes','tight','no','entry_unverified','stay_airside') OR verdict IS NOT NULL);`, /not a plain enumerated list/],
    ] as const) {
      const r = psql(`BEGIN;\n${loosen}\n${MIGRATION.post}\nROLLBACK;`);
      assert.notEqual(r.status, 0, `the postcondition accepted: ${loosen}`);
      assert.match(r.stderr, expect, loosen);
    }
  });

  it("re-applying 3792's body is a no-op: one CHECK, the same five", () => {
    const r = psql(`BEGIN;\n${MIGRATION.body}\n${MIGRATION.post}\n${VERDICT_CHECKS}\nROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), [FIVE]);
  });

  it("the rollback REFUSES while a stored computation carries entry_unverified, and changes nothing", () => {
    const sessionId = seedSession(11);
    const row = `INSERT INTO public.layover_certified_computations (session_id, user_id, engine_version, feasibility_version, input_hash, computed_at, verdict, confidence, cutoff_at, hard_return_time, total_buffer_min, usable_minutes, inputs, breakdown, estimates) VALUES ('${sessionId}', '${user}', 'e', 'f', 'sha256:rb', now(), 'entry_unverified', 'LOW', now(), now(), 0, 0, '{}', '{}', '{}');`;
    const r = psql(`BEGIN;\nUPDATE public.feature_flags SET enabled = false WHERE flag = ${lit(DECISION_PERSISTENCE_FLAG)};\n${row}\n${ROLLBACK_FILE.body}\nROLLBACK;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ROLLBACK REFUSED \(3792\): \d+ stored computation\(s\) carry a verdict 2700's CHECK does not admit/);
  });

  it("the rollback REFUSES while layover_decision_persistence_enabled is ON", () => {
    const r = psql(`BEGIN;\nDELETE FROM public.layover_certified_computations WHERE verdict NOT IN ('yes','tight','no','stay_airside');\nUPDATE public.feature_flags SET enabled = true WHERE flag = ${lit(DECISION_PERSISTENCE_FLAG)};\n${ROLLBACK_FILE.body}\nROLLBACK;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ROLLBACK REFUSED \(3792\): layover_decision_persistence_enabled is ON/);
  });

  it("cleared and with the flag OFF, the rollback restores 2700's four exactly, and entry_unverified is refused again", () => {
    const sessionId = seedSession(11);
    const row = `INSERT INTO public.layover_certified_computations (session_id, user_id, engine_version, feasibility_version, input_hash, computed_at, verdict, confidence, cutoff_at, hard_return_time, total_buffer_min, usable_minutes, inputs, breakdown, estimates) VALUES ('${sessionId}', '${user}', 'e', 'f', 'sha256:rb2', now(), 'entry_unverified', 'LOW', now(), now(), 0, 0, '{}', '{}', '{}');`;
    const restored = psql(
      `BEGIN;\nDELETE FROM public.layover_certified_computations WHERE verdict NOT IN ('yes','tight','no','stay_airside');\n` +
      `UPDATE public.feature_flags SET enabled = false WHERE flag = ${lit(DECISION_PERSISTENCE_FLAG)};\n` +
      `${ROLLBACK_FILE.body}\n${ROLLBACK_FILE.post}\n${VERDICT_CHECKS}\nROLLBACK;`,
    );
    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(restored.stdout.trim().split("\n"), ["no,stay_airside,tight,yes"]);
    const refused = psql(
      `BEGIN;\nDELETE FROM public.layover_certified_computations WHERE verdict NOT IN ('yes','tight','no','stay_airside');\n` +
      `UPDATE public.feature_flags SET enabled = false WHERE flag = ${lit(DECISION_PERSISTENCE_FLAG)};\n` +
      `${ROLLBACK_FILE.body}\n${row}\nROLLBACK;`,
    );
    assert.notEqual(refused.status, 0, "after the rollback entry_unverified still stored: the rollback is not the inverse");
    assert.match(refused.stderr, /layover_certified_computations_verdict_check/);
  });

  it("CONTROL: a verdict outside the union is still refused by the CHECK, and nothing is stored", async () => {
    const sessionId = seedSession(11);
    const forged = { ...certify(sessionId, 11, UNCURATED), verdict: "maybe" } as unknown as LayoverFeasibilityRecord;
    const out = await persistDecision(db, user, sessionId, forged);
    assert.deepEqual(out.ok ? out : { ok: out.ok, reason: out.reason }, { ok: false, reason: "write_failed" });
    assert.equal(scalar(`SELECT count(*) FROM public.layover_certified_computations WHERE session_id = '${sessionId}'`), "0");
    const raw = psql(`\\set VERBOSITY verbose\nSET ROLE service_role;\nINSERT INTO public.layover_certified_computations (session_id, user_id, engine_version, feasibility_version, input_hash, computed_at, verdict, confidence, cutoff_at, hard_return_time, total_buffer_min, usable_minutes, inputs, breakdown, estimates) VALUES ('${sessionId}', '${user}', 'e', 'f', 'sha256:control', now(), 'maybe', 'LOW', now(), now(), 0, 0, '{}', '{}', '{}');`);
    assert.notEqual(raw.status, 0);
    assert.match(raw.stderr, /23514/);
  });
});
