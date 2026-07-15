/**
 * Profile media cleanup endpoint tests
 *
 * Verifies that:
 *   1. DELETE /api/me/avatar/file requires authentication
 *   2. DELETE /api/me/avatar/file rejects paths not scoped to the caller's userId
 *   3. DELETE /api/me/avatar/file returns 204 and removes the storage object
 *   4. DELETE /api/me/cover/file requires authentication
 *   5. DELETE /api/me/cover/file rejects paths not scoped to the caller's userId
 *   6. DELETE /api/me/cover/file returns 204 and removes the storage object
 *
 * Run: node --import tsx/esm --test src/test/profileMediaCleanup.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

const USER_ID    = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USER_TOKEN = "media-cleanup-token";
const OTHER_ID   = "dddddddd-dddd-dddd-dddd-dddddddddddd";

let server: http.Server;
let base: string;
let removedPaths: string[];

function buildFakeClient() {
  removedPaths = [];

  function from(_table: string) {
    const b: any = {
      select()       { return b; },
      insert()       { return b; },
      update()       { return b; },
      delete()       { return b; },
      upsert()       { return b; },
      eq()           { return b; },
      neq()          { return b; },
      in()           { return b; },
      or()           { return b; },
      ilike()        { return b; },
      order()        { return b; },
      range()        { return b; },
      limit()        { return b; },
      maybeSingle()  { return Promise.resolve({ data: null, error: null }); },
      single()       { return Promise.resolve({ data: null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === USER_TOKEN) {
          return { data: { user: { id: USER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from,
    storage: {
      from: (_bucket: string) => ({
        remove: async (paths: string[]) => {
          removedPaths.push(...paths);
          return { data: null, error: null };
        },
        upload: async () => ({ data: null, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://example.com/file" } }),
      }),
    },
  };
}

function request(
  method: string,
  path: string,
  token: string,
  body?: object,
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
          "authorization": `Bearer ${token}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
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

describe("Profile media cleanup endpoints", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", profileRouter);
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    const fc = buildFakeClient();
    _setTestClient(fc as any, true);
    _setTestServiceClient(fc as any);
  });

  after(async () => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    removedPaths = [];
  });

  // ── DELETE /me/avatar/file ─────────────────────────────────────────────────

  describe("DELETE /me/avatar/file", () => {
    it("returns 401 when no auth token is provided", async () => {
      const r = await request("DELETE", "/api/me/avatar/file", "bad-token", {
        path: `avatars/${USER_ID}/photo.jpg`,
      });
      assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    });

    it("returns 400 when path is missing", async () => {
      const r = await request("DELETE", "/api/me/avatar/file", USER_TOKEN, {});
      assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    });

    it("returns 400 when path belongs to a different user", async () => {
      const r = await request("DELETE", "/api/me/avatar/file", USER_TOKEN, {
        path: `avatars/${OTHER_ID}/photo.jpg`,
      });
      assert.equal(r.status, 400, `expected 400 for cross-user path, got ${r.status}`);
    });

    it("returns 400 when path does not start with avatars/ prefix", async () => {
      const r = await request("DELETE", "/api/me/avatar/file", USER_TOKEN, {
        path: `covers/${USER_ID}/cover.jpg`,
      });
      assert.equal(r.status, 400, `expected 400 for wrong prefix, got ${r.status}`);
    });

    it("returns 204 and removes the file for a valid own-user path", async () => {
      const ownPath = `avatars/${USER_ID}/orphan-${Date.now()}.jpg`;
      const r = await request("DELETE", "/api/me/avatar/file", USER_TOKEN, {
        path: ownPath,
      });
      assert.equal(r.status, 204, `expected 204, got ${r.status}`);
      assert.ok(removedPaths.includes(ownPath), `expected storage.remove([${ownPath}]) to be called; got: ${JSON.stringify(removedPaths)}`);
    });
  });

  // ── DELETE /me/cover/file ──────────────────────────────────────────────────

  describe("DELETE /me/cover/file", () => {
    it("returns 401 when no auth token is provided", async () => {
      const r = await request("DELETE", "/api/me/cover/file", "bad-token", {
        path: `covers/${USER_ID}/cover.jpg`,
      });
      assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    });

    it("returns 400 when path is missing", async () => {
      const r = await request("DELETE", "/api/me/cover/file", USER_TOKEN, {});
      assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    });

    it("returns 400 when path belongs to a different user", async () => {
      const r = await request("DELETE", "/api/me/cover/file", USER_TOKEN, {
        path: `covers/${OTHER_ID}/cover.jpg`,
      });
      assert.equal(r.status, 400, `expected 400 for cross-user path, got ${r.status}`);
    });

    it("returns 400 when path does not start with covers/ prefix", async () => {
      const r = await request("DELETE", "/api/me/cover/file", USER_TOKEN, {
        path: `avatars/${USER_ID}/photo.jpg`,
      });
      assert.equal(r.status, 400, `expected 400 for wrong prefix, got ${r.status}`);
    });

    it("returns 204 and removes the file for a valid own-user path", async () => {
      const ownPath = `covers/${USER_ID}/cover.webp`;
      const r = await request("DELETE", "/api/me/cover/file", USER_TOKEN, {
        path: ownPath,
      });
      assert.equal(r.status, 204, `expected 204, got ${r.status}`);
      assert.ok(removedPaths.includes(ownPath), `expected storage.remove([${ownPath}]) to be called; got: ${JSON.stringify(removedPaths)}`);
    });
  });
});
