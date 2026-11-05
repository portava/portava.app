/**
 * CORS in production vs outside it (sec/public-surface, 2026-11-04;
 * docs/security/cors-dev-domain-allowlist-in-production.md).
 *
 * The finding: production has REPLIT_DEV_DOMAIN set, so app.ts echoed back ANY
 * subdomain of the shared kirk.replit.dev with `credentials: true`. Fixed rule:
 * the workspace-preview origins are allowed only outside production
 * (NODE_ENV=production or REPLIT_DEPLOYMENT present is production), and the
 * fallback allowlist names production's live origin, rumazi.com.
 *
 * The app half drives the REAL app.ts. ALLOWED_ORIGINS is removed before it is
 * imported, so the fallback list is the allowlist; the environment checks are
 * read per request, so one process shows both answers.
 *
 * "When this is fixed, the first line must join the other two" (the finding's
 * reproduction): an invented kirk.replit.dev subdomain is now refused in
 * production, like evil.example.com and notkirk.replit.dev.
 *
 * Run: node --import tsx/esm --test src/test/corsProductionOrigins.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isProductionRuntime, replitDevOriginAllowed } from "../lib/corsOrigins.js";

const DEV_DOMAIN = "abc123.kirk.replit.dev";

describe("lib/corsOrigins.ts", () => {
  it("production is NODE_ENV=production OR REPLIT_DEPLOYMENT present (an empty value counts)", () => {
    assert.equal(isProductionRuntime({}), false);
    assert.equal(isProductionRuntime({ NODE_ENV: "development" }), false);
    assert.equal(isProductionRuntime({ NODE_ENV: "production" }), true);
    assert.equal(isProductionRuntime({ REPLIT_DEPLOYMENT: "1" }), true);
    assert.equal(isProductionRuntime({ REPLIT_DEPLOYMENT: "" }), true);
  });

  const dev = { REPLIT_DEV_DOMAIN: DEV_DOMAIN };
  it("outside production: the dev domain, its :port form and its parent's subdomains", () => {
    for (const o of [`https://${DEV_DOMAIN}`, `https://${DEV_DOMAIN}:3000`, "https://abc123.expo.kirk.replit.dev", "https://someone-else.kirk.replit.dev"]) {
      assert.equal(replitDevOriginAllowed(o, dev), true, o);
    }
    for (const o of ["https://notkirk.replit.dev", "https://kirk.replit.dev", "https://evil.example.com"]) {
      assert.equal(replitDevOriginAllowed(o, dev), false, o);
    }
  });

  it("in production: none of them, whatever REPLIT_DEV_DOMAIN says", () => {
    for (const env of [{ ...dev, REPLIT_DEPLOYMENT: "1" }, { ...dev, NODE_ENV: "production" }]) {
      for (const o of [`https://${DEV_DOMAIN}`, `https://${DEV_DOMAIN}:3000`, "https://totally-random-xyz-9999.kirk.replit.dev"]) {
        assert.equal(replitDevOriginAllowed(o, env), false, `${o} ${JSON.stringify(env)}`);
      }
    }
  });

  it("no REPLIT_DEV_DOMAIN: nothing extra is allowed", () => {
    assert.equal(replitDevOriginAllowed("https://abc123.kirk.replit.dev", {}), false);
  });
});

// ── The real app.ts ───────────────────────────────────────────────────────────

function get(server: http.Server, origin: string): Promise<{ status: number; acao: string | undefined; credentials: string | undefined }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as { port: number };
    const req = http.request({ hostname: "127.0.0.1", port, path: "/api/healthz", method: "GET", headers: { origin } }, (res) => {
      res.resume();
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        acao: res.headers["access-control-allow-origin"] as string | undefined,
        credentials: res.headers["access-control-allow-credentials"] as string | undefined,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("app.ts CORS", () => {
  let server: http.Server;
  const saved = { NODE_ENV: process.env.NODE_ENV, REPLIT_DEPLOYMENT: process.env.REPLIT_DEPLOYMENT };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  before(async () => {
    delete process.env.ALLOWED_ORIGINS; // the fallback list is the allowlist
    process.env.REPLIT_DEV_DOMAIN = DEV_DOMAIN;
    delete process.env.REPLIT_DEPLOYMENT;
    const app = (await import("../app.js")).default;
    server = await new Promise<http.Server>((r) => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => r(s)); });
  });
  after(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(restore);

  it("the fallback allowlist admits production's live origin, rumazi.com (and www)", async () => {
    for (const o of ["https://rumazi.com", "https://www.rumazi.com", "https://portava.replit.app"]) {
      const r = await get(server, o);
      assert.equal(r.status, 200, o);
      assert.equal(r.acao, o);
    }
  });

  it("outside production, a workspace preview origin is echoed (the dev convenience still works)", async () => {
    delete process.env.REPLIT_DEPLOYMENT;
    process.env.NODE_ENV = "development";
    const r = await get(server, "https://abc123.expo.kirk.replit.dev");
    assert.equal(r.acao, "https://abc123.expo.kirk.replit.dev");
  });

  for (const [label, env] of [
    ["REPLIT_DEPLOYMENT=1 (every published deployment)", { REPLIT_DEPLOYMENT: "1" }],
    ["NODE_ENV=production", { NODE_ENV: "production" }],
  ] as const) {
    it(`in production (${label}), an invented kirk.replit.dev subdomain is refused like any other origin`, async () => {
      Object.assign(process.env, env);
      for (const o of ["https://totally-random-xyz-9999.kirk.replit.dev", `https://${DEV_DOMAIN}`, "https://evil.example.com", "https://notkirk.replit.dev"]) {
        const r = await get(server, o);
        assert.equal(r.acao, undefined, `${o} must not be echoed`);
        assert.notEqual(r.credentials, "true", o);
      }
      // …while the allowlist itself is unaffected.
      assert.equal((await get(server, "https://rumazi.com")).acao, "https://rumazi.com");
    });
  }
});
