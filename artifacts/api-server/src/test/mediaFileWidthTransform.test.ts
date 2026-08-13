/**
 * GET /api/media/file — ?width image-transform regression tests.
 *
 * Task #3596 wired ?width=<n> from the post-detail view through to the
 * Supabase createSignedUrl transform option, which is the only mechanism
 * that produces a resized derivative from a private bucket. These tests
 * confirm three properties of that pipeline:
 *
 *   1. ?width=1200  → createSignedUrl receives a transform block → redirect
 *      is a /render/image/sign/ URL (not /object/sign/).
 *   2. Omitting ?width → createSignedUrl receives NO transform → redirect is
 *      the plain /object/sign/ URL.
 *   3. Out-of-range values:
 *      - width=0  → fails the parsedWidth > 0 guard; treated as absent; no
 *        transform forwarded → /object/sign/.
 *      - width=4000 → clamped to 3000 → transform forwarded → /render/image/sign/.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaFileWidthTransform.test.ts
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

// VIEWER is the authenticated caller AND the path owner — so the
// path-owner shortcut inside authorizeMediaAccess fires immediately
// without any DB queries.
const VIEWER = "a2000000-0000-4000-b000-000000000001";
const TOKEN = "media-width-token";

// The last createSignedUrl call's arguments, captured by the mock.
let lastSignArgs: { bucket: string; path: string; ttl: number; options: any } | null = null;

/**
 * Build a fake Supabase client.
 *
 * The storage mock simulates Supabase's real behavior:
 *   - transform option present → /render/image/sign/ URL
 *   - no transform option      → /object/sign/ URL
 *
 * The auth mock returns VIEWER for TOKEN.
 *
 * The from() builder returns a chainable stub that is only reached if
 * authorizeMediaAccess falls through the path-owner shortcut (which it
 * won't for paths owned by VIEWER). It is provided defensively.
 */
function makeClient() {
  function noop(): any {
    const b: any = { select() { return b; }, eq() { return b; }, in() { return b; },
      is() { return b; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      then(ok: any, _err: any) { return Promise.resolve({ data: [], error: null }).then(ok, _err); } };
    return b;
  }
  return {
    from(_table: string) { return noop(); },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string, ttl: number, options?: any) => {
            lastSignArgs = { bucket, path, ttl, options };
            // Supabase returns /render/image/sign/ when a transform is requested,
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
 * HTTP helper that includes the query string (unlike the one in mediaAccess.test.ts
 * which uses url.pathname only).
 */
function req(
  method: string,
  urlPath: string,
): Promise<{ status: number; body: any; location?: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search, // include query string
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p, location: res.headers.location as string | undefined });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("GET /api/media/file — ?width image-transform", () => {
  // Path owned by VIEWER → path-owner shortcut fires → no DB needed.
  const mediaPath = `${VIEWER}/full-screen-post.jpg`;

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

  it("?width=1200 → transform forwarded, redirect is /render/image/sign/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?width=1200`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL, got: ${r.location}`,
    );
    assert.ok(lastSignArgs?.options?.transform, "expected transform options to be passed to createSignedUrl");
    assert.equal(
      lastSignArgs?.options?.transform?.width,
      1200,
      `expected transform.width=1200, got: ${lastSignArgs?.options?.transform?.width}`,
    );
  });

  it("no ?width → no transform forwarded, redirect is /object/sign/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/object/sign/"),
      `expected /object/sign/ URL, got: ${r.location}`,
    );
    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options when ?width is absent",
    );
  });

  it("?width=0 → fails parsedWidth > 0 guard; treated as absent; no transform forwarded", async () => {
    // The handler only sets a transform when parsedWidth > 0, so width=0 is
    // treated identically to an absent ?width param — no transform, plain /object/sign/.
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?width=0`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/object/sign/"),
      `expected /object/sign/ URL for width=0, got: ${r.location}`,
    );
    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options for width=0",
    );
  });

  it("?width=4000 → clamped to 3000, transform forwarded, redirect is /render/image/sign/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?width=4000`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL for width=4000 (clamped), got: ${r.location}`,
    );
    assert.ok(lastSignArgs?.options?.transform, "expected transform options for width=4000");
    assert.equal(
      lastSignArgs?.options?.transform?.width,
      3000,
      `expected transform.width clamped to 3000, got: ${lastSignArgs?.options?.transform?.width}`,
    );
  });
});
