/**
 * Registration guard — the intel routers are actually MOUNTED in routes/index.ts.
 *
 * Every other test for these endpoints mounts the router under test DIRECTLY
 * (`app.use("/api", intelObservabilityRouter)`), which proves the handler works
 * but proves nothing about whether the real server ever reaches it. Commenting
 * out `router.use(intelObservabilityRouter)` in routes/index.ts left all 56 of
 * those tests green: the endpoint could ship as a 404 with a fully green suite.
 *
 * So this file mounts the COMPOSED router — the same default export
 * routes/index.ts hands the server — and asserts each path is reachable through
 * it. Reachability, not authorization, is the property: an unauthenticated
 * request must be REJECTED BY THE HANDLER'S OWN GATE (401/403), never answered
 * 404 by express because nothing claimed the path. A control path that is
 * deliberately not registered pins the other side of that distinction, so a
 * future change which makes the app answer non-404 for everything cannot make
 * these assertions vacuous.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/intelRouterRegistrationGuard.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";

const SOME_UUID = "41111111-1111-4111-8111-111111111111";

/**
 * A client that exists but authenticates nobody. It has to EXIST, or the
 * handlers answer 503 server_not_configured — which is still "not 404", but a
 * far weaker signal: 503 is also what a misconfigured app returns for a path it
 * never routed. With a client present the only way to see 401 is for the
 * request to have reached the handler's own auth gate.
 */
function unauthenticatedClient() {
  return {
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async getUser() {
        return { data: { user: null }, error: { message: "no token" } };
      },
    },
    from() {
      throw new Error("no handler under test may reach the database unauthenticated");
    },
  };
}

/** The composed router, exactly as the server mounts it. */
async function makeComposedApp(): Promise<Express> {
  const { default: composedRouter } = await import("../routes/index.js");
  const app = express();
  app.use(express.json());
  app.use("/api", composedRouter);
  return app;
}

async function statusOf(app: Express, path: string): Promise<number> {
  const server = createServer(app);
  // Bind loopback explicitly — a host-less listen(0) binds [::] and a foreign
  // IPv4 listener can steal the request.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return res.status;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

let app: Express;

describe("intel routers are registered in routes/index.ts (not just directly mountable)", () => {
  before(async () => {
    // Every handler below must refuse at its OWN auth gate (401), which is
    // precisely the non-404 signal that proves the request reached it.
    _setTestClient(unauthenticatedClient(), true);
    app = await makeComposedApp();
  });
  after(() => { _clearTestClient(); });

  it("an unregistered path really does 404 through the composed router (the control)", async () => {
    const status = await statusOf(app, "/api/v1/internal/intel/definitely-not-registered");
    assert.equal(status, 404, "without this, 'not 404' would prove nothing");
  });

  it("GET /v1/internal/intel/observability is reachable (§24/Table-32 admin read)", async () => {
    const status = await statusOf(app, "/api/v1/internal/intel/observability");
    assert.notEqual(status, 404, "intelObservabilityRouter is not mounted in routes/index.ts");
    assert.ok(
      status === 401 || status === 403,
      `expected the handler's own admin gate to reject (401/403), got ${status}`,
    );
  });

  it("GET /v1/experiences/:id/live-state is reachable (§19 read model)", async () => {
    const status = await statusOf(app, `/api/v1/experiences/${SOME_UUID}/live-state`);
    assert.notEqual(status, 404, "intelReadModelsRouter is not mounted in routes/index.ts");
    assert.ok(status === 401 || status === 403, `expected an auth rejection, got ${status}`);
  });

  it("GET /v1/experiences/:id/typical-patterns is reachable (§19 read model)", async () => {
    const status = await statusOf(app, `/api/v1/experiences/${SOME_UUID}/typical-patterns`);
    assert.notEqual(status, 404, "intelReadModelsRouter is not mounted in routes/index.ts");
    assert.ok(status === 401 || status === 403, `expected an auth rejection, got ${status}`);
  });

  it("GET /v1/intel/prompt-eligibility is reachable (§6 prompt gate)", async () => {
    const status = await statusOf(app, `/api/v1/intel/prompt-eligibility?subjectId=${SOME_UUID}`);
    assert.notEqual(status, 404, "intelReadModelsRouter is not mounted in routes/index.ts");
    assert.ok(status === 401 || status === 403, `expected an auth rejection, got ${status}`);
  });
});
