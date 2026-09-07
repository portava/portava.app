/**
 * A failed read must never be served as the reassuring answer.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * THE DEFECT CLASS. supabase-js RESOLVES on a database error rather than
 * throwing, so `{ data }` is null both when a row genuinely does not exist and
 * when the table could not be read. Every site below collapsed those two into
 * the permissive answer:
 *
 *   routes/admin.ts    an unreadable user_account_states / trust_restrictions /
 *                      blocks / user_mutes / user_restrictions rendered an
 *                      EMPTY moderation record. An operator looking at a banned
 *                      user saw a CLEAN ACCOUNT and might act on it.
 *   routes/blocks.ts   an unreadable blocks table answered iBlocked = false and
 *                      theyBlockedMe = false -- "you are not blocked".
 *   routes/collections.ts  an unreadable collections table read as "no default
 *                      collection" and the next statement INSERTed a SECOND
 *                      one, permanently, because the database blinked.
 *
 * These tests assert the three states stay distinguishable: no record, read
 * failed, record exists.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/failOpenReadBoundaries.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import blocksRouter from "../routes/blocks.js";
import collectionsRouter from "../routes/collections.js";

let server: http.Server;
let base: string;
const FAKE_TOKEN = "fake.jwt.token";

/** Every INSERT the fake client saw, so a test can prove one did NOT happen. */
let inserts: Array<{ table: string; row: any }> = [];

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const DB_ERROR = { message: "connection reset by peer", code: "08006" };

/**
 * `errorTables` names tables whose reads RESOLVE with an error, the way
 * supabase-js reports a real PostgREST failure. `rows` supplies data for the
 * rest.
 */
function makeClient(opts: {
  role?: string;
  errorTables?: string[];
  rows?: Record<string, any[]>;
  /** Per-table queue of single-row results, consumed in order. Models a table
   *  whose contents CHANGE between two reads -- which is what a lost race is. */
  readQueue?: Record<string, Array<{ data: any; error: any }>>;
  /** Tables whose INSERT resolves with this error. */
  insertError?: Record<string, { message: string; code: string }>;
}) {
  const { role = "admin", errorTables = [], rows = {}, readQueue = {}, insertError = {} } = opts;
  const failing = new Set(errorTables);
  const queues: Record<string, Array<{ data: any; error: any }>> =
    Object.fromEntries(Object.entries(readQueue).map(([k, v]) => [k, [...v]]));

  function builder(table: string) {
    const isErr = failing.has(table);
    let _rows = [...(rows[table] ?? [])];
    let _insertFailed: { message: string; code: string } | null = null;
    const settle = (single: boolean) => {
      if (_insertFailed) return Promise.resolve({ data: null, error: _insertFailed, count: null });
      if (isErr) return Promise.resolve({ data: null, error: DB_ERROR, count: null });
      const q = queues[table];
      if (single && q && q.length > 0) return Promise.resolve({ ...q.shift()!, count: null });
      return Promise.resolve(
        single
          ? { data: _rows[0] ?? null, error: null }
          : { data: _rows, error: null, count: _rows.length },
      );
    };
    const b: any = {
      select: () => b,
      insert: (data: any) => {
        inserts.push({ table, row: data });
        if (insertError[table]) { _insertFailed = insertError[table]!; return b; }
        _rows = [{ id: "new-id", ...data }];
        return b;
      },
      upsert: (data: any) => { inserts.push({ table, row: data }); return b; },
      update: () => b,
      delete: () => { _rows = []; return b; },
      eq: () => b, is: () => b, in: () => b, or: () => b, not: () => b,
      ilike: () => b, gte: () => b, lte: () => b, neq: () => b,
      order: () => b, limit: () => b, range: () => b,
      maybeSingle: () => settle(true),
      single: () => settle(true),
      then: (resolve: any) => settle(false).then(resolve),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles" && !failing.has("profiles")) {
        return builder("__profiles_ok__") as any;
      }
      return builder(table);
    },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "uid1" } }, error: null }) },
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as any;
}

// profiles must resolve for requireAdmin/requireUser to get past the gate; the
// defect under test is downstream of authentication, not in it.
function clientWith(opts: Parameters<typeof makeClient>[0]) {
  const base = makeClient(opts);
  const inner = base.from;
  base.from = (table: string) => {
    if (table === "profiles") {
      const b: any = {
        select: () => b, eq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
        maybeSingle: () => Promise.resolve({ data: { id: "uid1", role: opts.role ?? "admin" }, error: null }),
        single: () => Promise.resolve({ data: { id: "uid1", role: opts.role ?? "admin" }, error: null }),
        then: (r: any) => Promise.resolve({ data: [{ id: "uid1", role: opts.role ?? "admin" }], error: null, count: 1 }).then(r),
      };
      return b;
    }
    return inner(table);
  };
  return base;
}

function setClients(opts: Parameters<typeof makeClient>[0]) {
  inserts = [];
  const c = clientWith(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

before(async () => {
  const app = express();
  app.use(express.json());
  // The real server installs a pino logger, so routes call req.log.error
  // freely. Without this shim a route CRASHES with a TypeError instead of
  // returning its refusal -- which would make "status !== 200" pass for
  // entirely the wrong reason. A 500 from a crash is not a fail-closed refusal.
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  app.use(blocksRouter);
  app.use(collectionsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

const UID = "11111111-1111-4111-8111-111111111111";

describe("admin moderation record cannot degrade to clean", () => {
  it("an unreadable user_account_states does NOT render an empty moderation record", async () => {
    setClients({ errorTables: ["user_account_states"] });
    const { status, body } = await req("GET", `/admin/users/${UID}/summary`);
    assert.notEqual(status, 200, "a failed moderation read must not return 200 with a clean record");
    // A crash renders Express's HTML error page; a refusal renders sendError's
    // JSON envelope. The envelope is what distinguishes "we decided not to
    // answer" from "we fell over", and only the first is fail-closed.
    assert.equal(body?.error, "db_error", "must be a deliberate sendError refusal, not a crash");
    const rendered = JSON.stringify(body);
    assert.ok(
      !/"accountStates":\s*\[\]/.test(rendered),
      "the response must not present an empty accountStates array built from a failed read",
    );
  });

  it("the failure names the section that could not be read", async () => {
    setClients({ errorTables: ["trust_restrictions"] });
    const { status, body } = await req("GET", `/admin/users/${UID}/summary`);
    assert.notEqual(status, 200);
    assert.match(
      JSON.stringify(body),
      /trustRestrictions/,
      "an operator must be told WHICH part of the record is missing, not just that something failed",
    );
  });

  it("moderation-summary refuses the same way", async () => {
    setClients({ errorTables: ["moderation_actions"] });
    const { status } = await req("GET", `/admin/users/${UID}/moderation-summary`);
    assert.notEqual(status, 200);
  });

  it("a genuinely clean user still renders 200 — the guard is not a blanket refusal", async () => {
    setClients({ errorTables: [] });
    const { status, body } = await req("GET", `/admin/users/${UID}/summary`);
    assert.equal(status, 200, "no read failed, so the record is trustworthy and must render");
    assert.deepEqual(body.accountStates, [], "genuinely empty is still empty");
  });
});

describe("block status fails closed", () => {
  it("an unreadable blocks table does NOT answer iBlocked=false", async () => {
    setClients({ role: "user", errorTables: ["blocks"] });
    const { status, body } = await req("GET", `/users/${UID}/block-status`);
    assert.notEqual(status, 200, "a failed blocks read must not be served as a block-status answer");
    assert.equal(body?.error, "db_error", "must be a deliberate sendError refusal, not a crash");
    assert.ok(
      body?.iBlocked !== false && body?.theyBlockedMe !== false,
      "the permissive answer must not appear in the body at all",
    );
  });

  it("a readable blocks table with no row still answers false — not blocked is a real answer", async () => {
    setClients({ role: "user", errorTables: [], rows: { blocks: [] } });
    const { status, body } = await req("GET", `/users/${UID}/block-status`);
    assert.equal(status, 200);
    assert.equal(body.iBlocked, false);
    assert.equal(body.theyBlockedMe, false);
  });
});

describe("default collection cannot be duplicated by a failed read", () => {
  it("an unreadable collections table does NOT insert a second default", async () => {
    setClients({ role: "user", errorTables: ["collections"] });
    // NOTE the snake_case payload. An earlier draft of this test sent
    // camelCase, was rejected by validation with 400 invalid_payload, and
    // therefore PASSED "status !== 200" without ever reaching
    // ensureDefaultCollection. Asserting the specific error code below is what
    // stops that from happening again.
    const { status, body } = await req("POST", "/saves", { entity_type: "post", entity_id: UID });
    assert.notEqual(status, 200, "a failed default-collection lookup must not be treated as success");
    assert.equal(
      body?.error, "collection_lookup_failed",
      `the request must actually reach ensureDefaultCollection and fail there; got ${JSON.stringify(body)}`,
    );
    const collectionInserts = inserts.filter((i) => i.table === "collections");
    assert.equal(
      collectionInserts.length, 0,
      `an unreadable lookup must not create a collection; saw ${collectionInserts.length} insert(s)`,
    );
  });

  it("losing the insert race (23505) returns the winner's row, not an error", async () => {
    // Two concurrent requests for a user with no default can both read "none"
    // and both insert. No application-side check prevents that; only the
    // partial unique index in 2640 arbitrates it. The loser must treat 23505 as
    // SUCCESS -- the default now exists -- and re-read the winner's row.
    setClients({
      role: "user",
      readQueue: {
        collections: [
          { data: null, error: null },                 // our read: no default yet
          { data: { id: "winner-collection" }, error: null }, // re-read after 23505
        ],
      },
      insertError: { collections: { message: "duplicate key value violates unique constraint", code: "23505" } },
    });
    const { status, body } = await req("POST", "/saves", { entity_type: "post", entity_id: UID });
    assert.notEqual(
      body?.error, "collection_create_failed",
      "losing a race is not a failure the user can act on; it must not surface as one",
    );
    assert.ok(status < 500, `lost race should not be a server error, got ${status} ${JSON.stringify(body)}`);
  });

  it("the lookup failure is reported as retryable, because retrying is the recovery", async () => {
    const { isRetryableErrorCode } = await import("../lib/http.js");
    assert.equal(isRetryableErrorCode("collection_lookup_failed"), true);
    assert.equal(
      isRetryableErrorCode("collection_create_failed"), false,
      "an insert that failed for an unknown reason is not known to be retry-safe",
    );
  });
});

describe("the fixes are in the source, not only in these expectations", () => {
  it("each site checks its error rather than coalescing it away", async () => {
    const { readFileSync } = await import("node:fs");
    const admin = readFileSync(new URL("../routes/admin.ts", import.meta.url), "utf8");
    assert.match(admin, /failedModerationReads\(/, "admin.ts must consult the moderation read-integrity helper");
    const blocks = readFileSync(new URL("../routes/blocks.ts", import.meta.url), "utf8");
    assert.match(blocks, /iBlocked\.error \|\| theyBlocked\.error/, "blocks.ts must check both reads");
    const collections = readFileSync(new URL("../routes/collections.ts", import.meta.url), "utf8");
    assert.match(collections, /lookupError/, "collections.ts must bind and check the lookup error");
    assert.match(collections, /23505/, "collections.ts must treat a lost race as success, not failure");
  });
});
