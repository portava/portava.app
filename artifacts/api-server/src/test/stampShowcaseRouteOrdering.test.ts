/**
 * Regression test — Stage 3 audit fix: /stamps/showcase route ordering.
 *
 * Bug: stampShowcaseRouter was registered AFTER stampsRouter in index.ts.
 *      stamps.ts registers `GET /stamps/:stampId` which returns 400
 *      ("Invalid stampId") for non-UUID paths without calling next(), so
 *      GET /stamps/showcase was unreachable — the request hit the :stampId
 *      handler first, received a 400, and the showcase handler was never
 *      called.
 *
 * Fix (commit 1a0e91292): move stampShowcaseRouter and stampAdmireRouter
 *      registrations to BEFORE stampsRouter in src/routes/index.ts.
 *
 * These tests verify the route is reachable (auth-required 401 response,
 * not a 400 "Invalid stampId") and that the shadowing scenario produces the
 * observable 400 when order is reversed — so we catch a future ordering
 * regression immediately.
 *
 * Runtime: node:test + node:assert/strict
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampShowcaseRouter from "../routes/stampShowcase.js";
import stampsRouter from "../routes/stamps.js";

// ── Minimal fake client (no auth needed — we're testing route reachability) ──

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * makeMinimalClient — builds a minimal fake Supabase client.
 *
 * @param withStampV2Flag  When true, feature_flags includes stamp_system_v2_enabled=true.
 *   The stamps router has a global middleware that checks this flag before routing;
 *   without it, all /stamps/* requests short-circuit at 503 before reaching the
 *   :stampId handler. Set to true in the wrong-order test so the middleware passes
 *   and we can observe the actual route-shadowing 400.
 */
function makeMinimalClient(opts: { withStampV2Flag?: boolean } = {}) {
  const featureFlags = opts.withStampV2Flag
    ? [{ flag: "stamp_system_v2_enabled", enabled: true }]
    : [];

  return {
    auth: {
      getUser: async () => ({ data: { user: { id: ALICE } }, error: null }),
    },
    from: (table: string) => {
      const api: any = {
        select: () => api,
        eq: (_k: string, _v: any) => {
          // stamp_system_v2_enabled flag lookup
          if (table === "feature_flags") {
            return {
              ...api,
              maybeSingle: async () => ({
                data: featureFlags.find((f) => f.flag === _v) ?? null,
                error: null,
              }),
            };
          }
          return api;
        },
        in: () => api,
        order: () => api,
        limit: () => api,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return api;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── Correct order: showcase BEFORE stamps ────────────────────────────────────

describe("GET /stamps/showcase — correct router registration order (showcase before stamps)", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    const client = makeMinimalClient();
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const app = express();
    app.use(express.json());
    // CORRECT ORDER: showcase registered first
    app.use(stampShowcaseRouter);
    app.use(stampsRouter);

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it("returns 401 (auth required) — showcase handler reached, not stamps/:stampId handler", async () => {
    // If the showcase handler is reached: unauthenticated request → 401
    // If the stamps/:stampId handler is reached first: "showcase" is not a UUID → 400
    const { status, body } = await get(base, "/stamps/showcase");
    assert.strictEqual(status, 401,
      `Expected 401 from showcase auth guard, got ${status}. Body: ${JSON.stringify(body)}. ` +
      `A 400 here means stamps/:stampId shadowed the showcase route.`
    );
  });
});

// ── Wrong order: stamps BEFORE showcase (documents the shadowing bug) ─────────

describe("GET /stamps/showcase — wrong router registration order (stamps before showcase)", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    // withStampV2Flag: true so the stamps router's global middleware passes
    // (without this flag, the middleware short-circuits at 503 before reaching
    // the :stampId handler, and we can't observe the route-shadowing 400)
    const client = makeMinimalClient({ withStampV2Flag: true });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const app = express();
    app.use(express.json());
    // WRONG ORDER: stamps registered first — this was the bug
    app.use(stampsRouter);
    app.use(stampShowcaseRouter);

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it("returns 400 when stamps/:stampId shadows showcase (documents pre-fix behavior)", async () => {
    // With the wrong order, "showcase" is treated as a non-UUID stampId → 400
    const { status, body } = await get(base, "/stamps/showcase");
    assert.strictEqual(status, 400,
      `Expected 400 (stampId validation rejects "showcase" as non-UUID) ` +
      `when stamps router is incorrectly registered before showcase router. ` +
      `Got ${status}. Body: ${JSON.stringify(body)}`
    );
  });
});
