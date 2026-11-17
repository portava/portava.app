import { installMediaDeliveryFixture, type MediaDeliveryRead } from "./helpers/mediaDeliveryFixture.js";
import {activeMediaAccountRead} from './helpers/mediaAccountReadFixture.js';
/** Authenticated media transform regression cases. These retain every
 * prior width/quality boundary and now assert actual provider byte requests,
 * successful streaming, and absence of provider redirects or signed links. */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearMediaAccessCache } from "../lib/mediaAccess.js";
import mediaFileRouter from "../routes/mediaFile.js";

const SB = "https://sb.example.test";
const OLD_SUPABASE_URL = process.env.SUPABASE_URL;

// VIEWER is the authenticated caller AND the path owner — so the
// path-owner shortcut inside authorizeMediaAccess fires immediately
// without any DB queries.
const VIEWER = "a2000000-0000-4000-b000-000000000001";
const TOKEN = "media-width-token";

// The last createSignedUrl call's arguments, captured by the mock.
let lastDeliveryArgs: MediaDeliveryRead | null = null;
let restoreDelivery: () => void;

/**
 * Build a fake Supabase client.
 *
 * The storage mock simulates Supabase's real behavior:
 *   - transform option present → /render/image/authenticated/ URL
 *   - no transform option      → /object/ URL
 *
 * The auth mock returns VIEWER for TOKEN.
 *
 * The from() builder returns a chainable stub that is only reached if
 * authorizeMediaAccess falls through the path-owner shortcut (which it
 * won't for paths owned by VIEWER). It is provided defensively.
 */
function makeClient() {
  function noop(): any {
    // `limit()`/`order()` are here because lib/mediaAccess.ts reaches the
    // stories table on the OWNER path too now (the deleted-story
    // recovery-window check). A builder missing them does not return "no rows"
    // — it throws, the branch fails closed, and every request in this file
    // answers 403 instead of exercising the transform logic it is about.
    const b: any = { select() { return b; }, contains() { return b; }, eq() { return b; }, in() { return b; },
      limit() { return Promise.resolve({ data: [], error: null }); }, order() { return b; },
      is() { return b; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      then(ok: any, _err: any) { return Promise.resolve({ data: [], error: null }).then(ok, _err); } };
    return b;
  }
  return {
    from(_table: string) { return noop(); },
    rpc: async (name: string, args: {p_user?: unknown}) => activeMediaAccountRead(name, args),
    storage: { from() { return { createSignedUrl() { throw new Error("Provider signing must be retired"); } }; } },
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
    url.searchParams.set("viewer", VIEWER);
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
          if (res.statusCode === 200) { assert.equal(res.headers.location, undefined); assert.equal(raw, "media-fixture-bytes"); }
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
    restoreDelivery = installMediaDeliveryFixture(read => { lastDeliveryArgs = read; });
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
    restoreDelivery();
    process.env.SUPABASE_URL = OLD_SUPABASE_URL;
    return new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    lastDeliveryArgs = null;
    _clearMediaAccessCache();
  });

  it("?width=1200 → transform forwarded, upstream uses /render/image/authenticated/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?width=1200`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      lastDeliveryArgs?.url.pathname.includes("/render/image/authenticated/"),
      `expected /render/image/authenticated/ URL, got: ${r.location}`,
    );
    assert.ok(lastDeliveryArgs?.options?.transform, "expected transform options to be passed to authenticated storage fetch");
    assert.equal(
      lastDeliveryArgs?.options?.transform?.width,
      1200,
      `expected transform.width=1200, got: ${lastDeliveryArgs?.options?.transform?.width}`,
    );
  });

  it("no ?width → no transform forwarded, upstream uses /object/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      lastDeliveryArgs?.url.pathname.includes("/object/"),
      `expected /object/ URL, got: ${r.location}`,
    );
    assert.equal(
      lastDeliveryArgs?.options,
      undefined,
      "expected no transform options when ?width is absent",
    );
  });

  it("?width=0 → fails parsedWidth > 0 guard; treated as absent; no transform forwarded", async () => {
    // The handler only sets a transform when parsedWidth > 0, so width=0 is
    // treated identically to an absent ?width param — no transform, plain /object/.
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?width=0`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      lastDeliveryArgs?.url.pathname.includes("/object/"),
      `expected /object/ URL for width=0, got: ${r.location}`,
    );
    assert.equal(
      lastDeliveryArgs?.options,
      undefined,
      "expected no transform options for width=0",
    );
  });

  it("?width=4000 → clamped to 3000, transform forwarded, upstream uses /render/image/authenticated/", async () => {
    const r = await req("GET", `/api/media/file/post-media/${mediaPath}?width=4000`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      lastDeliveryArgs?.url.pathname.includes("/render/image/authenticated/"),
      `expected /render/image/authenticated/ URL for width=4000 (clamped), got: ${r.location}`,
    );
    assert.ok(lastDeliveryArgs?.options?.transform, "expected transform options for width=4000");
    assert.equal(
      lastDeliveryArgs?.options?.transform?.width,
      3000,
      `expected transform.width clamped to 3000, got: ${lastDeliveryArgs?.options?.transform?.width}`,
    );
  });
});
