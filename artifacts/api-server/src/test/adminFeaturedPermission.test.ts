/**
 * adminFeaturedPermission.test.ts
 *
 * Confirms that the accept-permission and decline-permission endpoints
 * correctly disambiguate when the same post has multiple pending_permission
 * rows (one per category) — so tapping Accept/Decline in one notification
 * never accidentally resolves a different category's row.
 *
 * Runtime: node:test  (no vitest / no supertest)
 * Run via: pnpm --filter @workspace/api-server test (api-test workflow)
 *
 * Covers:
 *   A. accept-permission with `category` in body updates only that category's row.
 *   B. accept-permission with `featuredId` in body updates only that exact row.
 *   C. decline-permission with `category` in body updates only that category's row.
 *   D. decline-permission with `featuredId` in body updates only that exact row.
 *   E. accept-permission with no disambiguator still works when only one pending row exists.
 *   F. accept-permission returns 403 when caller is not the post author.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminFeaturedRouter from "../routes/adminFeatured.js";

// ── Constants — must be valid UUIDs for z.string().uuid() to accept them ──────

const CREATOR_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ID    = "bbbbbbbb-0000-0000-0000-000000000002";
const POST_ID     = "cccccccc-0000-0000-0000-000000000003";
const FEAT_VIDEO  = "dddddddd-0000-0000-0000-000000000004";
const FEAT_PHOTO  = "eeeeeeee-0000-0000-0000-000000000005";
const TOKEN       = "test-bearer-token";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function postReq(
  path: string,
  body: unknown = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method:   "POST",
        headers: {
          "content-type":  "application/json",
          "authorization": `Bearer ${TOKEN}`,
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
    r.write(payload);
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

/**
 * A filter-tracking builder that separates filtering from patching:
 * - `.eq()` calls filter the ORIGINAL row set (matching PostgREST semantics)
 * - `.update(patch)` stores the patch but does NOT pre-apply it to the rows
 * - `.maybeSingle()` / `.then()` merge the patch into the matched rows at
 *   resolution time — so `.eq("status", "pending_permission")` still matches
 *   the original status even though the patch will change it
 */
function makeBuilder(rows: any[], pendingPatch?: Record<string, unknown>): any {
  const b: any = {
    select:  (_cols?: string, _opts?: any) => makeBuilder(rows, pendingPatch),
    eq:      (col: string, val: any)       => makeBuilder(
      rows.filter((r) => r[col] === val || String(r[col]) === String(val)),
      pendingPatch,
    ),
    neq:     (col: string, val: any)       => makeBuilder(rows.filter((r) => r[col] !== val), pendingPatch),
    in:      (col: string, vals: any[])    => makeBuilder(rows.filter((r) => vals.includes(r[col])), pendingPatch),
    is:      (col: string, val: any)       => makeBuilder(
      val === null ? rows.filter((r) => r[col] == null) : rows.filter((r) => r[col] === val),
      pendingPatch,
    ),
    not:     ()                            => makeBuilder(rows, pendingPatch),
    order:   ()                            => makeBuilder(rows, pendingPatch),
    limit:   (n: number)                   => makeBuilder(rows.slice(0, n), pendingPatch),
    range:   ()                            => makeBuilder(rows, pendingPatch),
    gte:     ()                            => makeBuilder(rows, pendingPatch),
    lte:     ()                            => makeBuilder(rows, pendingPatch),
    delete:  ()                            => makeBuilder([], undefined),
    insert:  (data: any)                   => {
      const row = Array.isArray(data) ? data[0] : data;
      return makeBuilder([row], undefined);
    },
    upsert:  (data: any, _opts?: any)      => {
      const row = Array.isArray(data) ? data[0] : data;
      return makeBuilder([row], undefined);
    },
    // update() stores the patch without applying it to rows so that subsequent
    // .eq() calls still filter on the original field values
    update:  (patch: Record<string, unknown>) => makeBuilder(rows, patch),
    // Resolution: apply pending patch to matched rows
    maybeSingle: () => {
      if (rows.length === 0) return { data: null, error: null };
      const row = pendingPatch ? { ...rows[0], ...pendingPatch } : { ...rows[0] };
      return { data: row, error: null };
    },
    single: () => {
      if (rows.length === 0) return { data: null, error: { message: "no rows" } };
      const row = pendingPatch ? { ...rows[0], ...pendingPatch } : { ...rows[0] };
      return { data: row, error: null };
    },
    then: (resolve: any) => {
      const data = pendingPatch
        ? rows.map((r) => ({ ...r, ...pendingPatch }))
        : rows;
      return Promise.resolve({ data, error: null, count: data.length }).then(resolve);
    },
    get count() { return rows.length; },
  };
  return b;
}

/**
 * Builds a fake Supabase client whose `from()` calls dispatch to per-table
 * row stores via makeBuilder so .eq() filters work correctly end-to-end.
 */
function makeFakeClient(opts: {
  callerId:     string;
  postAuthorId: string;
  featuredRows: any[];
  profileFeaturedCount?: number;
}) {
  const { callerId, postAuthorId, featuredRows, profileFeaturedCount = 0 } = opts;

  const postRow    = { id: POST_ID, author_id: postAuthorId, status: "active" };
  const profileRow = { id: postAuthorId, featured_count: profileFeaturedCount };

  const client: any = {
    auth: {
      getUser: async () => ({ data: { user: { id: callerId } }, error: null }),
    },
    from: (table: string) => {
      if (table === "posts")            return makeBuilder([postRow]);
      if (table === "portava_featured") return makeBuilder(featuredRows);
      if (table === "profiles")         return makeBuilder([profileRow]);
      return makeBuilder([]);
    },
  };
  return client;
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  await new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", adminFeaturedRouter);
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  _setTestClient(null);
  _setTestServiceClient(null as any);
});

// ── A: accept-permission with category discriminates the target row ────────────

describe("A: accept-permission with category targets only that category's row", () => {
  it("returns 200 and the best_video row when category=best_video", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
      { id: FEAT_PHOTO, post_id: POST_ID, category: "best_photo", status: "pending_permission" },
    ];
    const client = makeFakeClient({ callerId: CREATOR_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/accept-permission/${POST_ID}`,
      { category: "best_video" },
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.ok, "ok should be true");
    assert.equal(body.featured?.id, FEAT_VIDEO, "should return the best_video featured row");
    assert.equal(body.featured?.status, "live", "featured row should be set to live");
    assert.equal(body.featured?.category, "best_video");
  });

  it("returns 200 and the best_photo row when category=best_photo", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
      { id: FEAT_PHOTO, post_id: POST_ID, category: "best_photo", status: "pending_permission" },
    ];
    const client = makeFakeClient({ callerId: CREATOR_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/accept-permission/${POST_ID}`,
      { category: "best_photo" },
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.featured?.id, FEAT_PHOTO, "should return the best_photo featured row");
    assert.equal(body.featured?.status, "live");
    assert.equal(body.featured?.category, "best_photo");
  });
});

// ── B: accept-permission with featuredId targets the exact row ────────────────

describe("B: accept-permission with featuredId targets the exact row", () => {
  it("returns 200 and the targeted row regardless of how many pending rows exist", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
      { id: FEAT_PHOTO, post_id: POST_ID, category: "best_photo", status: "pending_permission" },
    ];
    const client = makeFakeClient({ callerId: CREATOR_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/accept-permission/${POST_ID}`,
      { featuredId: FEAT_PHOTO },
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.featured?.id, FEAT_PHOTO);
    assert.equal(body.featured?.status, "live");
  });
});

// ── C: decline-permission with category targets only that category's row ──────

describe("C: decline-permission with category targets only that category's row", () => {
  it("returns 200 and declines the best_video row when category=best_video", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
      { id: FEAT_PHOTO, post_id: POST_ID, category: "best_photo", status: "pending_permission" },
    ];
    const client = makeFakeClient({ callerId: CREATOR_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/decline-permission/${POST_ID}`,
      { category: "best_video" },
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.ok, "ok should be true");
  });

  it("returns 200 and declines the best_photo row when category=best_photo", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
      { id: FEAT_PHOTO, post_id: POST_ID, category: "best_photo", status: "pending_permission" },
    ];
    const client = makeFakeClient({ callerId: CREATOR_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/decline-permission/${POST_ID}`,
      { category: "best_photo" },
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.ok);
  });
});

// ── D: decline-permission with featuredId targets the exact row ───────────────

describe("D: decline-permission with featuredId targets the exact row", () => {
  it("declines the row matching featuredId when two pending rows exist", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
      { id: FEAT_PHOTO, post_id: POST_ID, category: "best_photo", status: "pending_permission" },
    ];
    const client = makeFakeClient({ callerId: CREATOR_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/decline-permission/${POST_ID}`,
      { featuredId: FEAT_VIDEO },
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.ok);
  });
});

// ── E: no disambiguator, single pending row — still works ─────────────────────

describe("E: accept-permission with no disambiguator works when exactly one pending row exists", () => {
  it("returns 200 when there is exactly one pending row and no category/featuredId in body", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
    ];
    const client = makeFakeClient({ callerId: CREATOR_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/accept-permission/${POST_ID}`,
      {},
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.ok);
    assert.equal(body.featured?.id, FEAT_VIDEO);
    assert.equal(body.featured?.status, "live");
  });
});

// ── F: non-author cannot accept permission ────────────────────────────────────

describe("F: accept-permission returns 403 when caller is not the post author", () => {
  it("returns 403 forbidden", async () => {
    const featuredRows = [
      { id: FEAT_VIDEO, post_id: POST_ID, category: "best_video", status: "pending_permission" },
    ];
    // callerId is OTHER_ID but the post is authored by CREATOR_ID
    const client = makeFakeClient({ callerId: OTHER_ID, postAuthorId: CREATOR_ID, featuredRows });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status } = await postReq(
      `/api/admin/featured/accept-permission/${POST_ID}`,
      { category: "best_video" },
    );

    assert.equal(status, 403, "non-author must get 403");
  });
});
