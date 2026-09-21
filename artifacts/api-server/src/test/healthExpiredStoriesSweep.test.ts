/**
 * POST /api/admin/cleanup/expired-stories — the sweep that was written, exported,
 * documented as "called from the health/cleanup endpoint", and called by nothing.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sweepExpiredStories` in routes/stories.ts had ZERO callers outside a test.
 * So the 24-hour story was ephemeral in the product copy and permanent in the
 * database: no row ever left `state='active'`, and no storage object was ever
 * removed. Worse than dead code, it was a FALSE PREMISE somewhere else --
 * AccountDeletionService reasons from it in a comment ("sweepExpiredStories
 * already deletes story bytes on EXPIRY, but only for..."), which is an
 * argument built on a job that never ran.
 *
 * The severity is stated precisely rather than inherited from the sweep's own
 * comment, which claims expired story media stays "publicly fetchable at its
 * URL forever". That is NOT true today: lib/mediaAccess.ts branch 3d checks
 * expires_at and denies expired story media on the serving path. What actually
 * accumulates is rows that never leave `active` and objects nothing will ever
 * delete.
 *
 * WHAT IS ASSERTED, AND THE TRAPS AVOIDED
 * ---------------------------------------
 *   - The exact STATUS CODE, never `!== 200`. A 404 from an unmounted route
 *     and a 500 from a crash both satisfy `!== 200`, and one of them would
 *     mean this endpoint does not exist.
 *   - Reachability through the COMPOSED router (routes/index.ts), the object
 *     the server actually mounts. Testing the health router in isolation would
 *     prove the handler works and nothing about whether anyone can reach it --
 *     which is the exact defect this endpoint was written to repair.
 *   - `req.log` is installed, because the real server installs it. Omit it and
 *     a handler throw becomes a 500 that reads like a considered refusal.
 *   - The server binds explicit loopback AND is awaited THROUGH the listening
 *     callback; `listen(0, host)` resolves the address on a later tick.
 *   - A FAILED sweep must not answer 200 with a fabricated `expired: 0`.
 *     sweepExpiredStories throws rather than resolving with a count, so that
 *     catch is live code -- unlike a catch around a bare supabase read, which
 *     is dead because supabase-js resolves its errors.
 *   - VACUITY: the unauthorised cases assert the sweep DID NOT RUN, not merely
 *     that the status was 401. A handler that refused for the wrong reason, or
 *     that ran the sweep and then refused, would pass a status-only check.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest). The verdict is the
 * exit code.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/healthExpiredStoriesSweep.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, { type Express } from "express";

import healthRouter from "../routes/health.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const PATH = "/api/admin/cleanup/expired-stories";

/**
 * appStorageUrlInfo accepts two forms, and the choice here matters. A FULL URL
 * is only recognised on our OWN origin -- it compares against the Supabase base
 * URL from the environment and rejects anything else outright -- so a
 * hand-written "https://x.supabase.co/..." fixture parses to null and the sweep
 * removes nothing, which looks exactly like a broken sweep. That cost this
 * suite one red run. The BARE STORAGE PATH form needs no origin at all, so the
 * fixture uses it: the test then measures the sweep instead of the fixture, and
 * this file never has to name a Supabase credential variable in order to build
 * a fixture -- which also keeps it out of check:guard-coverage's reacher set,
 * where it did briefly land.
 */
const mediaUrl = (path: string) => `post-media/${path}`;
const SECRET = "test-cleanup-secret-value";

// ── a stories table double that records what the sweep actually asked for ────
interface Recorder {
  updates: Array<{ patch: any; filters: string[]; projection: string }>;
  removed: string[][];
}

function storiesClient(
  rec: Recorder,
  answer: { data: any[] | null; error: any },
) {
  const builder = (patch: any) => {
    const filters: string[] = [];
    const chain: any = {
      eq(col: string, v: any) { filters.push(`eq:${col}=${String(v)}`); return chain; },
      lt(col: string, _v: any) { filters.push(`lt:${col}`); return chain; },
      is(col: string, v: any) { filters.push(`is:${col}=${String(v)}`); return chain; },
      select(projection: string) {
        rec.updates.push({ patch, filters, projection });
        return Promise.resolve(answer);
      },
    };
    return chain;
  };
  return {
    from(table: string) {
      assert.equal(table, "stories", "the sweep must read the stories table");
      return { update: (patch: any) => builder(patch) };
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "post-media");
        return { async remove(paths: string[]) { rec.removed.push(paths); return { data: null, error: null }; } };
      },
    },
  } as any;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
interface Reply { status: number; body: any }

function post(base: string, path: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let body: any = null;
          try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A pino-shaped no-op, exactly what the real server puts on req. */
function noopLog(): any {
  const l: any = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };
  l.child = () => l;
  return l;
}

const servers: http.Server[] = [];

async function serve(router: any): Promise<string> {
  const app: Express = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = noopLog(); next(); });
  app.use("/api", router);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as any;
  return `http://127.0.0.1:${addr.port}`;
}

let base = "";
let composedBase = "";
let rec: Recorder;
const originalSecret = process.env.CLEANUP_ADMIN_SECRET;

before(async () => {
  base = await serve(healthRouter);
  const { default: composedRouter } = await import("../routes/index.js");
  composedBase = await serve(composedRouter);
});

beforeEach(() => {
  rec = { updates: [], removed: [] };
  process.env.CLEANUP_ADMIN_SECRET = SECRET;
  _setTestServiceClient(null);
});

after(() => {
  _setTestServiceClient(null);
  if (originalSecret === undefined) delete process.env.CLEANUP_ADMIN_SECRET;
  else process.env.CLEANUP_ADMIN_SECRET = originalSecret;
  for (const s of servers) s.close();
});

describe("POST /admin/cleanup/expired-stories", () => {
  it("REACHABILITY: the route exists on the COMPOSED router, not just in isolation", async () => {
    // No secret header, so the answer must be 401 — but 401 is itself the
    // proof, because an unmounted route answers 404 and that is the failure
    // this whole endpoint exists to repair.
    const r = await post(composedBase, PATH, {});
    assert.equal(r.status, 401);
    assert.notEqual(r.status, 404, "a 404 here means the sweep is STILL unreachable");
  });

  it("runs the sweep and reports the count it actually got back", async () => {
    _setTestServiceClient(storiesClient(rec, {
      data: [
        { id: "s1", media_url: mediaUrl("u1/a.jpg") },
        { id: "s2", media_url: mediaUrl("u1/b.jpg") },
      ],
      error: null,
    }));
    const r = await post(base, PATH, { "x-cleanup-secret": SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.body.expired, 2);
    assert.equal(rec.updates.length, 1, "exactly one sweep pass");
  });

  it("sweeps the RIGHT rows: active, past expiry, and not saved to a highlight", async () => {
    _setTestServiceClient(storiesClient(rec, { data: [], error: null }));
    const r = await post(base, PATH, { "x-cleanup-secret": SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.body.expired, 0, "an empty sweep is a 200 with 0, not an error");
    const u = rec.updates[0]!;
    assert.deepEqual(u.patch, { state: "expired" });
    assert.ok(u.filters.includes("eq:state=active"), "must only touch active stories");
    assert.ok(u.filters.includes("lt:expires_at"), "must only touch stories past expiry");
    assert.ok(
      u.filters.includes("is:saved_to_highlight_id=null"),
      "a story saved to a highlight must NOT be expired — the highlight still references its media",
    );
  });

  it("deletes the storage objects for the stories it just expired", async () => {
    _setTestServiceClient(storiesClient(rec, {
      data: [{ id: "s1", media_url: mediaUrl("u1/a.jpg") }],
      error: null,
    }));
    await post(base, PATH, { "x-cleanup-secret": SECRET });
    assert.equal(rec.removed.length, 1, "the bytes must go, not just the state column");
    assert.deepEqual(rec.removed[0], ["u1/a.jpg"]);
  });

  it("a FAILED sweep is 500, never 200 with a fabricated zero", async () => {
    _setTestServiceClient(storiesClient(rec, { data: null, error: { message: "boom", code: "57014" } }));
    const r = await post(base, PATH, { "x-cleanup-secret": SECRET });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "sweep_failed");
    assert.notEqual(r.body.expired, 0, "reporting 0 expired for a sweep that failed is a lie an operator would act on");
  });

  it("a wrong secret is 401 AND the sweep does not run", async () => {
    _setTestServiceClient(storiesClient(rec, { data: [], error: null }));
    const r = await post(base, PATH, { "x-cleanup-secret": "not-the-secret" });
    assert.equal(r.status, 401);
    assert.equal(rec.updates.length, 0, "an unauthorised call must not have swept anything");
  });

  it("a missing secret header is 401 AND the sweep does not run", async () => {
    _setTestServiceClient(storiesClient(rec, { data: [], error: null }));
    const r = await post(base, PATH, {});
    assert.equal(r.status, 401);
    assert.equal(rec.updates.length, 0);
  });

  it("an unconfigured CLEANUP_ADMIN_SECRET refuses rather than running unauthenticated", async () => {
    delete process.env.CLEANUP_ADMIN_SECRET;
    _setTestServiceClient(storiesClient(rec, { data: [], error: null }));
    const r = await post(base, PATH, { "x-cleanup-secret": "anything" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "cleanup_secret_not_configured");
    assert.equal(rec.updates.length, 0, "an endpoint with no secret configured must be closed, not open");
  });

  it("VACUITY CONTROL: the double really does intercept — a sweep with no client injected does not reach it", async () => {
    // Nothing injected, so getServiceClient() builds a REAL client against the
    // loopback discard port the runner sets. The point is only that the
    // recorder stays empty, which proves the assertions above were reading a
    // double the handler genuinely used rather than a coincidence.
    const r = await post(base, PATH, { "x-cleanup-secret": SECRET });
    assert.equal(rec.updates.length, 0);
    assert.ok(r.status === 500 || r.status === 503, `expected a refusal, got ${r.status}`);
  });
});
