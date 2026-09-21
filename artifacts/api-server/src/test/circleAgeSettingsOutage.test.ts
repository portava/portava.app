/**
 * AN UNREADABLE AGE LIMIT IS NOT "NO AGE LIMIT".
 *
 * GET /api/circle-age-settings/:ownerId is the read the circle-invite accept
 * path uses to decide whether an age limit applies to someone joining another
 * user's trusted circle. `ageLimitEnabled: false` is the PERMISSIVE answer, and
 * two paths said it without a read that succeeded:
 *
 *   no service client   the permissive shape was returned outright, so a boot-
 *                       order or configuration problem reported "this circle
 *                       has no age limit" for every owner, silently.
 *   unbound `.error`    supabase-js RESOLVES on a database error, so an
 *                       unreadable `circle_age_settings` fell into `if (!data)`
 *                       and answered exactly the same way.
 *
 * A row that is genuinely ABSENT and a row that could not be READ are opposite
 * facts here: the first means the owner set no limit, the second means we do not
 * know whether they did. Collapsing them turns an outage into a disabled age
 * gate — the fail-OPEN direction, on a control that exists to keep minors and
 * adults out of circles they were excluded from.
 *
 * PAIRING: the outage case and the genuinely-absent case use the SAME route and
 * differ only in whether the read is allowed to succeed. The absent case must
 * still return the permissive shape — a fix that refused everything would fail
 * it — and a present, readable limit must still be reported as enabled.
 *
 * Run: node --import tsx/esm --test src/test/circleAgeSettingsOutage.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import ageRouter from "../routes/circleAgeSettings.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";

const DB_ERROR = { code: "42501", message: "permission denied for table circle_age_settings" };

type Rows = Record<string, any[]>;

function makeClient(rows: Rows, failTables: string[]) {
  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    let kind = "read";
    const b: any = {
      select() { return b; },
      insert() { kind = "w"; return b; },
      update() { kind = "w"; return b; },
      upsert() { kind = "w"; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(f: any, r: any) { return run(false).then(f, r); },
    };
    async function run(single: boolean): Promise<any> {
      if (failTables.includes(table)) return { data: null, error: DB_ERROR, count: null };
      if (kind === "w") return { data: null, error: null, count: null };
      let out: any[] = rows[table] ?? [];
      for (const [c, v] of eqs) out = out.filter((r) => r[c] === v);
      if (single) return { data: out[0] ?? null, error: null, count: out.length };
      return { data: out, error: null, count: out.length };
    }
    return b;
  }
  return {
    from,
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  } as any;
}

function baseRows(): Rows {
  return {
    // requireUser reads the CALLER's account_status; it must stay readable, or
    // the 503 under test would come from the auth gate instead of the handler.
    profiles: [
      { id: VIEWER, account_status: "active" },
      { id: OWNER, account_status: "active" },
    ],
    circle_age_settings: [],
  };
}

async function startApp(rows: Rows, failTables: string[] = []) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", ageRouter);
  const client = makeClient(rows, failTables);
  _setTestServiceClient(client);
  _setTestClient(client, true);
  const server = createServer(app);
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { baseUrl, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: "Bearer tok" } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

let inspected = 0;
function checked<T>(v: T): T { inspected += 1; return v; }

afterEach(() => { _setTestServiceClient(null); _setTestClient(null, false); });

describe("GET /circle-age-settings/:ownerId", () => {
  it("POSITIVE CONTROL: a readable enabled limit is reported as enabled", async () => {
    const rows = baseRows();
    rows.circle_age_settings = [
      { owner_id: OWNER, age_limit_enabled: true, min_age: 21, max_age: 40, updated_at: "2026-01-01T00:00:00Z" },
    ];
    const app = await startApp(rows);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle-age-settings/${OWNER}`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.ageLimitEnabled), true);
      assert.equal(checked(body.minAge), 21);
      assert.equal(checked(body.maxAge), 40);
    } finally { await app.close(); }
  });

  it("NEGATIVE CONTROL: a genuinely absent row still reports no age limit", async () => {
    // A SUCCESSFUL read that found nothing. This must keep working, or the fix
    // would just be "refuse everything".
    const app = await startApp(baseRows());
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle-age-settings/${OWNER}`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.ageLimitEnabled), false);
      assert.equal(checked(body.minAge), null);
    } finally { await app.close(); }
  });

  it("refuses (503) rather than disabling the age limit when the table is unreadable", async () => {
    // Same fixture as the positive control — the limit IS set and IS enabled.
    const rows = baseRows();
    rows.circle_age_settings = [
      { owner_id: OWNER, age_limit_enabled: true, min_age: 21, max_age: 40, updated_at: "2026-01-01T00:00:00Z" },
    ];
    const app = await startApp(rows, ["circle_age_settings"]);
    try {
      const { status, body } = await get(app.baseUrl, `/api/circle-age-settings/${OWNER}`);
      assert.equal(checked(status), 503, "an outage must not disable an age gate");
      assert.equal(checked(body.error), "degraded_unavailable");
      assert.equal(checked(body.retryable), true);
      assert.equal(
        checked(body.ageLimitEnabled), undefined,
        "no age-limit verdict may be present at all",
      );
    } finally { await app.close(); }
  });

  // NOT TESTED HERE, DELIBERATELY: the `if (!sc)` refusal above it. An earlier
  // draft of this file had a case for it that PASSED AND MEANT NOTHING —
  // getServiceClient() answers from the environment, so `_setTestServiceClient(null)`
  // does not produce a null client; the route got a real client pointed at an
  // unreachable host, supabase-js resolved `{ data: null, error: "fetch failed" }`,
  // and the 503 the test asserted came from the ERROR guard already covered
  // above. It also took 7 seconds. A test that cannot fail for its stated reason
  // is worse than no test, so it was removed rather than left to look like
  // coverage; the no-client branch is verified by inspection only.
});

describe("the assertion count is non-zero", () => {
  it("inspected a non-vacuous number of assertions", () => {
    assert.ok(inspected >= 11, `expected >=11 checked assertions, got ${inspected}`);
  });
});
