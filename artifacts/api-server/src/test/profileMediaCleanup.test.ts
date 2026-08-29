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
    server = app.listen(0, "127.0.0.1");
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

/* ---------------------------------------------------------------------------
 * cleanupOldMedia — replacing an avatar/cover must delete the OLD object
 * ---------------------------------------------------------------------------
 * This is the PATCH /me/profile path, not the explicit DELETE endpoints above,
 * and it was untested. It is also the highest-volume orphan producer: it runs
 * on every avatar change.
 *
 * It used to look for `/object/public/<bucket>/` in the old URL and skip when
 * absent. The upload endpoints return a BUCKET-QUALIFIED path
 * (`profile-media/avatars/…`), so the format this server writes was the one
 * the cleanup could not parse — and every replacement orphaned its
 * predecessor. Measured live 2026-08-09: 20 orphaned objects across 6 users.
 *
 * The bucket-path case below is the one that fails against the old code. The
 * public-URL case passed before and after, so on its own it would have proved
 * nothing.
 */

const OLD_PATH = "avatars/cccccccc-cccc-cccc-cccc-cccccccccccc/old.jpg";
const NEW_URL  = "profile-media/avatars/cccccccc-cccc-cccc-cccc-cccccccccccc/new.jpg";

function buildReplacementFake(currentAvatarUrl: string | null) {
  removedPaths = [];
  function from(_table: string) {
    const b: any = {
      select() { return b; },
      insert() { return b; },
      update() { return b; },
      delete() { return b; },
      upsert() { return b; },
      eq() { return b; },
      neq() { return b; }, in() { return b; }, or() { return b; },
      ilike() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; },
      maybeSingle() {
        return Promise.resolve({
          data: { avatar_url: currentAvatarUrl, cover_photo_url: null },
          error: null,
        });
      },
      single() {
        return Promise.resolve({
          data: { id: USER_ID, avatar_url: currentAvatarUrl }, error: null,
        });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    auth: {
      getUser: async (token: string) =>
        token === USER_TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from,
    storage: {
      from: (_bucket: string) => ({
        remove: async (paths: string[]) => { removedPaths.push(...paths); return { data: null, error: null }; },
        upload: async () => ({ data: null, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://example.com/file" } }),
      }),
    },
  };
}

/** cleanupOldMedia runs in setImmediate after the response is sent. */
const afterCleanup = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

describe("Profile media cleanup — replacing an avatar deletes the old object", () => {
  let server2: http.Server;
  let base2: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", profileRouter);
    server2 = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server2.once("listening", r));
    base2 = `http://127.0.0.1:${(server2.address() as any).port}`;
  });

  after(async () => {
    server2.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  async function patchAvatar(oldStored: string | null): Promise<void> {
    const fc = buildReplacementFake(oldStored);
    _setTestClient(fc as any, true);
    _setTestServiceClient(fc as any);
    const url = new URL("/api/me/profile", base2);
    const payload = JSON.stringify({ avatarUrl: NEW_URL });
    await new Promise<void>((resolve, reject) => {
      const r = http.request(
        {
          hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "PATCH",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${USER_TOKEN}`,
            "content-length": Buffer.byteLength(payload).toString(),
          },
        },
        (res) => { res.on("data", () => {}); res.on("end", () => resolve()); },
      );
      r.on("error", reject);
      r.write(payload);
      r.end();
    });
    await afterCleanup();
  }

  it("removes the old object when the stored value is a BUCKET-QUALIFIED path", async () => {
    // The format the upload endpoints actually return. Fails against the old
    // marker-slice implementation, which skipped it entirely.
    await patchAvatar(`profile-media/${OLD_PATH}`);
    assert.ok(
      removedPaths.includes(OLD_PATH),
      `expected storage.remove(["${OLD_PATH}"]); got ${JSON.stringify(removedPaths)}`,
    );
  });

  it("removes the old object when the stored value is a public URL", async () => {
    await patchAvatar(`https://ref.supabase.co/storage/v1/object/public/profile-media/${OLD_PATH}`);
    assert.ok(
      removedPaths.includes(OLD_PATH),
      `expected storage.remove(["${OLD_PATH}"]); got ${JSON.stringify(removedPaths)}`,
    );
  });

  it("removes the old object when the stored value is a signed URL", async () => {
    await patchAvatar(
      `https://ref.supabase.co/storage/v1/object/sign/profile-media/${OLD_PATH}?token=abc.def`,
    );
    assert.ok(
      removedPaths.includes(OLD_PATH),
      `query string must be stripped from the path; got ${JSON.stringify(removedPaths)}`,
    );
  });

  it("does NOT call storage.remove for an external seed URL", async () => {
    // 27 of 30 live avatars are picsum/unsplash/dicebear. There is no object of
    // ours to delete, and attempting one would be a wasted call against a path
    // parsed out of somebody else's URL.
    await patchAvatar("https://picsum.photos/seed/abc/400");
    assert.deepEqual(removedPaths, []);
  });

  it("does NOT call storage.remove when there was no previous avatar", async () => {
    await patchAvatar(null);
    assert.deepEqual(removedPaths, []);
  });
});
