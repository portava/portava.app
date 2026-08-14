/**
 * GET /api/media/file — ?quality image-transform regression tests.
 *
 * The GET handler now parses ?quality=<n> alongside ?width=<n>.  These tests
 * confirm the same drop-not-clamp rule that the batch POST /api/media/sign
 * applies to quality:
 *
 *   1. ?quality=0   → fails qualityRounded > 0 guard; dropped entirely;
 *                     no transform forwarded; plain /object/sign/ URL.
 *   2. ?quality=75  → forwarded; redirect is a /render/image/sign/ URL.
 *   3. ?quality=200 → clamped to 100; redirect is /render/image/sign/.
 *   4. ?quality=0.1 → rounds to 0; dropped the same way as quality=0;
 *                     plain /object/sign/ URL.
 *   5. ?width=400&quality=0 → width is forwarded but quality is dropped;
 *                     redirect is /render/image/sign/ (width set), but
 *                     transform.quality must be absent.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaFileQualityTransform.test.ts
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

// VIEWER owns the media path — path-owner shortcut in authorizeMediaAccess
// fires immediately with no DB queries needed.
const VIEWER = "c4000000-0000-4000-d000-000000000003";
const TOKEN = "media-quality-token";

/** Arguments of the most-recent createSignedUrl call, captured by the mock. */
let lastSignArgs: { bucket: string; path: string; ttl: number; options: any } | null = null;

/**
 * Fake Supabase client.
 *
 * Storage mock mirrors real Supabase behaviour:
 *   - transform option present → /render/image/sign/ URL
 *   - no transform option      → /object/sign/ URL
 *
 * Auth mock grants VIEWER for TOKEN.
 * from() stub satisfies defensive DB paths without returning rows.
 */
function makeClient() {
  function noop(): any {
    const b: any = {
      select() { return b; },
      eq()     { return b; },
      in()     { return b; },
      is()     { return b; },
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

/** HTTP helper that preserves the query string in the request path. */
function req(
  method: string,
  urlPath: string,
): Promise<{ status: number; location: string | undefined; body: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlPath, base);
    const r = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: parsed,
          });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("GET /api/media/file — ?quality transform guard", () => {
  // Path owned by VIEWER → no DB needed for authorization.
  const mediaPath = `${VIEWER}/photo.jpg`;

  before(() => {
    process.env.SUPABASE_URL = SB;
    setClients(makeClient());
    const app = express();
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

  it("?quality=0 → dropped entirely; no transform forwarded; plain /object/sign/ URL", async () => {
    // quality=0 must be dropped — not clamped to quality=1 and forwarded as
    // a transform.  The caller should receive a plain /object/sign/ URL,
    // identical to what they would get if ?quality were absent entirely.
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?quality=0`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/object/sign/"),
      `expected plain /object/sign/ URL for quality=0 (dropped), got: ${r.location}`,
    );
    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options forwarded to createSignedUrl when quality=0",
    );
  });

  it("?quality=75 → forwarded; redirect is /render/image/sign/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?quality=75`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL for quality=75, got: ${r.location}`,
    );
    assert.ok(lastSignArgs?.options?.transform, "expected transform options for quality=75");
    assert.equal(
      lastSignArgs?.options?.transform?.quality,
      75,
      `expected transform.quality=75, got: ${lastSignArgs?.options?.transform?.quality}`,
    );
  });

  it("?quality=200 → clamped to 100; redirect is /render/image/sign/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?quality=200`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL for quality=200 (clamped), got: ${r.location}`,
    );
    assert.ok(lastSignArgs?.options?.transform, "expected transform options for quality=200");
    assert.equal(
      lastSignArgs?.options?.transform?.quality,
      100,
      `expected quality clamped to 100, got: ${lastSignArgs?.options?.transform?.quality}`,
    );
  });

  it("?quality=0.1 → rounds to 0; dropped entirely; plain /object/sign/ URL", async () => {
    // A sub-unit fraction passes a naive > 0 check but rounds to 0 — the
    // handler rounds first, then guards, so 0.1 is dropped the same way
    // as quality=0 (mirrors batch POST behaviour).
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?quality=0.1`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/object/sign/"),
      `expected plain /object/sign/ URL for quality=0.1 (rounds to 0), got: ${r.location}`,
    );
    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options forwarded when quality=0.1 (rounds to 0)",
    );
  });

  it("?quality=80 (no width) → forwarded; /render/image/sign/; transform.width absent", async () => {
    // The primary quality-only positive assertion: a caller that sends only
    // ?quality=80 (no ?width) must receive a /render/image/sign/ URL and the
    // createSignedUrl call must carry transform.quality=80 with no transform.width.
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?quality=80`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL for quality=80 (no width), got: ${r.location}`,
    );
    assert.ok(lastSignArgs?.options?.transform, "expected transform options for quality=80");
    assert.equal(
      lastSignArgs?.options?.transform?.quality,
      80,
      `expected transform.quality=80, got: ${lastSignArgs?.options?.transform?.quality}`,
    );
    assert.equal(
      lastSignArgs?.options?.transform?.width,
      undefined,
      "expected transform.width to be absent when no ?width param is sent",
    );
  });

  it("?quality=0.4 → rounds to 0; dropped entirely; plain /object/sign/ URL", async () => {
    // 0.4 is the highest sub-unit fraction that still rounds to 0.  It must be
    // dropped, not forwarded as quality=0.  Mirrors the 0.1 case but makes the
    // boundary explicit: anything in [0.0, 0.4] rounds to 0 and is dropped.
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?quality=0.4`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/object/sign/"),
      `expected plain /object/sign/ URL for quality=0.4 (rounds to 0), got: ${r.location}`,
    );
    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options forwarded when quality=0.4 (rounds to 0)",
    );
  });

  it("?width=400&quality=0 → width forwarded, quality dropped; /render/image/sign/ without quality", async () => {
    // When width is valid but quality=0, only the width transform is forwarded.
    // The redirect must be a /render/image/sign/ URL (because width is set),
    // but transform.quality must be absent — not promoted to 1.
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?width=400&quality=0`);
    assert.equal(r.status, 302, `expected 302, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.location?.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL (width=400 forwarded), got: ${r.location}`,
    );
    assert.ok(lastSignArgs?.options?.transform, "expected transform options (from width=400)");
    assert.equal(
      lastSignArgs?.options?.transform?.width,
      400,
      `expected transform.width=400, got: ${lastSignArgs?.options?.transform?.width}`,
    );
    assert.equal(
      lastSignArgs?.options?.transform?.quality,
      undefined,
      "expected transform.quality to be absent when quality=0 (dropped)",
    );
  });
});
