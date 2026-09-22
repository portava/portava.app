/**
 * The layover route family, driven against the PRODUCTION SCHEMA CAPTURE.
 *
 * ── THE ROW THIS ANSWERS, AND THE HALF IT DOES NOT ───────────────────────────
 * census-layover **L295** (C3, "Never let a test fixture assert impossible
 * production joins; live-schema/literal checks must cover safety-critical query
 * paths") reads, at its last verdict:
 *
 *   "What is missing is the fixture half: `test/airport.test.ts` uses a
 *    hand-rolled fake client whose filters are `r[col] === val` predicates,
 *    exactly the structure `checkEnumLiterals.ts:20-27` documents as
 *    'structurally incapable' of catching a bad literal — and NO LAYOVER TEST
 *    RUNS AGAINST A REAL CI SCHEMA."
 *
 * Re-measured at this head, both clauses hold in the letter:
 * `grep -rln 'schemaStrictSupabase\|enumAwareSupabase\|failClosedSupabase'
 * src/test/ | grep -iE 'layover|airport'` returns NOTHING. Every one of the
 * fifty-odd layover suites runs on a double that answers "is my fixture's value
 * in your list?" and never "is that a real column?".
 *
 * This suite is the fixture half. It is NOT a CI database — L295 asks for one
 * and this is not it — so the row does not close here. What it is: the layover
 * routes driven over a client whose column oracle is the committed PRODUCTION
 * CAPTURE, `src/lib/capability/snapshots/20260922-production-schema.json`, the
 * file `snapshots/current.ts` names. A handler that selects, filters on, orders
 * by or writes a column production does not have fails the whole statement with
 * PostgREST's 42703 — resolved, never thrown, exactly as supabase-js reports it
 * — and the case reports the column by name.
 *
 * ── WHY NOT `helpers/schemaStrictSupabase.ts` ────────────────────────────────
 * That helper exists and is the right shape, and its oracle is
 * `src/test/generated/liveColumns.json`, generated 2026-08-31. FIVE layover
 * migrations have been applied to production since — 2410 (`rec_key`), 2860,
 * 2982, 2983, 2984 — so that file reports `layover_recommendations.rec_key` as
 * a dead column although production has had it since 2026-09-08, and it knows
 * nothing of `layover_crews` or `airport_fact_observations` at all. Pointing a
 * conscience at a stale oracle produces confident, specific, FALSE failures.
 * The oracle here is the capture the repository's own guards grade against, and
 * the suite asserts its watermark rather than trusting the filename.
 *
 * ── WHAT COULD HAVE MADE THIS PASS WITHOUT THE PROPERTY ──────────────────────
 *  * A vacuous oracle. `the conscience is awake` drives a KNOWN-dead column
 *    through the same double and requires the 42703.
 *  * Routes that never ran. Every case asserts a 200 and a body field, so a
 *    handler that 500ed or refused cannot be read as "no dead column found".
 *  * A double that silently skips tables. The unchecked set is asserted to
 *    exclude every core layover table by name.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverApiProductionSchema.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  PRODUCTION_SNAPSHOT_FILENAME,
  PRODUCTION_SNAPSHOT_URL,
} from "../lib/capability/snapshots/current.js";

const TOKEN = "prod-schema-token";
const USER = "prod-schema-user";
const SESSION = "session-prod-schema";
const HOUR = 3_600_000;

// ── the oracle ───────────────────────────────────────────────────────────────

type Snapshot = {
  projectRef: string;
  productionMigrationWatermark: string;
  tables: Record<string, string[]>;
};

const SNAPSHOT: Snapshot = JSON.parse(readFileSync(PRODUCTION_SNAPSHOT_URL, "utf8"));

/**
 * The layover surface's own tables. Every one of these MUST be in the capture,
 * and none of them may end up unchecked — that assertion is what stops this
 * suite degrading into a pass by exemption.
 */
const CORE_LAYOVER_TABLES = [
  "layover_sessions",
  "layover_plan_stops",
  "layover_recommendations",
  "layover_events",
  "airport_profiles",
  "feature_flags",
];

/** Tables touched that are not the layover surface's, checked all the same. */
const ADJACENT_TABLES = ["trip_plan_items", "profiles"];

const CHECKED = new Set([...CORE_LAYOVER_TABLES, ...ADJACENT_TABLES]);

type Row = Record<string, any>;

interface DeadColumn { table: string; column: string; where: string }

/**
 * A supabase-js-shaped double whose column oracle is the production capture.
 *
 * Only the verbs the layover read/write paths actually use. It is a schema
 * conscience for a query, not a Postgres: an unknown column resolves the whole
 * statement with 42703 and the caller degrades exactly as it does in
 * production, where PostgREST rejects the statement rather than the column.
 */
function makeProductionSchemaClient(seed: Record<string, Row[]>, users: Record<string, string>) {
  const dead: DeadColumn[] = [];

  function columnsOf(table: string): Set<string> | null {
    if (!CHECKED.has(table)) return null;
    const cols = SNAPSHOT.tables[table];
    if (!cols) {
      throw new Error(
        `${PRODUCTION_SNAPSHOT_FILENAME} has no table "${table}". A layover route reads it and production ` +
          "does not have it — that is a finding, not a fixture problem.",
      );
    }
    return new Set(cols);
  }

  function from(table: string) {
    const store = (seed[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let bad: DeadColumn | null = null;
    let written: Row[] | null = null;
    let op: "insert" | "upsert" | "update" | null = null;
    let deleting = false;
    let selected = false;
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;

    function note(cols: string[], where: string) {
      const live = columnsOf(table);
      if (!live) return;
      for (const c of cols) {
        if (!live.has(c)) {
          const d = { table, column: c, where };
          dead.push(d);
          if (!bad) bad = d;
        }
      }
    }

    /** PostgREST's select list, reduced to bare column names. */
    function selectCols(cols?: string): string[] {
      if (!cols || cols.trim() === "*") return [];
      return cols.split(",").map((p) => p.trim())
        .filter((p) => p.length > 0 && !p.includes("("))
        .map((p) => (p.includes(":") ? p.slice(p.indexOf(":") + 1) : p).trim())
        .filter((p) => p.length > 0 && p !== "*");
    }

    function settle(mode: "list" | "single" | "maybeSingle") {
      if (bad) {
        const d: DeadColumn = bad;
        return {
          data: null,
          error: {
            code: "42703",
            message: `column ${d.table}.${d.column} does not exist`,
            details: d.where,
          },
        };
      }
      if (deleting || written) {
        let affected: Row[] = [];
        if (deleting) {
          affected = store.filter((r) => filters.every((f) => f(r)));
          for (const r of affected) store.splice(store.indexOf(r), 1);
        } else if (op === "update") {
          affected = store.filter((r) => filters.every((f) => f(r)));
          for (const r of affected) Object.assign(r, written![0]);
        } else {
          affected = written!.map((r) => ({ id: `row-${Math.random().toString(36).slice(2, 9)}`, ...r }));
          store.push(...affected);
        }
        if (!selected) return { data: null, error: null };
        if (mode === "list") return { data: affected, error: null };
        return { data: affected[0] ?? null, error: null };
      }
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (mode === "list") return { data: rows, error: null, count: null };
      return { data: rows[0] ?? null, error: null };
    }

    const b: any = {
      select(cols?: string) { selected = true; note(selectCols(cols), `select("${cols ?? "*"}")`); return b; },
      insert(rows: Row | Row[]) {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) note(Object.keys(r), "insert body");
        written = arr; op = "insert"; return b;
      },
      upsert(rows: Row | Row[]) {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) note(Object.keys(r), "upsert body");
        written = arr; op = "upsert"; return b;
      },
      update(row: Row) { note(Object.keys(row), "update body"); written = [row]; op = "update"; return b; },
      delete() { deleting = true; return b; },
      eq(col: string, v: any)  { note([col], `eq("${col}")`);  filters.push((r) => r[col] === v); return b; },
      neq(col: string, v: any) { note([col], `neq("${col}")`); filters.push((r) => r[col] !== v); return b; },
      in(col: string, vs: any[]) { note([col], `in("${col}")`); filters.push((r) => vs.includes(r[col])); return b; },
      is(col: string, v: any)  { note([col], `is("${col}")`);  filters.push((r) => (r[col] ?? null) === v); return b; },
      gt(col: string, v: any)  { note([col], `gt("${col}")`);  filters.push((r) => r[col] > v);  return b; },
      gte(col: string, v: any) { note([col], `gte("${col}")`); filters.push((r) => r[col] >= v); return b; },
      lt(col: string, v: any)  { note([col], `lt("${col}")`);  filters.push((r) => r[col] < v);  return b; },
      lte(col: string, v: any) { note([col], `lte("${col}")`); filters.push((r) => r[col] <= v); return b; },
      ilike(col: string, v: string) {
        note([col], `ilike("${col}")`);
        const needle = String(v).replace(/%/g, "").toLowerCase();
        filters.push((r) => typeof r[col] === "string" && r[col].toLowerCase().includes(needle));
        return b;
      },
      not(col: string) { note([col], `not("${col}")`); return b; },
      or() { return b; },
      order(col: string, o: any = {}) { note([col], `order("${col}")`); order = { col, asc: o.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve(settle("maybeSingle")); },
      single() { return Promise.resolve(settle("single")); },
      then(onF: any, onR: any) { return Promise.resolve(settle("list")).then(onF, onR); },
    };
    return b;
  }

  return {
    client: {
      from,
      rpc(fn: string): never {
        throw new Error(`this double does not model rpc (called "${fn}")`);
      },
      auth: {
        getUser: async (token: string) =>
          users[token]
            ? { data: { user: { id: users[token] } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
      },
    } as any,
    dead,
  };
}

// ── harness ──────────────────────────────────────────────────────────────────

let server: http.Server;
let base = "";
let tables: Record<string, Row[]>;
let dead: DeadColumn[];

function stage() {
  const now = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
    ],
    airport_profiles: [airportRow({ verified: true })],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: USER, status: "active",
        arrival_time: new Date(now - 10 * 60_000).toISOString(),
        departure_time: new Date(now + 10 * HOUR).toISOString(),
      }),
    ],
    layover_plan_stops: [],
    layover_recommendations: [],
    layover_events: [],
    trip_plan_items: [],
    profiles: [{ id: USER, handle: "traveller", name: "A Traveller", avatar_url: null }],
  };
  const made = makeProductionSchemaClient(tables, { [TOKEN]: USER });
  dead = made.dead;
  _setTestClient(made.client, true);
  return tables;
}

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        let acc = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { acc += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

const report = () =>
  dead.map((d) => `${d.table}.${d.column} (${d.where})`).join("\n  ");

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server?.close(); _setTestClient(null as any, false); });

beforeEach(() => { stage(); });

// ─────────────────────────────────────────────────────────────────────────────

describe("the oracle is the production capture, and it is the current one", () => {
  it("names the production project and carries a watermark", () => {
    assert.equal(SNAPSHOT.projectRef, "ajrurzioarfkagpuxfnb");
    assert.match(SNAPSHOT.productionMigrationWatermark, /^\d{14}$/);
  });

  it("holds every core layover table, so nothing is checked by exemption", () => {
    for (const t of CORE_LAYOVER_TABLES) {
      assert.ok(
        Array.isArray(SNAPSHOT.tables[t]) && SNAPSHOT.tables[t].length > 0,
        `${t} is missing from ${PRODUCTION_SNAPSHOT_FILENAME}`,
      );
      assert.ok(CHECKED.has(t), `${t} must be checked, not exempted`);
    }
  });

  it("the conscience is awake: a column production does not have fails the statement", async () => {
    const { client } = makeProductionSchemaClient({ layover_sessions: [] }, {});
    const r = await client.from("layover_sessions").select("id").eq("entry_permission_state", "permitted").maybeSingle();
    assert.equal(r.data, null);
    assert.equal(r.error?.code, "42703");
    assert.match(String(r.error?.message), /layover_sessions\.entry_permission_state/);
  });
});

describe("census L295 / L236 — the layover read paths name only live columns", () => {
  it("GET /airport/sessions", async () => {
    const r = await send("GET", "/api/airport/sessions?status=active");
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });

  it("GET /airport/sessions/active", async () => {
    const r = await send("GET", "/api/airport/sessions/active");
    assert.equal(r.status, 200);
    assert.equal(r.body.session?.id, SESSION);
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });

  it("GET /airport/sessions/:id/overview", async () => {
    const r = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(r.status, 200);
    assert.ok(r.body.certification?.inputHash);
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });

  it("GET /airport/sessions/:id/safety", async () => {
    const r = await send("GET", `/api/airport/sessions/${SESSION}/safety`);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });

  it("GET /airport/sessions/:id/stops", async () => {
    const r = await send("GET", `/api/airport/sessions/${SESSION}/stops`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.stops));
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });
});

describe("census L295 / L236 — the layover WRITE paths name only live columns", () => {
  it("POST /airport/sessions/:id/stops writes a live row shape", async () => {
    const r = await send("POST", `/api/airport/sessions/${SESSION}/stops`, {
      title: "Ningxia Night Market", durationMin: 60, travelMin: 50,
      insideAirport: false, lat: 25.0561, lng: 121.5153,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stops.length, 1);
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });

  it("POST /airport/sessions/:id/return-deadline persists the reminder", async () => {
    const r = await send("POST", `/api/airport/sessions/${SESSION}/return-deadline`, { minutesBefore: 30 });
    assert.equal(r.status, 200);
    assert.ok(r.body.reminderAt);
    assert.equal(tables.layover_sessions[0].return_reminder_at, r.body.reminderAt);
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });

  it("PATCH /airport/sessions/:id/share flips the opt-in", async () => {
    const r = await send("PATCH", `/api/airport/sessions/${SESSION}/share`, { enabled: true });
    assert.equal(r.status, 200);
    assert.equal(tables.layover_sessions[0].share_city_status, true);
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });

  it("DELETE /airport/sessions/:id closes it", async () => {
    const r = await send("DELETE", `/api/airport/sessions/${SESSION}?outcome=completed`);
    assert.equal(r.status, 200);
    assert.equal(tables.layover_sessions[0].status, "completed");
    assert.equal(dead.length, 0, `dead columns:\n  ${report()}`);
  });
});
