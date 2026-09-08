/**
 * What an UNREADABLE table is allowed to say to a person.
 *
 * supabase-js RESOLVES on a database error: the promise settles, `data` is null
 * and `error` carries the failure. A read whose `.error` is never bound is
 * therefore indistinguishable, at the call site, from a read that legitimately
 * found nothing — and the call site then answers with whatever "nothing" means
 * there. Sometimes that is harmless. Sometimes it is a false statement about a
 * specific person.
 *
 * This file pins the ones that are NOT harmless, at the boundary where a human
 * sees the answer.
 *
 *   POST /v1/intel/observations/:id/claims/propose
 *     The lookup is narrowed to `actor_id = the caller`, so "no row" means "YOU
 *     have no observation with that id". An unreadable intel_observations table
 *     rendered that as 404 not_found — the server telling a contributor their own
 *     contribution does not exist. A retry looks identical, so the client cannot
 *     recover and the operator sees a 404, not a database fault. A rejected read
 *     is a 500 db_error; only a SUCCESSFUL read that returned nothing is a 404.
 *
 * Runtime: node:test + node:assert/strict (no vitest, no supertest).
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/intelUnreadableReadAnswers.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OBS_ID = "33333333-3333-4333-8333-333333333333";

/**
 * A client whose ONE interesting axis is what `intel_observations` answers.
 * `observationsError` makes the read RESOLVE with an error (never throw) —
 * modelling a throw would test a shape the real client does not produce.
 */
function makeClient(opts: { observationsError?: boolean; row?: any } = {}) {
  let reads = 0;
  const client: any = {
    _reads: () => reads,
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async getUser(token: string) {
        if (token === "valid-token") return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "bad token" } };
      },
    },
    from(table: string) {
      if (table === "profiles") {
        const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { account_status: "active" }, error: null }) };
        return q;
      }
      if (table === "intel_observations") {
        const q: any = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => {
            reads++;
            return opts.observationsError
              ? { data: null, error: { code: "42501", message: "permission denied for table intel_observations" } }
              : { data: opts.row ?? null, error: null };
          },
        };
        return q;
      }
      // Any other table: an empty, error-free read. Nothing below should reach one.
      const q: any = { select: () => q, eq: () => q, in: () => q, is: () => q, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
      return q;
    },
  };
  return client;
}

async function makeApp(): Promise<Express> {
  const { default: intelRouter } = await import("../routes/intel.js");
  const app = express();
  app.use(express.json());
  app.use("/api", intelRouter);
  return app;
}

async function post(app: Express, path: string): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  // Bind loopback explicitly — a host-less listen(0) binds [::] and a foreign
  // IPv4 listener can steal the request.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const PATH = `/api/v1/intel/observations/${OBS_ID}/claims/propose`;

describe("propose: an unreadable intel_observations must not read as 'you have no such observation'", () => {
  after(() => { _setTestClient(null, false); });

  it("a REJECTED read answers 500 db_error, not 404 not_found", async () => {
    const client = makeClient({ observationsError: true });
    _setTestClient(client, true);
    const app = await makeApp();
    const { status, body } = await post(app, PATH);
    // Assert the CODE, not merely "not 200" — a 500 thrown by a crashing handler
    // would satisfy `status !== 200` while proving nothing, so the shape of the
    // body is asserted too.
    assert.equal(status, 500, `expected 500 db_error, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body?.error, "db_error", JSON.stringify(body));
    assert.equal(client._reads(), 1, "vacuity guard: the handler never performed the read under test");
  });

  it("a SUCCESSFUL read that found nothing still answers 404 not_found", async () => {
    const client = makeClient({ observationsError: false, row: null });
    _setTestClient(client, true);
    const app = await makeApp();
    const { status, body } = await post(app, PATH);
    assert.equal(status, 404, `expected 404 not_found, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body?.error, "not_found", JSON.stringify(body));
    assert.equal(client._reads(), 1);
  });
});
