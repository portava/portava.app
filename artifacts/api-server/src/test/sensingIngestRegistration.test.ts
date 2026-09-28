/**
 * Registration guard — the sensing ingest route is actually MOUNTED.
 *
 * src/test/sensingIngestRoute.test.ts mounts the router DIRECTLY
 * (`app.use("/api", sensingIngestRouter)`), which proves the handler works and
 * proves nothing about whether the real server ever reaches it. §11's blocker
 * is "No ingest route. Eligibility returning `true` admits nobody while nothing
 * calls it" — and a route file that is never registered admits nobody either.
 * It would be the same gap with more code in it.
 *
 * So this file mounts the COMPOSED router — the same default export
 * routes/index.ts hands the server — and asserts the path is reachable through
 * it. Reachability, not authorization, is the property: a request with no
 * credential must be REJECTED BY THE HANDLER'S OWN GATE (401), never answered
 * 404 by express because nothing claimed the path. A deliberately unregistered
 * control path pins the other side of that distinction so these assertions
 * cannot go vacuous.
 *
 * The shape is src/test/intelRouterRegistrationGuard.test.ts's, deliberately:
 * that file documents the exact failure it was written after — commenting out
 * one `router.use(...)` left 56 endpoint tests green.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { SENSING_PEPPER_ENV, SENSING_PEPPER_MIN_LENGTH, _resetSensingStorePresence } from "../lib/sensingAnonService.js";

const INGEST_PATH = "/api/v1/sensing/contributions";
/** A path nothing registers. Its 404 is what makes the assertions above non-vacuous. */
const UNREGISTERED_PATH = "/api/v1/sensing/contributions-that-nothing-mounts";

const GOOD_PEPPER = "r".repeat(SENSING_PEPPER_MIN_LENGTH);
let savedPepper: string | undefined;

/**
 * A client that exists but authenticates nobody, and that refuses to be read.
 * It has to EXIST or unrelated handlers answer 503 — see the intel guard's note
 * on why 503 is a far weaker signal than 401.
 */
function inertClient() {
  return {
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async getUser() {
        return { data: { user: null }, error: { message: "no token" } };
      },
    },
    from() {
      throw new Error("no handler under test may reach the database in this file");
    },
  };
}

async function statusOf(app: Express, path: string, init: RequestInit = {}): Promise<number> {
  const server = createServer(app);
  // Bind loopback explicitly — a host-less listen(0) binds [::] and a foreign
  // IPv4 listener can steal the request.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return res.status;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

let app: Express;

describe("the sensing ingest route is registered in routes/index.ts", () => {
  before(async () => {
    _setTestClient(inertClient(), true);
    _setTestServiceClient(inertClient() as any);
    const { default: composedRouter } = await import("../routes/index.js");
    app = express();
    app.use(express.json());
    app.use("/api", composedRouter);
  });

  after(() => {
    _clearTestClient();
    _setTestServiceClient(null);
  });

  beforeEach(() => {
    savedPepper = process.env[SENSING_PEPPER_ENV];
    process.env[SENSING_PEPPER_ENV] = GOOD_PEPPER;
    _resetSensingStorePresence();
  });
  afterEach(() => {
    if (savedPepper === undefined) delete process.env[SENSING_PEPPER_ENV];
    else process.env[SENSING_PEPPER_ENV] = savedPepper;
    _resetSensingStorePresence();
  });

  it("POST reaches the handler's OWN credential gate (401), not express's 404", async () => {
    const status = await statusOf(app, INGEST_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(status, 401, "the composed router does not reach the sensing ingest handler");
  });

  it("with the pepper UNSET it still reaches the handler — 503 naming the secret, not 404", async () => {
    delete process.env[SENSING_PEPPER_ENV];
    const status = await statusOf(app, INGEST_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(status, 503, "the pepper refusal is the handler's, so a 404 here means it is unmounted");
  });

  it("a path nothing mounts really is 404 — the control that keeps this file honest", async () => {
    const status = await statusOf(app, UNREGISTERED_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(status, 404);
  });

  it("GET on the ingest path is not a surface — only POST is claimed", async () => {
    // The anonymous path writes. A GET here would be a read of crowd state by
    // an unauthenticated caller, which is `surface` — a scope nobody granted.
    const status = await statusOf(app, INGEST_PATH);
    assert.equal(status, 404);
  });
});
