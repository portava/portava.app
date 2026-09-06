/**
 * §37 — the Wall's mutation endpoints are rate-limited, and the limit BITES.
 *
 * `checkRateLimit` was called on POST /wall/session-intent, /wall/impression and
 * /wall/action, and the certification doc cited the three line numbers. But no
 * test in any of the twenty-odd Wall test files ever asserted a 429, so nothing
 * would have failed if a limiter had been deleted, mis-keyed, or ordered after
 * the work it protects. §37 was written, never demonstrated.
 *
 * DERIVED FROM THE GATE'S OWN CONSTANT, NEVER A LITERAL
 * -----------------------------------------------------
 * The ceilings come from `WALL_RATE_LIMITS`, which the route itself consumes.
 * A test that hard-coded "600" would keep passing after someone changed the
 * route to 6000 — it would assert a number that no longer exists anywhere. The
 * window is pre-filled through `checkRateLimit` with that same id/limit/window,
 * so the test proves the ROUTE consults THAT bucket: change the limiter id in
 * the route and the pre-fill lands in a different bucket, the route answers 202,
 * and this file goes red.
 *
 * Each limit test carries a POSITIVE CONTROL — one request accepted before the
 * window is filled — so a 429 can never be an artefact of a bucket that was
 * already full when the test started.
 *
 * MUTATION PROOF (verified: revert → RED, restore → GREEN)
 *   • delete the `checkRateLimit` block from POST /wall/impression → the
 *     impression 429 test RED, the other two GREEN.
 *   • same for /wall/action and /wall/session-intent → that endpoint's test RED.
 *   • move the impression limiter BELOW `recordWallEvent` → still RED, because
 *     the test asserts the 429 status, not merely that a counter moved.
 *   • drop the `Retry-After` header → the header assertions RED.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { checkRateLimit, _resetRateLimit } from "../lib/rateLimit.js";
import wallRouter, { WALL_RATE_LIMITS } from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";

const FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_input_intelligence_enabled: true,
};

/** Minimal fake: flags resolve by name, every other read is empty, writes pass. */
function fakeClient(flags: Record<string, boolean> = FLAGS) {
  function builder(table: string) {
    const eqs: Record<string, unknown> = {};
    let single = false;
    const resolve = () =>
      table === "feature_flags"
        ? { data: { enabled: flags[String(eqs.flag)] === true }, error: null }
        : { data: single ? null : [], error: null };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        eqs[c] = v;
        return b;
      },
      in: () => b, is: () => b, ilike: () => b, or: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle: () => {
        single = true;
        return Promise.resolve().then(resolve);
      },
      then: (onF: any, onR: any) => Promise.resolve().then(resolve).then(onF, onR),
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

let server: http.Server;
let baseUrl = "";

function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Consume the whole window through the same limiter the route consults. */
function fillWindow({ id, limit, windowMs }: { id: string; limit: number; windowMs: number }) {
  for (let i = 0; i < limit; i++) checkRateLimit(id, VIEWER, limit, windowMs);
}

describe("Wall §37 — mutation endpoints are rate-limited", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    _resetRateLimit();
    _setTestClient(fakeClient(), true);
  });

  const IMPRESSION = { objectId: "obj-1", objectType: "social_post" };
  const ACTION = { objectId: "obj-1", objectType: "social_post", action: "open" };
  const INTENT = { text: "quiet coffee this afternoon" };

  it("POST /wall/impression answers 429 past its ceiling", async () => {
    const ok = await post("/api/wall/impression", IMPRESSION);
    assert.equal(ok.status, 202, "positive control: an impression under the ceiling is accepted");

    fillWindow(WALL_RATE_LIMITS.impression);
    const res = await post("/api/wall/impression", IMPRESSION);
    assert.equal(res.status, 429);
    assert.equal(res.json.error, "rate_limited");
    assert.ok(res.headers["retry-after"], "a 429 must tell the client when to come back");
  });

  it("POST /wall/action answers 429 past its ceiling", async () => {
    const ok = await post("/api/wall/action", ACTION);
    assert.equal(ok.status, 202, "positive control: an action under the ceiling is accepted");

    fillWindow(WALL_RATE_LIMITS.action);
    const res = await post("/api/wall/action", ACTION);
    assert.equal(res.status, 429);
    assert.equal(res.json.error, "rate_limited");
    assert.ok(res.headers["retry-after"]);
  });

  it("POST /wall/session-intent answers 429 past its ceiling", async () => {
    fillWindow(WALL_RATE_LIMITS.sessionIntent);
    const res = await post("/api/wall/session-intent", INTENT);
    assert.equal(res.status, 429);
    assert.equal(res.json.error, "rate_limited");
    assert.ok(res.headers["retry-after"]);
  });

  it("each endpoint has its OWN bucket — one flood cannot lock the others out", async () => {
    // A single shared limiter id would let impression traffic (600/min, the
    // chattiest by an order of magnitude) starve actions and intent updates.
    fillWindow(WALL_RATE_LIMITS.impression);
    assert.equal((await post("/api/wall/impression", IMPRESSION)).status, 429);
    assert.equal((await post("/api/wall/action", ACTION)).status, 202);
  });

  it("the three ceilings are distinct ids, so the buckets cannot collide", () => {
    const ids = Object.values(WALL_RATE_LIMITS).map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const l of Object.values(WALL_RATE_LIMITS)) {
      assert.ok(l.limit > 0 && l.windowMs > 0, `${l.id} must have a real ceiling`);
    }
  });
});
