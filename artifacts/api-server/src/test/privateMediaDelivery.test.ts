import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { deliverPrivateMedia } from "../lib/media/privateMediaDelivery.js";
import { MEDIA_SIZE_LIMITS } from "../lib/mediaPipeline.js";

const VIEWER = "a1000000-0000-4000-a000-000000000002";
const path = `avatars/${VIEWER}/private file.mp4`;
const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const secret = "synthetic-service-credential";
let active = true;
let stalledAuthority = false;
let authReads = 0;
let upstreamCalls: { url: URL; init: RequestInit }[] = [];
let provide: (init: RequestInit) => Promise<Response>;
let observedSignal: AbortSignal | undefined;
const sc = {
  rpc: async (name: string, args: { p_user: string }) => {
    assert.equal(name, "account_recovery_status"); assert.equal(args.p_user, VIEWER);
    authReads++;
    if (stalledAuthority) return new Promise(() => {});
    return { error: null, data: { userId: VIEWER, accountStatus: active ? "active" : "deactivated", mediaAccessAllowed: active } };
  },
} as any;
const fakeFetch: typeof fetch = async (input, init) => {
  observedSignal = init?.signal as AbortSignal;
  upstreamCalls.push({ url: new URL(String(input)), init: init! });
  return provide(init!);
};
let server: Server;
let base: string;

function response(body = "abcdefghij", headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "video/mp4", "Content-Length": String(body.length), ...headers } });
}

describe("private media delivery transport", () => {
  before(async () => {
    process.env.SUPABASE_URL = "https://storage.example.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = secret;
    const app = express();
    app.all("/file", async (req, res) => {
      await deliverPrivateMedia(req, res, sc, VIEWER, typeof req.query.bucket === "string" ? req.query.bucket : "profile-media",
        typeof req.query.path === "string" ? req.query.path : path,
        req.query.transform ? { width: 640, quality: 75 } : undefined,
        { fetch: fakeFetch, idleTimeoutMs: req.query.timeout ? 30 : 1000, totalTimeoutMs: 3000 });
    });
    await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  });

  function reset() {
    active = true; stalledAuthority = false; authReads = 0; upstreamCalls = []; observedSignal = undefined;
    provide = async () => response();
  }

  it("streams bytes with fresh authorization and excludes provider credentials and headers", async () => {
    reset();
    provide = async () => response("abcdefghij", { Location: "https://provider.test/?token=private", "Set-Cookie": "service=secret", ETag: "provider-tag", "Cache-Control": "public,max-age=99999" });
    const r = await fetch(`${base}/file`, { headers: { Authorization: "Bearer viewer-secret", Cookie: "viewer=secret", "If-None-Match": "previous" } });
    assert.equal(r.status, 200); assert.equal(await r.text(), "abcdefghij");
    assert.equal(authReads, 1); assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0]!.url.href, `https://storage.example.test/storage/v1/object/profile-media/avatars/${VIEWER}/private%20file.mp4`);
    const h = new Headers(upstreamCalls[0]!.init.headers);
    assert.equal(h.get("authorization"), `Bearer ${secret}`); assert.equal(h.get("apikey"), secret);
    assert.equal(h.get("cookie"), null); assert.equal(h.get("if-none-match"), null);
    assert.equal(upstreamCalls[0]!.init.redirect, "error");
    assert.equal("cache" in upstreamCalls[0]!.init && upstreamCalls[0]!.init.cache, "no-store");
    assert.equal(upstreamCalls[0]!.init.credentials, "omit");
    for (const header of ["location", "set-cookie", "etag", "authorization", "apikey"]) assert.equal(r.headers.get(header), null);
    assert.match(r.headers.get("cache-control")!, /no-store/); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(observedSignal?.aborted, true);
  });

  it("a later admin deactivation denies GET and HEAD before any storage request, recovery restores access", async () => {
    reset();
    assert.equal((await fetch(`${base}/file`)).status, 200);
    active = false;
    for (const method of ["GET", "HEAD"]) assert.equal((await fetch(`${base}/file`, { method })).status, 403);
    assert.equal(upstreamCalls.length, 1); assert.equal(authReads, 3);
    active = true;
    assert.equal((await fetch(`${base}/file`)).status, 200);
    assert.equal(authReads, 4); assert.equal(upstreamCalls.length, 2);
  });

  for (const [range, contentRange, body] of [["bytes=2-4", "bytes 2-4/10", "cde"], ["bytes=7-", "bytes 7-9/10", "hij"], ["bytes=-3", "bytes 7-9/10", "hij"]]) {
    it(`streams and validates ${range}`, async () => {
      reset(); provide = async () => response(body, { "Content-Range": contentRange! }, 206);
      const r = await fetch(`${base}/file`, { headers: { Range: range!, "If-Range": '"revision-1"' } });
      assert.equal(r.status, 206); assert.equal(await r.text(), body); assert.equal(r.headers.get("content-range"), contentRange);
      const h = new Headers(upstreamCalls[0]!.init.headers);
      assert.equal(h.get("range"), range); assert.equal(h.get("if-range"), '"revision-1"');
    });
  }

  it("HEAD rechecks access, sends no body, and ignores Range as required by HTTP", async () => {
    reset(); provide = async init => { assert.equal(init.method, "HEAD"); assert.equal(new Headers(init.headers).get("range"), null); return new Response(null, { headers: { "content-length": "10", "content-type": "video/mp4" } }); };
    const r = await fetch(`${base}/file`, { method: "HEAD", headers: { Range: "bytes=2-3" } });
    assert.equal(r.status, 200); assert.equal(await r.text(), ""); assert.equal(r.headers.get("content-length"), "10"); assert.equal(authReads, 1);
  });

  it("transforms use authenticated rendering and encoded path, never signing", async () => {
    reset(); provide = async () => response("image", { "Content-Type": "image/webp" });
    const r = await fetch(`${base}/file?transform=true`);
    assert.equal(r.status, 200); assert.equal(await r.text(), "image");
    const u = upstreamCalls[0]!.url;
    assert.match(u.pathname, /^\/storage\/v1\/render\/image\/authenticated\/profile-media\//);
    assert.deepEqual(Object.fromEntries(u.searchParams), { width: "640", quality: "75", resize: "contain" });
    assert.equal(r.headers.get("content-type"), "image/webp");
  });

  it("invalid or multipart ranges never reach storage", async () => {
    reset();
    for (const range of ["bytes=0-1,3-4", "bytes=-0", "bytes=9-2", "bytes=9007199254740992-", "items=0-1", "bytes=-"]) {
      assert.equal((await fetch(`${base}/file`, { headers: { Range: range } })).status, 416, range);
    }
    assert.equal(upstreamCalls.length, 0);
  });

  it("invalid references and methods never query storage", async () => {
    reset();
    for (const badPath of ["../other", "a/../other", "a//other", "a\\other", "/other"]) {
      assert.equal((await fetch(`${base}/file?path=${encodeURIComponent(badPath)}`)).status, 400);
    }
    assert.equal((await fetch(`${base}/file?bucket=foreign`)).status, 400);
    assert.equal((await fetch(`${base}/file`, { method: "POST" })).status, 405);
    assert.equal(upstreamCalls.length, 0); assert.equal(authReads, 0);
  });

  it("does not follow redirects or expose provider failures", async () => {
    reset();
    for (const status of [301, 302, 307, 401, 403, 500]) {
      provide = async () => response("credential-private", { Location: "https://foreign.test/?token=private" }, status);
      const r = await fetch(`${base}/file`);
      assert.equal(r.status, 502); assert.equal(r.headers.get("location"), null); assert.equal(await r.text(), "Bad Gateway");
    }
    provide = async () => response("provider-debug-private", {}, 404);
    const r = await fetch(`${base}/file`); assert.equal(r.status, 404); assert.equal(await r.text(), "Not Found");
  });

  it("validates unsatisfied ranges without leaking provider error bodies", async () => {
    reset(); provide = async () => response("private-provider-error", { "Content-Range": "bytes */10" }, 416);
    const r = await fetch(`${base}/file`, { headers: { Range: "bytes=20-" } });
    assert.equal(r.status, 416); assert.equal(r.headers.get("content-range"), "bytes */10"); assert.doesNotMatch(await r.text(), /private/);
  });

  it("refuses mismatched, unbounded, or encoded range metadata", async () => {
    reset();
    const variants: Record<string, string>[] = [
      { "Content-Range": "bytes 0-2/10" },
      { "Content-Range": "bytes 2-4/10", "Content-Length": "9" },
      { "Content-Range": "bytes 2-4/9007199254740993" },
      { "Content-Range": "bytes 2-4/10", "Content-Encoding": "gzip" },
      { "Content-Range": `bytes 2-4/${MEDIA_SIZE_LIMITS.video + 1}` },
    ];
    for (const headers of variants) {
      provide = async () => response("cde", headers, 206);
      const r = await fetch(`${base}/file`, { headers: { Range: "bytes=2-4" } });
      assert.equal(r.status, 502); assert.equal(await r.text(), "Bad Gateway");
    }
  });

  it("does not render uploaded markup as an active document", async () => {
    reset(); provide = async () => response("<svg/>", { "Content-Type": "image/svg+xml" });
    const r = await fetch(`${base}/file`);
    assert.equal(r.headers.get("content-type"), "application/octet-stream"); assert.match(r.headers.get("content-security-policy")!, /sandbox/);
  });

  it("refuses oversized full responses before streaming", async () => {
    reset(); provide = async () => response("x", { "Content-Length": String(MEDIA_SIZE_LIMITS.video + 1) });
    const r = await fetch(`${base}/file`); assert.equal(r.status, 502); assert.equal(await r.text(), "Bad Gateway");
  });

  it("streams a first chunk before the provider completes and cancels when the client leaves", async () => {
    reset(); let cancelled = false;
    provide = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("first")); }, cancel() { cancelled = true; } }), { headers: { "content-type": "video/mp4" } });
    const abort = new AbortController();
    const r = await fetch(`${base}/file`, { signal: abort.signal });
    const reader = r.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
    abort.abort();
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cancelled, true); assert.equal(observedSignal?.aborted, true);
  });

  it("bounds a provider that stalls before headers without leaking timeout details", async () => {
    reset(); provide = async () => new Promise(() => {});
    const r = await fetch(`${base}/file?timeout=1`);
    assert.equal(r.status, 502); assert.equal(await r.text(), "Bad Gateway"); assert.equal(observedSignal?.aborted, true);
  });

  it("bounds unreadable authorization without fetching any private bytes", async () => {
    reset(); stalledAuthority = true;
    const r = await fetch(`${base}/file?timeout=1`);
    assert.equal(r.status, 502); assert.equal(await r.text(), "Bad Gateway"); assert.equal(upstreamCalls.length, 0);
  });

  it("cancels a stalled upstream body and returns a bounded failure", async () => {
    reset(); let cancelled = false;
    provide = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "video/mp4" } });
    const r = await fetch(`${base}/file?timeout=1`);
    assert.equal(r.status, 502); assert.equal(await r.text(), "Bad Gateway");
    assert.equal(cancelled, true); assert.equal(observedSignal?.aborted, true);
  });

  it("terminates incomplete streams instead of reporting successful content", async () => {
    reset(); provide = async () => response("short", { "Content-Length": "20" });
    await assert.rejects(async () => { const r = await fetch(`${base}/file`); await r.arrayBuffer(); });
  });
});
