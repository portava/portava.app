/**
 * adminFeaturedApprove.test.ts
 *
 * Confirms the initial POST /admin/featured/approve/:postId branching that
 * adminFeaturedPermission.test.ts does not cover:
 *   - Approving a VIDEO post (non-@portava author) must NOT go live — it
 *     must land in pending_permission and send a creator-permission
 *     notification.
 *   - Approving a PHOTO (non-video) post must go live immediately, with no
 *     permission request and an immediate featured_count increment.
 *
 * Runtime: node:test. Run via: pnpm --filter @workspace/api-server test
 */

import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminFeaturedRouter from "../routes/adminFeatured.js";

const ADMIN_ID     = "aaaaaaaa-1111-0000-0000-000000000001";
const AUTHOR_ID    = "bbbbbbbb-1111-0000-0000-000000000002";
const PORTAVA_ID   = "cccccccc-1111-0000-0000-000000000003";
const VIDEO_POST   = "dddddddd-1111-0000-0000-000000000004";
const PHOTO_POST   = "eeeeeeee-1111-0000-0000-000000000005";
const PORTAVA_POST = "ffffffff-1111-0000-0000-000000000006";
const TOKEN        = "test-bearer-token";

let server: http.Server;
let base: string;

function postReq(path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${TOKEN}` },
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

// Simple filter-aware fake builder (rows never mutate in place; update/upsert
// return the merged row so callers can read back what was written).
function makeBuilder(rows: any[], pendingPatch?: Record<string, unknown>): any {
  const b: any = {
    select:  ()                      => makeBuilder(rows, pendingPatch),
    eq:      (col: string, val: any) => makeBuilder(rows.filter((r) => r[col] === val), pendingPatch),
    neq:     (col: string, val: any) => makeBuilder(rows.filter((r) => r[col] !== val), pendingPatch),
    is:      ()                      => makeBuilder(rows, pendingPatch),
    order:   ()                      => makeBuilder(rows, pendingPatch),
    limit:   (n: number)             => makeBuilder(rows.slice(0, n), pendingPatch),
    insert:  (data: any) => {
      const row = Array.isArray(data) ? data[0] : data;
      return makeBuilder([row], undefined);
    },
    upsert:  (data: any) => {
      const row = Array.isArray(data) ? data[0] : data;
      return makeBuilder([row], undefined);
    },
    update:  (patch: Record<string, unknown>) => makeBuilder(rows, patch),
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
      const data = pendingPatch ? rows.map((r) => ({ ...r, ...pendingPatch })) : rows;
      return Promise.resolve({ data, error: null, count: data.length }).then(resolve);
    },
  };
  return b;
}

function makeFakeClient(posts: any[], profiles: any[], featuredRows: any[] = []) {
  const client: any = {
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    from: (table: string) => {
      if (table === "posts")            return makeBuilder(posts);
      if (table === "profiles")         return makeBuilder(profiles);
      if (table === "portava_featured") return makeBuilder(featuredRows);
      return makeBuilder([]);
    },
  };
  return client;
}

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

describe("POST /admin/featured/approve/:postId — video vs photo branching", () => {
  it("approving a VIDEO post by a non-@portava author does NOT go live — pending_permission + notification requested", async () => {
    const posts = [{
      id: VIDEO_POST, author_id: AUTHOR_ID, status: "active",
      primary_media_type: "video", has_video: true,
    }];
    const profiles = [
      { id: ADMIN_ID, role: "admin" },
      { id: AUTHOR_ID, featured_count: 0 },
      { id: PORTAVA_ID, handle: "portava" },
    ];
    const client = makeFakeClient(posts, profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/approve/${VIDEO_POST}`,
      { category: "best_video" },
    );

    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.needsPermission, true, "video post by a non-@portava author must request creator permission");
    assert.equal(body.status, "pending_permission", "video post must not go live immediately");
    assert.equal(body.featured.status, "pending_permission");
    assert.ok(body.featured.creator_permission_requested_at, "creator_permission_requested_at must be stamped");
  });

  it("approving a PHOTO (non-video) post goes live immediately — no permission request", async () => {
    const posts = [{
      id: PHOTO_POST, author_id: AUTHOR_ID, status: "active",
      primary_media_type: "image", has_video: false,
    }];
    const profiles = [
      { id: ADMIN_ID, role: "admin" },
      { id: AUTHOR_ID, featured_count: 2 },
    ];
    const client = makeFakeClient(posts, profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/approve/${PHOTO_POST}`,
      { category: "best_photo" },
    );

    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.needsPermission, false, "photo post must not require creator permission");
    assert.equal(body.status, "live", "photo post must go live immediately");
    assert.equal(body.featured.status, "live");
    assert.equal(body.featured.creator_permission_requested_at, null);
  });

  it("approving a video authored by @portava itself is exempt — goes live immediately, no permission request", async () => {
    const posts = [{
      id: PORTAVA_POST, author_id: PORTAVA_ID, status: "active",
      primary_media_type: "video", has_video: true,
    }];
    const profiles = [
      { id: ADMIN_ID, role: "admin" },
      { id: PORTAVA_ID, handle: "portava", featured_count: 5 },
    ];
    const client = makeFakeClient(posts, profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await postReq(
      `/api/admin/featured/approve/${PORTAVA_POST}`,
      { category: "best_video" },
    );

    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.needsPermission, false, "@portava's own videos are exempt from the permission requirement");
    assert.equal(body.status, "live");
  });
});
