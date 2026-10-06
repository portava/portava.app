/**
 * beta-smoke.test.ts — the beta smoke check against a STUBBED fetch.
 *
 * A healthy beta passes all four checks; each way a beta can be wrong fails
 * the check that names it; every request is a GET (the smoke never writes);
 * and the smoke refuses to run against production's origin.
 *
 * Run: pnpm --dir scripts run test:beta-smoke
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NOT_CHECKED, runBetaSmoke, smokeBaseRefusal, type SmokeFetch } from "./beta-smoke.js";

const BASE = "https://portava-beta.replit.app";

type Routes = Record<string, { status: number; body: unknown }>;

const HEALTHY: Routes = {
  "/api/healthz": { status: 200, body: { status: "ok" } },
  "/api/auth/signup-status": { status: 200, body: { signupsEnabled: false, inviteOnly: true } },
  "/api/verification/status": { status: 401, body: { error: "unauthenticated" } },
  "/api/rent-a-buddy/launch-status": { status: 200, body: { enabled: false, categories: {} } },
};

function stub(routes: Routes) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetch: SmokeFetch = async (url, init) => {
    calls.push({ method: init.method, url });
    const path = url.replace(BASE, "");
    const r = routes[path] ?? { status: 404, body: { error: "not_found" } };
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

describe("beta-smoke", () => {
  it("a correctly configured beta passes every check, with GETs only", async () => {
    const s = stub(HEALTHY);
    const results = await runBetaSmoke(`${BASE}/`, s.fetch);
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ["health", true],
      ["sign-up closed (invite-only)", true],
      ["auth required", true],
      ["no Rent-a-Buddy bookings", true],
    ]);
    assert.ok(s.calls.every((c) => c.method === "GET"));
    assert.deepEqual(s.calls.map((c) => c.url), Object.keys(HEALTHY).map((p) => `${BASE}${p}`));
  });

  const broken: Array<[string, string, { status: number; body: unknown }]> = [
    ["health", "/api/healthz", { status: 503, body: { status: "down" } }],
    ["sign-up closed (invite-only)", "/api/auth/signup-status", { status: 200, body: { signupsEnabled: true, inviteOnly: true } }],
    ["sign-up closed (invite-only)", "/api/auth/signup-status", { status: 200, body: { signupsEnabled: false, inviteOnly: false } }],
    ["sign-up closed (invite-only)", "/api/auth/signup-status", { status: 503, body: { signupsEnabled: false, inviteOnly: false } }],
    ["auth required", "/api/verification/status", { status: 200, body: {} }],
    ["auth required", "/api/verification/status", { status: 503, body: { error: "server_not_configured" } }],
    ["no Rent-a-Buddy bookings", "/api/rent-a-buddy/launch-status", { status: 200, body: { enabled: true, categories: {} } }],
  ];
  for (const [name, path, reply] of broken) {
    it(`FAILS "${name}" when ${path} answers ${reply.status} ${JSON.stringify(reply.body)}`, async () => {
      const results = await runBetaSmoke(BASE, stub({ ...HEALTHY, [path]: reply }).fetch);
      const failed = results.filter((r) => !r.ok).map((r) => r.name);
      assert.deepEqual(failed, [name]);
    });
  }

  it("a request that does not complete is a FAIL, not a skip", async () => {
    const fetch: SmokeFetch = async () => { throw new Error("ECONNREFUSED"); };
    const results = await runBetaSmoke(BASE, fetch);
    assert.equal(results.length, 4);
    assert.ok(results.every((r) => !r.ok && /did not complete/.test(r.detail)));
  });

  it("refuses production's origin, a missing base and a non-URL", () => {
    assert.match(String(smokeBaseRefusal("https://portava.replit.app")), /PRODUCTION/);
    assert.ok(smokeBaseRefusal(null));
    assert.ok(smokeBaseRefusal("portava-beta"));
    assert.ok(smokeBaseRefusal("http://portava-beta.replit.app"));
    assert.equal(smokeBaseRefusal(BASE), null);
  });

  it("says plainly what it cannot check", () => {
    assert.equal(NOT_CHECKED.length, 2);
    assert.match(NOT_CHECKED.join(" "), /identity-verification readiness/);
    assert.match(NOT_CHECKED.join(" "), /NODE_ENV=production/);
  });
});
