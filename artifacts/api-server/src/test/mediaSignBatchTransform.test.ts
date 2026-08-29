/**
 * POST /api/media/sign — transform clamping regression tests.
 *
 * The batch sign endpoint accepts an optional transform: { width, quality }
 * body field and clamps both values before forwarding them to Supabase's
 * createSignedUrl.  These tests confirm:
 *
 *   1. transform: { width: 5000 }  → clamped to 3000; /render/image/sign/ URL.
 *   2. transform: { quality: 200 } → clamped to 100;  /render/image/sign/ URL.
 *   3. transform: { width: 0 }     → dropped entirely (mirrors GET handler's
 *                                    parsedWidth > 0 guard); no transform
 *                                    forwarded; plain /object/sign/ URL returned.
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
      server = app.listen(0, "127.0.0.1", () => {
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

  it("transform: { width: 0 } → dropped entirely, no transform forwarded, plain /object/sign/ URL returned", async () => {
    // Mirrors the GET handler's explicit parsedWidth > 0 guard: width=0 is not
    // clamped to 1 but dropped entirely, so no transform is forwarded and the
    // caller receives a plain /object/sign/ URL (same as if no transform was
    // supplied at all).
    const r = await postSign({ urls: [mediaUrl], transform: { width: 0 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/object/sign/"),
      `expected plain /object/sign/ URL for width=0 (dropped), got: ${signedUrl}`,
    );

    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options forwarded to createSignedUrl when width=0",
    );
  });

  it("transform: { quality: 0 } → dropped entirely (mirrors width=0 guard), plain /object/sign/ URL returned", async () => {
    // quality=0 is dropped entirely — same rule as width=0.  A caller that
    // passes quality=0 must receive a plain /object/sign/ URL, not a
    // /render/image/sign/ URL.  This prevents quality=0 from being silently
    // promoted to quality=1 and forwarded as a transform.
    const r = await postSign({ urls: [mediaUrl], transform: { quality: 0 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/object/sign/"),
      `expected plain /object/sign/ URL for quality=0 (dropped), got: ${signedUrl}`,
    );

    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options forwarded to createSignedUrl when quality=0",
    );
  });

  it("transform: { width: 400, quality: 0 } → width forwarded, quality dropped, /render/image/sign/ URL returned", async () => {
    // The combo case: a valid width alongside quality=0.  The GET handler
    // (?width=400&quality=0) drops quality but still forwards width — the batch
    // POST must behave identically.  The caller must receive a
    // /render/image/sign/ URL (width was forwarded) with no transform.quality
    // (quality=0 was silently dropped, not promoted to 1).
    const r = await postSign({ urls: [mediaUrl], transform: { width: 400, quality: 0 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/render/image/sign/"),
      `expected /render/image/sign/ URL (width forwarded), got: ${signedUrl}`,
    );

    assert.ok(lastSignArgs?.options?.transform, "expected transform options to be passed to createSignedUrl");
    assert.equal(
      lastSignArgs?.options?.transform?.width,
      400,
      `expected width=400 forwarded, got: ${lastSignArgs?.options?.transform?.width}`,
    );
    assert.equal(
      lastSignArgs?.options?.transform?.quality,
      undefined,
      `expected quality to be absent (quality=0 dropped), got: ${lastSignArgs?.options?.transform?.quality}`,
    );
  });

  it("transform: { width: 0, quality: 75 } → entire transform dropped (width=0 opt-out wins), plain /object/sign/ URL returned", async () => {
    // The inverse of { width: 400, quality: 0 }: here width is the invalid field.
    // width=0 is treated as an explicit "no resize" signal that drops the ENTIRE
    // transform — even when quality is a perfectly valid 75.  A caller that
    // provides width=0 alongside a valid quality receives a plain /object/sign/
    // URL (no transform forwarded at all), not a /render/image/sign/ URL with
    // only quality forwarded.  This prevents the combo from sneaking through as
    // an unexpected quality-only transform.
    const r = await postSign({ urls: [mediaUrl], transform: { width: 0, quality: 75 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/object/sign/"),
      `expected plain /object/sign/ URL for {width:0, quality:75} (entire transform dropped), got: ${signedUrl}`,
    );

    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options forwarded to createSignedUrl when width=0 (even with valid quality)",
    );
  });

  it("transform: { quality: 0.1 } → rounds to 0, dropped entirely, plain /object/sign/ URL returned", async () => {
    // A sub-unit fractional quality like 0.1 passes a naive > 0 check but
    // rounds to 0 after Math.round.  The implementation rounds first and then
    // guards, so 0.1 is dropped the same way as quality=0 — no transform URL.
    const r = await postSign({ urls: [mediaUrl], transform: { quality: 0.1 } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const signedUrl: string | null = r.body?.signed?.[mediaUrl];
    assert.ok(
      typeof signedUrl === "string" && signedUrl.includes("/object/sign/"),
      `expected plain /object/sign/ URL for quality=0.1 (rounds to 0, dropped), got: ${signedUrl}`,
    );

    assert.equal(
      lastSignArgs?.options,
      undefined,
      "expected no transform options forwarded to createSignedUrl when quality=0.1 (rounds to 0)",
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
