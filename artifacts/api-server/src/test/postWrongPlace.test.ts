/**
 * Tests for canonical place tagging on posts + wrong-place report
 * (Task 3039 — Part Y).
 *
 * Covers:
 *   Backfill worker — select-and-update logic with a fake Supabase client.
 *   Wrong-place report endpoint:
 *     - missing post    → 404
 *     - own post        → 403
 *     - success         → 201
 *   Admin resolve endpoint:
 *     - non-admin → 403
 *     - reject    → marks report resolved without touching the post → 200
 *     - missing report  → 404
 *
 * Run: node --import tsx/esm --test src/test/postWrongPlace.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";
import adminMismatchRouter from "../routes/adminPlaceMismatch.js";
import { runBackfillTick } from "../lib/places/postPlaceBackfillWorker.js";

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const AUTHOR_ID  = "aa000000-0000-0000-0000-000000000001";
const VIEWER_ID  = "bb000000-0000-0000-0000-000000000002";
const ADMIN_ID   = "cc000000-0000-0000-0000-000000000003";
const POST_ID    = "dd000000-0000-0000-0000-000000000001";
const PLACE_ID   = "ee000000-0000-0000-0000-000000000001";
const REPORT_ID  = "ff000000-0000-0000-0000-000000000001";

const AUTHOR_TOKEN = "tok-author";
const VIEWER_TOKEN = "tok-viewer";
const ADMIN_TOKEN  = "tok-admin";

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(
  base: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
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

// ── req.log shim ──────────────────────────────────────────────────────────────

/** Add a minimal req.log shim so lib/http helpers don't throw. */
function withReqLog(app: ReturnType<typeof express>) {
  app.use((reqObj: any, _res: any, next: any) => {
    reqObj.log = {
      info: () => {}, warn: () => {}, error: () => {},
      debug: () => {}, child: function() { return this; },
    };
    next();
  });
  return app;
}

// ── Fake Supabase client builder ──────────────────────────────────────────────

/**
 * Returns a static fake Supabase client object (not a factory).
 * requireUser calls client.auth.getUser(token) — the fake dispatches the
 * token to the appropriate userId internally.
 */
function makeFakeClient(opts: {
  callerRole?: "user" | "admin";
  posts?: Record<string, any>;
  reports?: Record<string, any>;
  capturedInserts?: any[];
  capturedUpdates?: any[];
}) {
  const {
    callerRole = "user",
    posts = {},
    reports = {},
    capturedInserts = [],
    capturedUpdates = [],
  } = opts;

  const tokenMap: Record<string, { id: string }> = {
    [AUTHOR_TOKEN]: { id: AUTHOR_ID },
    [VIEWER_TOKEN]: { id: VIEWER_ID },
    [ADMIN_TOKEN]:  { id: ADMIN_ID  },
  };

  const profilesDataset: Record<string, any> = {
    [AUTHOR_ID]: { id: AUTHOR_ID, role: "user",      account_status: "active" },
    [VIEWER_ID]: { id: VIEWER_ID, role: callerRole,  account_status: "active" },
    [ADMIN_ID]:  { id: ADMIN_ID,  role: "admin",     account_status: "active" },
  };

  function builder(table: string, dataset: Record<string, any>) {
    let _result: any = null;
    let _error: any = null;
    const _eqFilters: Record<string, any> = {};

    const b: any = {
      select:  (_cols?: string, _o?: any) => b,
      insert:  (data: any) => {
        if (table === "place_mismatch_reports") capturedInserts.push(data);
        _result = { ...data, id: data.id ?? REPORT_ID };
        return b;
      },
      update:  (data: any) => {
        capturedUpdates.push({ table, data });
        return b;
      },
      eq:      (col: string, val: any) => { _eqFilters[col] = val; return b; },
      is:      (_col: string, _val: any) => b,
      neq:     (_col: string, _val: any) => b,
      not:     (_col: string, _op: string, _val: any) => b,
      order:   () => b,
      limit:   (_n: number) => b,
      lt:      () => b,
      range:   (_from: number, _to: number) => b,
      maybeSingle: () => {
        const idVal = _eqFilters["id"] ?? _eqFilters["reporter_id"];
        _result = idVal && dataset[idVal] ? dataset[idVal] : null;
        return Promise.resolve({ data: _result, error: _error });
      },
      single: () => Promise.resolve({ data: _result, error: _error }),
      then: (resolve: any) =>
        Promise.resolve({ data: _result ? [_result] : [], error: _error, count: 0 }).then(resolve),
    };
    return b;
  }

  // ── The static client object ───────────────────────────────────────────────
  // requireUser calls client.auth.getUser(token) — token dispatch happens here.
  return {
    auth: {
      getUser: async (token: string) => {
        const u = tokenMap[token] ?? null;
        return { data: { user: u ? { id: u.id } : null }, error: null };
      },
    },
    from: (table: string) => {
      if (table === "profiles")               return builder(table, profilesDataset);
      if (table === "posts")                  return builder(table, posts);
      if (table === "place_mismatch_reports") return builder(table, reports);
      return builder(table, {});
    },
  };
}

// ── Backfill worker unit tests ────────────────────────────────────────────────

describe("postPlaceBackfillWorker", () => {
  it("returns stopped=true when no rows need processing", async () => {
    const sc = {
      from: () => {
        const b: any = {
          select: () => b, is: () => b, not: () => b, limit: () => b,
          then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return b;
      },
    };
    const result = await runBackfillTick(sc as any);
    assert.equal(result.stopped, true);
    assert.equal(result.processed, 0);
    assert.equal(result.updated, 0);
  });

  it("skips rows with no location coordinates", async () => {
    const updated: any[] = [];
    const sc = {
      from: (table: string) => {
        if (table === "posts") {
          let phase = "select";
          const b: any = {
            select: () => b, is: () => b, not: () => b, limit: () => b,
            eq: () => b,
            update: (data: any) => { updated.push(data); return b; },
            then: (resolve: any) => {
              if (phase === "select") {
                phase = "done";
                return Promise.resolve({
                  data: [{ id: POST_ID, location_name: "Cafe Roma", location_lat: null, location_lng: null }],
                  error: null,
                }).then(resolve);
              }
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return b;
        }
        const b: any = {
          select: () => b, eq: () => b,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return b;
      },
    };
    const result = await runBackfillTick(sc as any);
    assert.equal(updated.length, 0);
    assert.equal(result.updated, 0);
  });

  it("stops and returns stopped=false on select error", async () => {
    const sc = {
      from: () => {
        const b: any = {
          select: () => b, is: () => b, not: () => b, limit: () => b,
          then: (resolve: any) =>
            Promise.resolve({ data: null, error: { message: "db offline" } }).then(resolve),
        };
        return b;
      },
    };
    const result = await runBackfillTick(sc as any);
    assert.equal(result.processed, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.stopped, false);
  });
});

// ── POST /posts/:id/wrong-place ───────────────────────────────────────────────

describe("POST /posts/:id/wrong-place", () => {
  let server: http.Server;
  let base: string;

  const postData: Record<string, any> = {
    [POST_ID]: { id: POST_ID, author_id: AUTHOR_ID, status: "active", canonical_place_id: PLACE_ID },
  };

  before(async () => {
    const app = withReqLog(express());
    app.use(express.json());
    // Mount the full posts router (wrong-place handler is at the bottom)
    app.use(postsRouter);
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  after(() => new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve()))
  ));

  it("returns 404 when post does not exist", async () => {
    _setTestClient(makeFakeClient({ posts: {} }), true);
    const r = await req(base, "POST", `/posts/nonexistent-id/wrong-place`, VIEWER_TOKEN, { reason: "wrong_location" });
    assert.equal(r.status, 404);
  });

  it("returns 403 when caller is the post author", async () => {
    _setTestClient(makeFakeClient({ posts: postData }), true);
    const r = await req(base, "POST", `/posts/${POST_ID}/wrong-place`, AUTHOR_TOKEN, { reason: "wrong_location" });
    assert.equal(r.status, 403);
  });

  it("returns 201 and inserts a report on success", async () => {
    const capturedInserts: any[] = [];
    _setTestClient(makeFakeClient({ posts: postData, capturedInserts }), true);
    const r = await req(base, "POST", `/posts/${POST_ID}/wrong-place`, VIEWER_TOKEN, { reason: "not_the_same_place" });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.equal(capturedInserts.length, 1);
    assert.equal(capturedInserts[0].reason, "not_the_same_place");
  });
});

// ── GET+POST /admin/place-mismatch-reports ────────────────────────────────────

describe("GET /admin/place-mismatch-reports + POST resolve", () => {
  let server: http.Server;
  let base: string;

  const pendingReport: Record<string, any> = {
    [REPORT_ID]: {
      id: REPORT_ID, post_id: POST_ID, reporter_id: VIEWER_ID,
      reported_place_id: PLACE_ID, reason: "wrong_location", status: "pending",
    },
  };

  before(async () => {
    const app = withReqLog(express());
    app.use(express.json());
    app.use(adminMismatchRouter);
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  after(() => new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve()))
  ));

  it("returns 403 for non-admin caller on report list", async () => {
    _setTestClient(makeFakeClient({ callerRole: "user" }), true);
    const r = await req(base, "GET", "/admin/place-mismatch-reports", VIEWER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("resolves a report with action=reject (no post update)", async () => {
    const capturedUpdates: any[] = [];
    _setTestClient(makeFakeClient({ callerRole: "admin", reports: pendingReport, capturedUpdates }), true);

    const r = await req(
      base, "POST", `/admin/place-mismatch-reports/${REPORT_ID}/resolve`,
      ADMIN_TOKEN, { action: "reject" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.action, "reject");
    // Reject must NOT update the posts table
    assert.equal(capturedUpdates.filter((u) => u.table === "posts").length, 0);
  });

  it("returns 404 when report does not exist", async () => {
    _setTestClient(makeFakeClient({ callerRole: "admin", reports: {} }), true);
    const r = await req(
      base, "POST", `/admin/place-mismatch-reports/nonexistent/resolve`,
      ADMIN_TOKEN, { action: "accept" },
    );
    assert.equal(r.status, 404);
  });
});
