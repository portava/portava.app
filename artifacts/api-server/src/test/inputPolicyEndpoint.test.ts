/**
 * G340 — the policy registry is SERVED, so a shipped client can stop guessing.
 *
 * THE DEFECT. `POLICY_VERSION` has travelled on every response since Phase 1,
 * but nothing served the policies themselves. A client could learn that its
 * copy was stale and had no way to fetch the current one, so it re-declared all
 * 29 contexts locally — and the two copies drifted. Measured 2026-09-21: 26 of
 * 29 contexts disagreed on `allowedSuggestionTypes`, 2 on `defaultMode`. A
 * mirror with no source is not a cache; it is a second authority.
 *
 * WHAT THIS PINS, and the last case is the one that matters:
 *   1. the endpoint requires a caller, and refuses without one;
 *   2. it serves EVERY known context, not a subset;
 *   3. it carries the POLICY_VERSION that the suggest path stamps, so a client
 *      can compare what it holds against what it is told;
 *   4. it never serves `telemetryPolicy` — that governs what the SERVER logs,
 *      the client cannot alter it, and shipping it would invite a client to
 *      believe it may choose;
 *   5. EVERY served field equals `resolvePolicy()`'s, context for context. That
 *      is what makes this endpoint the AUTHORITY rather than a third copy — if
 *      the route ever hand-rolls a value, this fails.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { resolvePolicy, KNOWN_CONTEXTS, POLICY_VERSION } from "../lib/inputAssistance/policyRegistry.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

let base: string;
let server: Server;

before(async () => {
  _setTestClient(
    {
      auth: {
        getUser: async (tok: string) =>
          tok === ME_TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
      },
      // `requireUser` performs the §9 three-state read of
      // `profiles.account_status` before any handler runs, so a client that
      // refuses every table cannot reach the route at all — the first version
      // of this fixture threw here and the endpoint answered 503
      // `degraded_unavailable`, which looked like an endpoint defect and was a
      // fixture defect. Only that one read is served; anything else still
      // throws, so the HANDLER is still proven not to touch the database.
      from(table: string) {
        if (table !== "profiles") {
          throw new Error(`the policy handler must not read ${table}`);
        }
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: { account_status: "active" }, error: null }),
        };
        return b;
      },
    } as any,
    true,
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());
beforeEach(() => _resetRateLimit());

function get(tok: string | null = ME_TOK) {
  return fetch(`${base}/input-assistance/policies`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });
}

describe("§48/G340 — GET /input-assistance/policies", () => {
  it("refuses a caller it cannot identify", async () => {
    const res = await get(null);
    assert.equal(res.status >= 400, true, `unauthenticated must not receive the registry (got ${res.status})`);
  });

  it("serves every known context, and only known contexts", async () => {
    const res = await get();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { contexts: Record<string, any> };
    assert.deepEqual(
      Object.keys(body.contexts).sort(),
      [...KNOWN_CONTEXTS].sort(),
      "a client that fetches this must be able to stop declaring contexts locally — a subset would leave it guessing for the rest",
    );
  });

  it("carries the same POLICY_VERSION the suggest path stamps", async () => {
    const body = (await (await get()).json()) as { policyVersion: string };
    assert.equal(body.policyVersion, POLICY_VERSION);
  });

  it("never serves telemetryPolicy", async () => {
    const body = (await (await get()).json()) as { contexts: Record<string, any> };
    for (const [ctx, p] of Object.entries(body.contexts)) {
      assert.equal("telemetryPolicy" in p, false, `${ctx} leaked telemetryPolicy — the client may not choose what the server logs`);
    }
  });

  it("every served value EQUALS resolvePolicy()'s — this is the authority, not a third copy", async () => {
    const body = (await (await get()).json()) as { contexts: Record<string, any> };
    const mismatches: string[] = [];
    for (const ctx of KNOWN_CONTEXTS) {
      const authority = resolvePolicy(ctx)!;
      const served = body.contexts[ctx];
      assert.ok(served, `no served policy for ${ctx}`);
      for (const key of Object.keys(served)) {
        if (key === "context") continue;
        const a = JSON.stringify((authority as any)[key]);
        const b = JSON.stringify(served[key]);
        if (a !== b) mismatches.push(`${ctx}.${key}: authority=${a} served=${b}`);
      }
    }
    assert.deepEqual(mismatches, [], `the route must project the registry, never restate it:\n  ${mismatches.join("\n  ")}`);
  });

  it("display_name is served as MANUAL, which is the owner's ruling reaching the wire", async () => {
    const body = (await (await get()).json()) as { contexts: Record<string, any> };
    assert.equal(body.contexts.display_name.mode, "no_assistance");
    assert.deepEqual(body.contexts.display_name.allowedSuggestionTypes, []);
  });
});
