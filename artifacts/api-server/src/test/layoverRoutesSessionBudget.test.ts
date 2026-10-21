/**
 * LAYOVER 165, lane B1-R1 — owner decision R5 (2026-10-18): a layover's Google
 * Routes calls are charged to a LAYOVER-SESSION scope, keyed by the session and
 * the person, with its own caps — on REAL SQL.
 *
 *   (a) "A trip-less layover session is charged to a layover-session budget
 *       scope, keyed by the session and the user, with its own caps. Build it
 *       with the existing RoutesRequestBudget machinery."
 *   (b) "The caps must allow the per-candidate routing the rows require."
 *
 * The caps (layoverRoutesSpendGate.ts): 12 calls per read (6 candidates × 2),
 * 36 per session (three cold evaluations), 60 per person per UTC day, under the
 * owner's shared day ceiling ($10 / 500 calls, 3971's day row).
 *
 * WHAT RUNS. Migrations 3971 (the shared day row) and 3856 (the layover tables,
 * the function, the flag) are applied — the files themselves, byte for byte — to
 * an isolated PGlite (PostgreSQL 16) whose only hand-made objects are the
 * prerequisites they name (roles, auth.users, feature_flags, layover_sessions).
 * The TypeScript gate (`dbLayoverRoutesSpendGate`) calls the function through a
 * PostgREST-shaped `rpc`, as service_role. The full production-shaped chain
 * (the packet's replica, PostgreSQL 18.3) is proved separately in the lane's
 * harness (scratchpad/l165-b1-r1/pg): forward, rollback == before, second
 * rollback a no-op, re-forward, and every refusal.
 *
 * Run: node --import tsx/esm --test src/test/layoverRoutesSessionBudget.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dbLayoverRoutesSpendGate,
  readLayoverRoutesSpendConfig,
  LAYOVER_ROUTES_CAPS,
  LAYOVER_ROUTED_CORRIDOR_FLAG,
  type LayoverRoutesSpendConfig,
} from "../services/airport/layoverRoutesSpendGate.js";
import { withLayoverRoutesBudget, ROUTES_UNSCOPED_NO_SESSION, layoverRoutesRefusal } from "../services/airport/LayoverTravelTime.js";
import { currentRoutesRequestBudget, withRoutesRequestBudget, ROUTES_MAX_CALLS_PER_REQUEST } from "../domain/trips/contracts/RoutesRequestBudget.js";
import { CREDENTIAL_ENV, ENABLEMENT_ENV } from "../lib/providers/googleRoutesCorridorProvider.js";

const modulePath = process.env.DISCOVERY_PGLITE_MODULE ?? import.meta.resolve("@electric-sql/pglite");
const mig = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
const M3856 = mig("3856_layover_routes_session_budget.sql");
const M3971 = mig("3971_trip_routes_api_spend_gate.sql");

const U1 = "38560000-0000-4000-8000-000000000001";
const U2 = "38560000-0000-4000-8000-000000000002";
const S1 = "38560000-0000-4000-8000-0000000000a1";
const S2 = "38560000-0000-4000-8000-0000000000a2";
const S3 = "38560000-0000-4000-8000-0000000000a3";

interface Database { exec(sql: string): Promise<unknown>; query<R = any>(sql: string, p?: unknown[]): Promise<{ rows: R[] }>; close(): Promise<void> }
let db: Database;
let flagOn = true;

/** The slice of supabase-js the gate uses: the flag read and one rpc, both as service_role. */
function client(opts: { rpcError?: boolean } = {}): any {
  return {
    from(table: string) {
      assert.equal(table, "feature_flags");
      let flag = "";
      const q: any = {
        select() { return q; },
        eq(_c: string, v: string) { flag = v; return q; },
        async maybeSingle() { return { data: flag === LAYOVER_ROUTED_CORRIDOR_FLAG ? { enabled: flagOn } : null, error: null }; },
      };
      return q;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (opts.rpcError) return { data: null, error: { message: "connection reset" } };
      await db.exec("SET ROLE service_role");
      try {
        const names = Object.keys(args);
        const r = await db.query(`SELECT public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) AS v`, names.map((n) => args[n]));
        return { data: r.rows[0]?.v ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: String((e as Error).message) } };
      } finally { await db.exec("RESET ROLE"); }
    },
  };
}
const CFG: LayoverRoutesSpendConfig = { dailyQuota: 500, dailyBudgetMicros: 10_000_000, costPerCallMicros: 10_000, sessionCap: 36, userDailyCap: 60 };
const gate = (cfg: Partial<LayoverRoutesSpendConfig> = {}, o: { rpcError?: boolean } = {}) =>
  dbLayoverRoutesSpendGate({ client: () => client(o), config: () => ({ ...CFG, ...cfg }) });
const count = async (sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0]!.n);

before(async () => {
  const runtime = await import(modulePath);
  db = new runtime.PGlite() as Database;
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
    CREATE TABLE public.layover_sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL);
    GRANT USAGE ON SCHEMA public TO service_role;
  `);
});

describe("the migrations, applied as written, in the order a fresh replay applies them (3856 before 3971)", () => {
  it("M1. 3856 applies with 3971 absent; the flag is seeded FALSE; a spend answers 'unavailable' and counts nothing until the day row exists", async () => {
    await db.exec(M3856);
    const flags = (await db.query<{ enabled: boolean }>("SELECT enabled FROM public.feature_flags WHERE flag = 'layover_routed_corridor_enabled'")).rows;
    assert.deepEqual(flags, [{ enabled: false }]);
    await db.exec(`INSERT INTO auth.users VALUES ('${U1}'), ('${U2}'); INSERT INTO public.layover_sessions VALUES ('${S1}', '${U1}'), ('${S2}', '${U1}'), ('${S3}', '${U2}')`);
    assert.equal(await gate().decide({ userId: U1, layoverSessionId: S1 }), "unavailable", "order independence: no shared day row yet, nothing is spent");
    const direct = (await db.query<{ v: string }>(`SELECT public.routes_api_try_spend_layover(500, 10000000, 10000, '${U1}', '${S1}', 36, 60) AS v`)).rows[0]!.v;
    assert.equal(direct, "unavailable", "the function itself answers (it does not raise) before 3971 exists");
    assert.equal(await count("SELECT count(*)::int AS n FROM public.routes_api_layover_session_usage"), 0);
    await db.exec(M3971);
    assert.equal(await gate().decide({ userId: U1, layoverSessionId: S1 }), "granted", "with 3971 in place the same call is granted");
  });
});

describe("the caps, on real SQL", () => {
  it("C1. a session takes at most its cap (36), then session_share_exhausted; the counters move together and a refusal moves none", async () => {
    // One unit was taken in M1.
    for (let i = 1; i < LAYOVER_ROUTES_CAPS.perSessionCalls; i++) assert.equal(await gate().decide({ userId: U1, layoverSessionId: S1 }), "granted", `call ${i + 1}`);
    assert.equal(await gate().decide({ userId: U1, layoverSessionId: S1 }), "session_share_exhausted");
    assert.equal(await count(`SELECT calls AS n FROM public.routes_api_layover_session_usage WHERE session_id = '${S1}'`), 36);
    assert.equal(await count("SELECT calls AS n FROM public.routes_api_daily_usage"), 36);
    assert.equal(await count(`SELECT calls AS n FROM public.routes_api_layover_user_daily_usage WHERE user_id = '${U1}'`), 36);
  });
  it("C2. the person's daily cap (60) binds across their sessions; another person is untouched", async () => {
    for (let i = 0; i < 24; i++) assert.equal(await gate().decide({ userId: U1, layoverSessionId: S2 }), "granted", `second session call ${i + 1}`);
    assert.equal(await gate().decide({ userId: U1, layoverSessionId: S2 }), "user_share_exhausted", "36 + 24 = 60 for the day");
    assert.equal(await gate().decide({ userId: U2, layoverSessionId: S3 }), "granted", "a different traveller has their own share");
  });
  it("C3. the shared day ceiling binds layover calls too (quota, and the hard budget)", async () => {
    const used = await count("SELECT calls AS n FROM public.routes_api_daily_usage");
    assert.equal(await gate({ dailyQuota: used }).decide({ userId: U2, layoverSessionId: S3 }), "quota_exhausted");
    const spent = await count("SELECT spend_micros AS n FROM public.routes_api_daily_usage");
    assert.equal(await gate({ dailyBudgetMicros: spent }).decide({ userId: U2, layoverSessionId: S3 }), "budget_exhausted");
  });
  it("C4. a session that is not the person's is refused as unscoped, and charges nobody", async () => {
    const before = await count("SELECT calls AS n FROM public.routes_api_daily_usage");
    assert.equal(await gate().decide({ userId: U2, layoverSessionId: S1 }), "unscoped");
    assert.equal(await count("SELECT calls AS n FROM public.routes_api_daily_usage"), before);
  });
  it("C5. no client role can read a counter or spend", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.query("SELECT * FROM public.routes_api_layover_session_usage"), /permission denied/);
      await assert.rejects(db.query(`SELECT public.routes_api_try_spend_layover(1, 1, 1, '${U1}', '${S1}', 1, 1)`), /permission denied/);
      await db.exec("RESET ROLE");
    }
  });
});

describe("the TypeScript gate fails closed", () => {
  it("G1. flag off → off, and the function is never called", async () => {
    flagOn = false;
    const before = await count("SELECT calls AS n FROM public.routes_api_daily_usage");
    assert.equal(await gate().decide({ userId: U2, layoverSessionId: S3 }), "off");
    assert.equal(await count("SELECT calls AS n FROM public.routes_api_daily_usage"), before);
    flagOn = true;
  });
  it("G2. an RPC error → unavailable; no person or session → unscoped; no configuration → off", async () => {
    assert.equal(await gate({}, { rpcError: true }).decide({ userId: U2, layoverSessionId: S3 }), "unavailable");
    assert.equal(await gate().decide({ userId: null, layoverSessionId: S3 }), "unscoped");
    assert.equal(await gate().decide({ userId: U2, layoverSessionId: null }), "unscoped");
    assert.equal(await dbLayoverRoutesSpendGate({ client: () => client(), config: () => null }).decide({ userId: U2, layoverSessionId: S3 }), "off");
  });
});

describe("the configuration — the decided caps, stricter only", () => {
  const DAY = { GOOGLE_MAPS_API_KEY: "k", ROUTES_API_DAILY_QUOTA: "500", ROUTES_API_DAILY_BUDGET_USD: "10", ROUTES_API_COST_PER_CALL_USD: "0.01" };
  it("K1. with only the day configured, the layover caps are the decided ones; the Trips shares are not a layover's", () => {
    assert.deepEqual(readLayoverRoutesSpendConfig(DAY), { dailyQuota: 500, dailyBudgetMicros: 10_000_000, costPerCallMicros: 10_000, sessionCap: 36, userDailyCap: 60 });
  });
  it("K2. configuration may tighten a cap; a looser or malformed one is OFF, never clamped", () => {
    assert.equal(readLayoverRoutesSpendConfig({ ...DAY, LAYOVER_ROUTES_SESSION_CAP: "24" })?.sessionCap, 24);
    assert.equal(readLayoverRoutesSpendConfig({ ...DAY, LAYOVER_ROUTES_SESSION_CAP: "37" }), null);
    assert.equal(readLayoverRoutesSpendConfig({ ...DAY, LAYOVER_ROUTES_USER_DAILY_CAP: "0" }), null);
    assert.equal(readLayoverRoutesSpendConfig({ ...DAY, LAYOVER_ROUTES_USER_DAILY_CAP: "lots" }), null);
  });
  it("K3. the owner's day ceiling still governs: no key, a budget above $10 or a quota above 500 is OFF", () => {
    assert.equal(readLayoverRoutesSpendConfig({ ...DAY, GOOGLE_MAPS_API_KEY: undefined }), null);
    assert.equal(readLayoverRoutesSpendConfig({ ...DAY, ROUTES_API_DAILY_BUDGET_USD: "10.01" }), null);
    assert.equal(readLayoverRoutesSpendConfig({ ...DAY, ROUTES_API_DAILY_QUOTA: "501" }), null);
  });
  it("K4. the arithmetic the caps rest on: two billed calls per candidate, six candidates a read, three cold reads a session", () => {
    assert.equal(LAYOVER_ROUTES_CAPS.perReadCalls, LAYOVER_ROUTES_CAPS.candidatesPerRead * 2);
    assert.equal(LAYOVER_ROUTES_CAPS.perSessionCalls, LAYOVER_ROUTES_CAPS.perReadCalls * 3);
    assert.ok(LAYOVER_ROUTES_CAPS.perUserDailyCalls >= LAYOVER_ROUTES_CAPS.perSessionCalls);
    assert.equal(LAYOVER_ROUTES_CAPS.perReadCalls, ROUTES_MAX_CALLS_PER_REQUEST, "the per-read cap is the existing machinery's");
  });
});

describe("R5(a) — the scope a layover read opens (the existing RoutesRequestBudget machinery)", () => {
  const LIVE = (n: string) => (n === CREDENTIAL_ENV ? "k" : n === ENABLEMENT_ENV ? "true" : undefined);
  it("S1. a session — with or without a trip — opens a budget keyed by the session and the person, never the trip", async () => {
    for (const tripId of [null, "trip-9"]) {
      const seen = await withLayoverRoutesBudget({ id: S1, userId: U1, tripId }, async () => {
        const b = currentRoutesRequestBudget()!;
        return { userId: b.userId, tripId: b.tripId, layoverSessionId: b.layoverSessionId, maxCalls: b.maxCalls, refusal: layoverRoutesRefusal() };
      }, { readEnv: LIVE });
      assert.deepEqual(seen, { userId: U1, tripId: null, layoverSessionId: S1, maxCalls: 12, refusal: null }, `tripId=${tripId}`);
    }
  });
  it("S2. nested inside another read, the layover scope shares that read's counter and is charged to its own session", async () => {
    await withRoutesRequestBudget({ userId: U1, tripId: "trip-9" }, async () => {
      const outer = currentRoutesRequestBudget()!;
      await withLayoverRoutesBudget({ id: S1, userId: U1, tripId: "trip-9" }, async () => {
        const inner = currentRoutesRequestBudget()!;
        assert.equal(inner.counter, outer.counter, "one read, one counter");
        assert.equal(inner.layoverSessionId, S1);
      });
      assert.equal(outer.layoverSessionId, undefined, "the Trips budget object is untouched");
    });
  });
  it("S3. a read that names no session, with Routes live, is the named absence (no call nobody can be charged for)", async () => {
    const r = await withLayoverRoutesBudget({ userId: U1, tripId: null }, async () => layoverRoutesRefusal(), { readEnv: LIVE });
    assert.equal(r, ROUTES_UNSCOPED_NO_SESSION);
  });
  it("S4. a Trips budget carries no layover key at all — Trips' behaviour is byte-identical", async () => {
    await withRoutesRequestBudget({ userId: U1, tripId: "trip-9" }, async () => {
      assert.equal(Object.prototype.hasOwnProperty.call(currentRoutesRequestBudget(), "layoverSessionId"), false);
    });
  });
});
