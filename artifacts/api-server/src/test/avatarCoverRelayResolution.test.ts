/**
 * avatarCoverRelayResolution.test.ts
 *
 * Confirms that relay URLs returned by the avatar and cover upload endpoints
 * resolve correctly through GET /api/media/file/:bucket/*path — i.e. the
 * relay issues a 302 redirect to a signed URL rather than 403-ing the caller.
 *
 * Scenario for each upload type:
 *   1. POST /me/avatar/upload (or /me/cover/upload) with a valid JPEG body
 *      → captures the storage path from the 201 response.
 *   2. GET /media/file/profile-media/<path> with the same bearer token
 *      → asserts HTTP 302, confirming the relay signed the URL rather than
 *        denying access.
 *
 * Authorization short-circuit: authorizeMediaAccess returns true immediately
 * when owner === viewerId (own media), so no additional DB mock wiring is
 * needed beyond the upload-side fakes.
 *
 * Run: node --import tsx/esm --test src/test/avatarCoverRelayResolution.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearMediaAccessCache } from "../lib/mediaAccess.js";
import profileRouter from "../routes/profile.js";
import mediaFileRouter from "../routes/mediaFile.js";

// ── Identities ─────────────────────────────────────────────────────────────────

const USER_ID    = "ee111111-0000-4000-a000-000000000001";
const USER_TOKEN = "tok-relay-resolution-test";

// ── Minimal valid 1×1 JPEG that sharp can process ──────────────────────────────
// Generated via: sharp({ create:{width:1,height:1,channels:3,background:{r:255,g:255,b:255}} }).jpeg()
// Passes sniffMedia magic-byte check (FF D8 FF) and is decoded cleanly by sharp.
const TINY_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
  "base64",
);

// ── HTTP request helper ─────────────────────────────────────────────────────────

type ReqOpts = {
  binary?:      Buffer;
  contentType?: string;
};

function makeReq(base: string) {
  return function request(
    method: string,
    path: string,
    token: string,
    opts: ReqOpts = {},
  ): Promise<{ status: number; headers: Record<string, string | string[]>; body: any }> {
    return new Promise((resolve, reject) => {
      const url         = new URL(path, base);
      const payload     = opts.binary;
      const contentType = opts.contentType ?? "application/json";

      const r = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port),
          path:     url.pathname + url.search,
          method,
          headers: {
            "content-type":  contentType,
            "authorization": `Bearer ${token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({
              status:  res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[]>,
              body:    parsed,
            });
          });
        },
      );
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  };
}

// ── Fake Supabase client ────────────────────────────────────────────────────────

/** Last path passed to createSignedUrl — lets tests assert the relay called it. */
let lastSignedPath: string | null = null;

function buildFakeClient() {
  lastSignedPath = null;

  /** Generic query builder — returns empty data for all queries. */
  function from(_table: string) {
    const b: any = {
      select()        { return b; },
      insert()        { return b; },
      update()        { return b; },
      upsert()        { return b; },
      delete()        { return b; },
      eq()            { return b; },
      neq()           { return b; },
      in()            { return b; },
      or()            { return b; },
      is()            { return b; },
      ilike()         { return b; },
      gt()            { return b; },
      gte()           { return b; },
      lte()           { return b; },
      order()         { return b; },
      limit()         { return b; },
      range()         { return b; },
      contains()      { return b; },
      maybeSingle()   { return Promise.resolve({ data: null, error: null }); },
      single()        { return Promise.resolve({ data: null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
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
      /** Called by ensureStorageBucket — always succeeds. */
      createBucket: async () => ({ error: null }),
      from: (bucket: string) => ({
        /**
         * Avatar/cover upload: return success so the handler returns 201
         * with the storage path. Actual bytes are not stored (fake client).
         */
        upload: async (storagePath: string, _buf: Buffer, _opts: any) => ({
          data: { path: storagePath },
          error: null,
        }),
        /**
         * Relay signing: return a deterministic fake signed URL.
         * Capture the path so tests can assert it was called.
         */
        createSignedUrl: async (storagePath: string, _ttl: number) => {
          lastSignedPath = storagePath;
          return {
            data: { signedUrl: `https://signed.storage.example.com/${bucket}/${storagePath}` },
            error: null,
          };
        },
        getPublicUrl: () => ({
          data: { publicUrl: `https://storage.example.com/${bucket}` },
        }),
        remove: async () => ({ data: null, error: null }),
        list:   async () => ({ data: [], error: null }),
      }),
    },
  } as any;
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("Avatar & cover relay resolution — relay returns 302, not 403", () => {
  let server: Server;
  let base:   string;
  let req:    ReturnType<typeof makeReq>;

  before(async () => {
    const app = express();

    // Inject a no-op req.log so error branches in route handlers don't throw
    // when req.log.warn / req.log.error are called (pino is not wired in tests).
    app.use((reqIn: any, _res: any, next: any) => {
      reqIn.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });

    // Both routers share the /api prefix — same as the production app.
    app.use("/api", profileRouter);
    app.use("/api", mediaFileRouter);

    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    req  = makeReq(base);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    // Fresh fake client + cleared allow-cache before each test.
    const fc = buildFakeClient();
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    _clearMediaAccessCache();
  });

  // ── Avatar upload → relay ────────────────────────────────────────────────────

  describe("POST /me/avatar/upload → GET relay URL", () => {
    it("upload returns 201 with a profile-media path", async () => {
      const res = await req(
        "POST",
        "/api/me/avatar/upload",
        USER_TOKEN,
        { binary: TINY_JPEG, contentType: "image/jpeg" },
      );
      assert.equal(
        res.status, 201,
        `Expected 201 from avatar upload, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert.ok(
        typeof res.body?.path === "string" && res.body.path.startsWith("avatars/"),
        `Expected path starting with "avatars/", got: ${JSON.stringify(res.body)}`,
      );
    });

    it("relay URL resolves to 302 — not 403 — after a successful upload", async () => {
      // Step 1: upload to get the storage path.
      const uploadRes = await req(
        "POST",
        "/api/me/avatar/upload",
        USER_TOKEN,
        { binary: TINY_JPEG, contentType: "image/jpeg" },
      );
      assert.equal(
        uploadRes.status, 201,
        `Upload must succeed before testing relay; got ${uploadRes.status}: ${JSON.stringify(uploadRes.body)}`,
      );
      const storagePath: string = uploadRes.body.path; // "avatars/{userId}/{uuid}.jpg"

      // Step 2: resolve via relay. http.request does NOT follow redirects,
      // so a 302 means the relay issued a signed URL; a 403 means auth failed.
      const relayRes = await req(
        "GET",
        `/api/media/file/profile-media/${storagePath}`,
        USER_TOKEN,
      );
      assert.equal(
        relayRes.status, 302,
        `Expected relay to 302-redirect to signed URL, got ${relayRes.status}: ${JSON.stringify(relayRes.body)}`,
      );

      // The redirect Location must point to the fake signed URL, not the generic cover.
      const location = relayRes.headers["location"] as string | undefined;
      assert.ok(
        typeof location === "string" && location.includes("signed.storage.example.com"),
        `Expected Location to contain the signed URL, got: ${location}`,
      );
    });

    it("relay calls createSignedUrl with the correct path", async () => {
      const uploadRes = await req(
        "POST",
        "/api/me/avatar/upload",
        USER_TOKEN,
        { binary: TINY_JPEG, contentType: "image/jpeg" },
      );
      assert.equal(uploadRes.status, 201);
      const storagePath: string = uploadRes.body.path;

      await req("GET", `/api/media/file/profile-media/${storagePath}`, USER_TOKEN);

      assert.equal(
        lastSignedPath, storagePath,
        `createSignedUrl was called with "${lastSignedPath}" but expected "${storagePath}"`,
      );
    });

    it("relay returns 401 when no bearer token is sent", async () => {
      const relayRes = await req(
        "GET",
        `/api/media/file/profile-media/avatars/${USER_ID}/test.jpg`,
        "invalid-token",
      );
      assert.equal(
        relayRes.status, 401,
        `Expected 401 for unauthenticated relay request, got ${relayRes.status}`,
      );
    });
  });

  // ── Cover photo upload → relay ───────────────────────────────────────────────

  describe("POST /me/cover/upload → GET relay URL", () => {
    it("upload returns 201 with a profile-media covers/ path", async () => {
      const res = await req(
        "POST",
        "/api/me/cover/upload",
        USER_TOKEN,
        { binary: TINY_JPEG, contentType: "image/jpeg" },
      );
      assert.equal(
        res.status, 201,
        `Expected 201 from cover upload, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert.ok(
        typeof res.body?.path === "string" && res.body.path.startsWith("covers/"),
        `Expected path starting with "covers/", got: ${JSON.stringify(res.body)}`,
      );
    });

    it("relay URL resolves to 302 — not 403 — after a successful upload", async () => {
      // Step 1: upload.
      const uploadRes = await req(
        "POST",
        "/api/me/cover/upload",
        USER_TOKEN,
        { binary: TINY_JPEG, contentType: "image/jpeg" },
      );
      assert.equal(
        uploadRes.status, 201,
        `Cover upload must succeed before testing relay; got ${uploadRes.status}: ${JSON.stringify(uploadRes.body)}`,
      );
      const storagePath: string = uploadRes.body.path; // "covers/{userId}/cover.jpg"

      // Step 2: resolve via relay — must get 302, not 403.
      const relayRes = await req(
        "GET",
        `/api/media/file/profile-media/${storagePath}`,
        USER_TOKEN,
      );
      assert.equal(
        relayRes.status, 302,
        `Expected relay to 302-redirect to signed URL, got ${relayRes.status}: ${JSON.stringify(relayRes.body)}`,
      );

      const location = relayRes.headers["location"] as string | undefined;
      assert.ok(
        typeof location === "string" && location.includes("signed.storage.example.com"),
        `Expected Location to contain the signed URL, got: ${location}`,
      );
    });

    it("relay calls createSignedUrl with the correct cover path", async () => {
      const uploadRes = await req(
        "POST",
        "/api/me/cover/upload",
        USER_TOKEN,
        { binary: TINY_JPEG, contentType: "image/jpeg" },
      );
      assert.equal(uploadRes.status, 201);
      const storagePath: string = uploadRes.body.path;

      await req("GET", `/api/media/file/profile-media/${storagePath}`, USER_TOKEN);

      assert.equal(
        lastSignedPath, storagePath,
        `createSignedUrl was called with "${lastSignedPath}" but expected "${storagePath}"`,
      );
    });

    it("relay returns 401 when no bearer token is sent", async () => {
      const relayRes = await req(
        "GET",
        `/api/media/file/profile-media/covers/${USER_ID}/cover.jpg`,
        "invalid-token",
      );
      assert.equal(
        relayRes.status, 401,
        `Expected 401 for unauthenticated relay request, got ${relayRes.status}`,
      );
    });
  });
});
