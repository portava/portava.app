/**
 * POST /api/media/sign — transform clamping regression tests.
 *
 * The batch sign endpoint accepts an optional transform: { width, quality }
 * body field and clamps both values before forwarding them to Supabase's
 * createSignedUrl.  These tests confirm:
 *
 *   1. transform: { width: 5000 }  → clamped to 3000; /render/image/sign/ URL.
 *   2. transform: { quality: 200 } → clamped to 100;  /render/image/sign/ URL.
 *   3. transform: { width: 0 }     → clamped to 1 (Math.max(0,1));
 *                                    transform IS forwarded; /render/image/sign/.
 *                                    Note: unlike the GET handler (which has an
 *                                    explicit parsedWidth > 0 guard), the POST
 *                                    handler clamps from 1, so width=0 → width=1.
 *   4. No transform field          → no transform forwarded; plain /object/sign/ URLs.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaSignBatchTransform.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearMediaAccessCache } from "../lib/mediaAccess.js";
import mediaFileRouter from "../routes/mediaFile.js";

const SB = "http://sb.example.test";
const OLD_SUPABASE_URL = process.env.SUPABASE_URL;

// VIEWER owns the media paths used in all tests — the path-owner shortcut
// inside authorizeMediaAccess fires without any DB queries.
const VIEWER = "b3000000-0000-4000-c000-000000000002";
const TOKEN = "media-sign-batch-token";

/** The arguments of the most-recent createSignedUrl call — captured by mock. */
let lastSignArgs: { bucket: string; path: string; ttl: number; options: any } | null = null;

/**
 * Build a fake Supabase client.
 *
 * The storage mock mirrors real Supabase behaviour:
 *   - transform present → /render/image/sign/ URL
 *   - no transform      → /object/sign/ URL
 *
 * The auth mock grants VIEWER for TOKEN.
 * The from() stub satisfies defensive DB paths (authorizeMediaAccess) without
 * returning any DB rows.
 */
function makeClient() {
  function noop(): any {
    const b: any = {
      select() { return b; },
      eq() { return b; },
      in() { return b; },
      is() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      then(ok: any, _err: any) { return Promise.resolve({ data: [], error: null }).then(ok, _err); },
    };
    return b;
  }
  return {
    from(_table: string) { return noop(); },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string, ttl: number, options?: any) => {
            lastSignArgs = { bucket, path, ttl, options };
            // Supabase returns a /render/image/sign/ URL when transform is set,
            // /object/sign/ for a plain signed URL.
            const signed = options?.transform
              ? `${SB}/storage/v1/render/image/sign/${bucket}/${path}?token=resized`
              : `${SB}/storage/v1/object/sign/${bucket}/${path}?token=signed`;
            return { data: { signedUrl: signed }, error: null };
          },
        };
      },
    },
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  } as any;
}

let server: http.Server;
let base: string;

function setClients(c: any) {
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

/**
 * POST helper — sends a JSON body with Authorization header and returns the
 * parsed response.
 */
function postSign(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL("/api/media/sign", base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
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

describe("POST /api/media/sign — transform clamping", () => {
  // Bare storage path owned by VIEWER → path-owner shortcut fires in
  // authorizeMediaAccess with no DB queries needed.
  const mediaPath = `${VIEWER}/feed-thumb.jpg`;
  const mediaUrl = `post-media/${mediaPath}`;

  before(() => {
    process.env.SUPABASE_URL = SB;
    setClients(makeClient());
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      r.log = { error() {}, info() {}, warn() {}, debug() {} };
      next();
    });
    app.use("/api", mediaFileRouter);
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  after(() => {
    process.env.SUPABASE_URL = OLD_SUPABASE_URL;
    return new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    lastSignArgs = null;
    _clearMediaAccessCache();
  });

  it("transform: { width: 5000 } → clamped to 3000, /render/image/sign/ URL returned", async () => {
    const r = await postSign({ urls: [mediaUrl], transform: { width: 5000 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL, got: ${signedUrl}`,
    );

    assert.ok(lastSignArgs?.options?.transform, "expected transform options to be passed to createSignedUrl");
    assert.equal(
      lastSignArgs?.options?.transform?.width,
      3000,
      `expected width clamped to 3000, got: ${lastSignArgs?.options?.transform?.width}`,
    );
  });

  it("transform: { quality: 200 } → clamped to 100, /render/image/sign/ URL returned", async () => {
    const r = await postSign({ urls: [mediaUrl], transform: { quality: 200 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL for quality=200 (clamped), got: ${signedUrl}`,
    );

    assert.ok(lastSignArgs?.options?.transform, "expected transform options to be passed to createSignedUrl");
    assert.equal(
      lastSignArgs?.options?.transform?.quality,
      100,
      `expected quality clamped to 100, got: ${lastSignArgs?.options?.transform?.quality}`,
    );
  });

  it("transform: { width: 0 } → clamped to 1 (Math.max(0,1)), transform forwarded, /render/image/sign/ URL returned", async () => {
    // Unlike the GET handler (which has an explicit parsedWidth > 0 guard and
    // drops width=0 entirely), the POST handler clamps with Math.max(width, 1),
    // so width=0 becomes width=1 and the transform IS still forwarded.
    const r = await postSign({ urls: [mediaUrl], transform: { width: 0 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL for width=0 (clamped to 1), got: ${signedUrl}`,
    );

    assert.ok(lastSignArgs?.options?.transform, "expected transform options to be passed to createSignedUrl");
    assert.equal(
      lastSignArgs?.options?.transform?.width,
      1,
      `expected width clamped to 1 (Math.max(0,1)), got: ${lastSignArgs?.options?.transform?.width}`,
    );
  });

  it("no transform field → no transform forwarded, plain /object/sign/ URLs returned", async () => {
    const r = await postSign({ urls: [mediaUrl] });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/object/sign/"),
      `expected /object/sign/ URL when no transform, got: ${signedUrl}`,
    );

    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options when transform field is absent",
    );
  });
});
