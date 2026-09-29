/**
 * Testing-mode WP-12 (lane tm-followups) — the Compass memory surfaces say
 * when they could not read, instead of rendering "nothing remembered".
 *
 * THE DEFECT. `buildRememberSurface` (§12 "What Portava Remembers") and the §5
 * recap / On This Day builders read each source in a fail-available way:
 * supabase-js RESOLVES on a database error, and every builder either ignored
 * `error` or folded it into `[]`. So an owner whose `memory_remembers_for_user`
 * function is missing (2213 not applied), or whose Postcards table was
 * unreadable, was shown a well-formed, EMPTY group — "Portava remembers nothing
 * about you here" — which is a false statement on a transparency surface. Two
 * sharper cases: an unreadable `memory_feedback` meant every item the owner had
 * FORGOTTEN came back on screen, and in a recap it would have been RESURFACED;
 * and an unreadable trip read answered "Trip not found."
 *
 * THE RULE NOW (additive to the response; nothing is removed):
 *   - every group carries `availability: "ok" | "unavailable"`, and the surface
 *     carries `unavailable: [...]` — a group whose read failed is never "ok";
 *   - an unreadable suppression set WITHHOLDS the source groups it governs
 *     (reported unavailable), so a forgotten item never reappears;
 *   - a recap / On This Day whose suppression read fails is REFUSED (db_error),
 *     never generated without the owner's forgets;
 *   - a recap lists the sections it could not read in `unavailable`;
 *   - a failed trip read is an error, not "Trip not found.".
 * Controls: a healthy read reports every group "ok" and `unavailable: []`.
 *
 * Run: node --import tsx/esm --test src/test/tmCompassMemoryHonesty.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-00000000ae01";
const TRIP = "7a7a7a7a-0000-4000-8000-000000000001";

interface Seed {
  failTables?: Record<string, string>;   // table → pg code to fail every read with
  failRpc?: Record<string, string>;      // rpc name → pg code
  failInsert?: Record<string, string>;   // table → pg code for inserts
  failFirstRead?: Record<string, string>; // table → pg code for its FIRST read only
  rows?: Record<string, any[]>;
  single?: Record<string, any>;
}

function makeClient(seed: Seed = {}) {
  const rows = seed.rows ?? {};
  const single: Record<string, any> = { profiles: { account_status: "active", home_city: "Lisbon" }, feature_flags: { enabled: true }, ...(seed.single ?? {}) };
  const err = (code: string, what: string) => ({ data: null, error: { code, message: `${what} failed (${code})` } });
  return {
    auth: { getUser: async () => ({ data: { user: { id: ALICE } }, error: null }) },
    rpc: async (name: string) => {
      if (seed.failRpc?.[name]) return err(seed.failRpc[name]!, name);
      return { data: rows[`rpc:${name}`] ?? [], error: null };
    },
    from: (table: string) => {
      const first = seed.failFirstRead?.[table];
      if (first) delete seed.failFirstRead![table];
      const failCode = seed.failTables?.[table] ?? first;
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => (failCode ? err(failCode, table) : { data: single[table] ?? null, error: null }),
        insert: async () => (seed.failInsert?.[table] ? err(seed.failInsert[table]!, `${table} insert`) : { data: null, error: null }),
        then: (ok: any, bad: any) => Promise.resolve(failCode ? err(failCode, table) : { data: rows[table] ?? [], error: null }).then(ok, bad),
      };
      return chain;
    },
  } as any;
}

let server: Server;
let port: number;

before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
});
after(() => { server.close(); _setTestClient(null as any, false); });

async function api(method: string, path: string, client: any, body?: unknown) {
  _setTestClient(client, true);
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer alice" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

const group = (surface: any, g: string) => (surface.groups ?? []).find((x: any) => x.group === g);
const postcard = { id: "pc1", caption: "Beach day", status: "active", visibility: "private", deleted_at: null, created_at: "2025-09-29T12:00:00.000Z" };

describe("GET /compass/me/passport/remembers — a failed read is stated, never 'nothing remembered'", () => {
  it("control: a healthy read reports every group ok and nothing unavailable", async () => {
    const r = await api("GET", "/compass/me/passport/remembers", makeClient({ rows: { passport_postcards: [postcard] } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.unavailable, []);
    for (const g of r.body.groups) assert.equal(g.availability, "ok", `${g.group} should be ok`);
  });

  it("a missing memory_remembers_for_user (2213 not applied) marks derived memory UNAVAILABLE, not empty-and-ok", async () => {
    const r = await api("GET", "/compass/me/passport/remembers", makeClient({ failRpc: { memory_remembers_for_user: "42883" } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(group(r.body, "derived_memory").availability, "unavailable");
    assert.ok(r.body.unavailable.includes("derived_memory"));
    assert.equal(group(r.body, "profile").availability, "ok", "an unrelated group is unaffected");
  });

  it("an unreadable source table marks its group unavailable (saved content: postcards)", async () => {
    const r = await api("GET", "/compass/me/passport/remembers", makeClient({ failTables: { passport_postcards: "42P01" } }));
    assert.equal(group(r.body, "saved_content").availability, "unavailable");
    assert.ok(r.body.unavailable.includes("saved_content"));
  });

  it("an unreadable profiles read marks 'About you' unavailable", async () => {
    const client = makeClient();
    const base = client.from;
    // requireUser reads profiles through the user client; only the builder's read fails.
    let n = 0;
    client.from = (t: string) => (t === "profiles" && ++n > 1 ? makeClient({ failTables: { profiles: "57014" } }).from(t) : base(t));
    const r = await api("GET", "/compass/me/passport/remembers", client);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(group(r.body, "profile").availability, "unavailable");
  });

  it("an unreadable memory_feedback WITHHOLDS the source groups, so a forgotten item cannot reappear", async () => {
    const r = await api("GET", "/compass/me/passport/remembers", makeClient({
      failTables: { memory_feedback: "57014" },
      rows: { passport_postcards: [postcard] },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const saved = group(r.body, "saved_content");
    assert.equal(saved.availability, "unavailable");
    assert.deepEqual(saved.items, [], "a postcard the owner may have forgotten is not shown on an unchecked suppression read");
    assert.equal(group(r.body, "derived_memory").availability, "ok", "derived memory is suppressed in SQL, so it stays");
  });

  it("correct: a missing memory_feedback.corrected_value (2213) is a stated db_error, not 201", async () => {
    const r = await api("POST", "/compass/me/passport/remembers/correct", makeClient({ failInsert: { memory_feedback: "42703" } }), {
      subjectType: "city", subjectId: "Lisbon", correctedValue: "Porto",
    });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });
});

describe("GET /compass/me/recaps and /on-this-day — honest about what they could not read", () => {
  it("control: a healthy recap reports unavailable: []", async () => {
    const r = await api("GET", "/compass/me/recaps?kind=year&year=2025", makeClient({ rows: { passport_postcards: [postcard] } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.unavailable, []);
  });

  it("a missing memory_recaps_for_user (2214) lists derived memory as unavailable", async () => {
    const r = await api("GET", "/compass/me/recaps?kind=year&year=2025", makeClient({ failRpc: { memory_recaps_for_user: "42883" } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.unavailable.includes("derived_memory"), JSON.stringify(r.body));
  });

  it("an unreadable memory_feedback REFUSES the recap — it is never built without the owner's forgets", async () => {
    const r = await api("GET", "/compass/me/recaps?kind=year&year=2025", makeClient({ failTables: { memory_feedback: "57014" }, rows: { passport_postcards: [postcard] } }));
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  it("the §12 suppression read failing ALONE (the not_interested read answering) still refuses", async () => {
    const r = await api("GET", "/compass/me/recaps?kind=year&year=2025", makeClient({ failFirstRead: { memory_feedback: "57014" }, rows: { passport_postcards: [postcard] } }));
    assert.equal(r.status, 500, JSON.stringify(r.body));
  });

  it("a failed trip read is an error, not 'Trip not found.'", async () => {
    const r = await api("GET", `/compass/me/recaps?kind=trip&tripId=${TRIP}`, makeClient({ failTables: { trips: "57014" } }));
    assert.equal(r.status, 500, JSON.stringify(r.body));
  });

  it("on-this-day: an unreadable postcards table is listed, not folded into 'no anniversaries'", async () => {
    const r = await api("GET", "/compass/me/on-this-day", makeClient({ failTables: { passport_postcards: "42P01" } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.unavailable.includes("saved_content"), JSON.stringify(r.body));
  });

  it("on-this-day: an unreadable memory_feedback refuses (db_error)", async () => {
    const r = await api("GET", "/compass/me/on-this-day", makeClient({ failTables: { memory_feedback: "57014" } }));
    assert.equal(r.status, 500, JSON.stringify(r.body));
  });
});
