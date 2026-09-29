/**
 * census-discovery §103 (DV-83, W11-X2 round 7; D-W11X2-50): GET /compass/feed/section's
 * failed reads are said, never answered as "Compass is disabled".
 *
 * The section is read by Discovery's For You tab (CompassPicksSection, ForYouTab). §102.11
 * finding 3: the build-error catch arm answered `{ section: null, fallback: true, safeItems }`
 * with no `compassEnabled` and no refusal, which the client read as the disabled arm and hid.
 * The sweep found the same through the disabled arm itself: an unread COMPASS_% flag table
 * answered `compassEnabled: false`.
 *
 * The fake is minimal and loud: the flag table and the ban gate's profile read answer as
 * configured; every other read REJECTS, which is how the build fails here.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "ab000000-0000-4000-a000-000000000001";
const TOKEN = "tok-compass-viewer";

type Flags = { rows: Array<{ flag: string; enabled: boolean }> } | { error: { code: string; message: string } };

function fakeClient(flags: Flags) {
  const reject = () => Promise.reject(new Error("section build: read failed"));
  function builder(table: string) {
    const named: Record<string, unknown> = {};
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          if (table === "feature_flags" && named.like !== undefined) {
            const answer = "error" in flags ? { data: null, error: flags.error } : { data: flags.rows, error: null };
            return (f: any, r: any) => Promise.resolve(answer).then(f, r);
          }
          if (table === "feature_flags") return (f: any, r: any) => Promise.resolve({ data: null, error: null }).then(f, r);
          return (f: any, r: any) => reject().then(f, r);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            if (table === "profiles" && named.select === "account_status") return Promise.resolve({ data: { account_status: "active" }, error: null });
            if (table === "feature_flags") return Promise.resolve({ data: null, error: null });
            return reject();
          };
        }
        return (...args: unknown[]) => { named[prop] = args[0]; return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (table: string) => builder(table),
    rpc: () => reject(),
  };
}

let base = "";
let server: Server;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { invalidateFlagsCache(); _resetRateLimit(); });

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() };
}

describe("§103 GET /compass/feed/section — a failed read is not the disabled arm (D-W11X2-50)", () => {
  it("S1 the section build FAILS → the body names the failure (fallbackReason + refusal), and says Compass is on", async () => {
    _setTestClient(fakeClient({ rows: [{ flag: "COMPASS_ENABLED", enabled: true }] }) as any, true);
    const { status, body } = await get("/compass/feed/section/compass_picks?city=Paris");
    assert.equal(status, 200);
    assert.equal(body.section, null);
    assert.equal(body.fallback, true);
    assert.equal(body.compassEnabled, true, "a build failure is not Compass switched off");
    assert.equal(body.fallbackReason, "section_build_error");
    assert.deepEqual(body.safeItems, []);
    assert.deepEqual(body.refusal, { class: "transient_db", code: "section_build_error", route: "GET /compass/feed/section", coverage: "nothing", failedSources: ["compass_section"] });
  });

  it("S2 the COMPASS_% flag read FAILS → not `compassEnabled: false`; the body names the unread flag table", async () => {
    _setTestClient(fakeClient({ error: { code: "57014", message: "canceling statement due to statement timeout" } }) as any, true);
    const { status, body } = await get("/compass/feed/section/compass_picks?city=Paris");
    assert.equal(status, 200);
    assert.notEqual(body.compassEnabled, false, "an unread flag table is not an off switch");
    assert.equal(body.fallbackReason, "compass_flags_unreadable");
    assert.deepEqual(body.refusal, { class: "transient_db", code: "compass_flags_unreadable", route: "GET /compass/feed/section", coverage: "nothing", failedSources: ["feature_flags"] });
  });

  it("C1 CONTROL: flags READ and Compass OFF → the disabled arm, byte-identical", async () => {
    _setTestClient(fakeClient({ rows: [{ flag: "COMPASS_ENABLED", enabled: false }] }) as any, true);
    const { status, body } = await get("/compass/feed/section/compass_picks?city=Paris");
    assert.equal(status, 200);
    assert.deepEqual(body, { section: null, nextCursor: null, fallback: true, compassEnabled: false });
  });

  it("C2 CONTROL: flags READ with no COMPASS_ENABLED row → the disabled arm (an absent flag is off, as before)", async () => {
    _setTestClient(fakeClient({ rows: [] }) as any, true);
    const { body } = await get("/compass/feed/section/compass_picks?city=Paris");
    assert.deepEqual(body, { section: null, nextCursor: null, fallback: true, compassEnabled: false });
  });
});
