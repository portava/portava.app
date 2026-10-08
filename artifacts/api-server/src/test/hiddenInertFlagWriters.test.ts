/**
 * Every admin route that can write `feature_flags` refuses a hidden/retired
 * flag, through ONE guard (lib/hiddenInertFlags.ts), and the client flag
 * bundle never carries one (verifier F9, 2026-10-06).
 *
 * The retired Rent-a-Buddy KYC override (3932) is the case that matters: the
 * gate reads nothing, so a row an admin re-creates or flips TRUE opens nothing,
 * but it would read to an operator as a lever.
 *
 * Writers covered:
 *   PUT   /admin/feature-flags/:flag              routes/adminVisuals.ts
 *   PATCH /admin/visuals/feature-flags/:flag      routes/adminVisuals.ts
 *   PATCH /admin/compass/frontload-rules          routes/adminCompass.ts (an UPSERT)
 *   GET   /feature-flags                          routes/featureFlags.ts (the client bundle)
 * routes/admin.ts PATCH and /metadata are covered in featureFlagList.test.ts /
 * featureFlagAudit.test.ts and read the same set.
 *
 * Run: node --import tsx/esm --test src/test/hiddenInertFlagWriters.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { HIDDEN_INERT_FLAGS, isHiddenInertFlag } from "../lib/hiddenInertFlags.js";

const ADMIN = "aaaaaaaa-0000-4000-8000-00000000000a";
const RETIRED = "rent_buddy_allow_bookings_without_kyc";

interface World {
  flagRows: Array<{ flag: string; enabled: boolean; description?: string }>;
  rpcCalls: Array<{ fn: string; args: unknown }>;
  upserts: unknown[];
}
let world: World;

function makeClient() {
  const builder = (table: string): any => {
    const f: Record<string, unknown> = {};
    let op: "select" | "upsert" | "update" = "select";
    const settle = (single: boolean) => {
      if (table === "profiles") {
        const row = { id: ADMIN, role: "admin", account_status: "active", display_name: "A", username: "a", handle: "a" };
        return { data: single ? row : [row], error: null };
      }
      if (table === "feature_flags") {
        if (op !== "select") return { data: [{ flag: "x" }], error: null };
        const rows = world.flagRows.filter((r) => f["flag"] === undefined || r.flag === f["flag"]);
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      return { data: single ? null : [], error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { f[c] = v; return b; },
      in: () => b, order: () => b, limit: () => b, is: () => b, gte: () => b, lte: () => b, neq: () => b,
      upsert: (row: unknown) => { op = "upsert"; world.upserts.push(row); return b; },
      update: () => { op = "update"; return b; },
      insert: () => b,
      maybeSingle: async () => settle(true),
      single: async () => settle(true),
      then: (res: any, rej: any) => Promise.resolve(settle(false)).then(res, rej),
    };
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: unknown) => {
      world.rpcCalls.push({ fn, args });
      return { data: [{ flag: (args as any)?.p_flag, enabled: (args as any)?.p_new_enabled, description: null, updated_at: "2026-10-06T00:00:00Z", changed_at: "2026-10-06T00:00:00Z", old_enabled: false }], error: null };
    },
  };
}

let server: http.Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  const { default: adminVisuals } = await import("../routes/adminVisuals.js");
  const { default: adminCompass } = await import("../routes/adminCompass.js");
  const { default: featureFlags } = await import("../routes/featureFlags.js");
  app.use("/api", adminVisuals, adminCompass, featureFlags);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });
beforeEach(() => {
  world = {
    flagRows: [
      { flag: "ai_visual_admin_review_enabled", enabled: true },
      { flag: RETIRED, enabled: true },
      { flag: "freeze_city", enabled: true },
      { flag: "rent_buddy_enabled", enabled: true },
    ],
    rpcCalls: [],
    upserts: [],
  };
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe("F9 — the one list", () => {
  it("names the retired KYC override with every flag retired before it", () => {
    for (const f of [RETIRED, "freeze_city", "freeze_booking", "intel_sensing_credentials_enabled", "COMPASS_FRONTLOAD_ENABLED", "notifications_enabled"]) {
      assert.equal(isHiddenInertFlag(f), true, f);
    }
    assert.equal(isHiddenInertFlag("rent_buddy_enabled"), false, "a real flag is not hidden");
    assert.equal(HIDDEN_INERT_FLAGS.size, 17);
  });
});

describe("F9 — every admin writer refuses a hidden flag before writing", () => {
  for (const [name, method, path] of [
    ["adminVisuals PUT", "PUT", `/api/admin/feature-flags/${RETIRED}`],
    ["adminVisuals PATCH", "PATCH", `/api/admin/visuals/feature-flags/${RETIRED}`],
  ] as const) {
    it(`${name}: 400 not_operational, no toggle RPC`, async () => {
      const r = await call(method, path, { enabled: true });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body?.error, "not_operational");
      assert.deepEqual(world.rpcCalls, []);
    });
  }

  it("adminVisuals control: a real flag still reaches the audited toggle", async () => {
    const r = await call("PUT", "/api/admin/feature-flags/rent_buddy_enabled", { enabled: false });
    assert.notEqual(r.body?.error, "not_operational", JSON.stringify(r.body));
    assert.equal(world.rpcCalls.length, 1);
  });

  it("adminCompass frontload-rules: a hidden flag anywhere in the request refuses ALL of it, nothing upserted", async () => {
    const r = await call("PATCH", "/api/admin/compass/frontload-rules", { rules: [{ flag: "COMPASS_REAL_RULE", enabled: true }, { flag: RETIRED, enabled: true }] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.error, "not_operational");
    assert.deepEqual(world.upserts, [], "not even the legitimate rule");
  });

  it("adminCompass control: legitimate rules are upserted", async () => {
    const r = await call("PATCH", "/api/admin/compass/frontload-rules", { rules: [{ flag: "COMPASS_REAL_RULE", enabled: true }] });
    assert.notEqual(r.status, 400, JSON.stringify(r.body));
    assert.equal(world.upserts.length, 1);
  });
});

describe("F9 — the client flag bundle never carries a hidden flag", () => {
  it("GET /feature-flags omits the retired KYC override and freeze_city even when their rows read TRUE", async () => {
    const r = await call("GET", "/api/feature-flags");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(RETIRED in r.body.flags, false);
    assert.equal("freeze_city" in r.body.flags, false);
    assert.equal(r.body.flags["rent_buddy_enabled"], true, "a real flag is still served");
  });
});
