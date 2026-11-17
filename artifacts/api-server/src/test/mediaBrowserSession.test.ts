import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { _setTestClient } from "../lib/http.js";
import { establishMediaBrowserSession, clearMediaBrowserSession, requireMediaViewer } from "../lib/media/mediaBrowserSession.js";

const VIEWER = "a1000000-0000-4000-a000-000000000002";
const OTHER = "a1000000-0000-4000-a000-000000000003";
const token = (owner: string, expires: number) => `e30.${Buffer.from(JSON.stringify({ sub: owner, exp: expires })).toString("base64url")}.c2ln`;
let validTokens = new Map<string, string>();
let active = true;
let authCalls: string[] = [];
let server: Server;
let base: string;
const fake = {
  auth: { getUser: async (value: string) => {
    authCalls.push(value);
    const owner = validTokens.get(value);
    return owner ? { data: { user: { id: owner, app_metadata: {} } }, error: null } : { data: { user: null }, error: { message: "Invalid token" } };
  } },
  rpc: async (name: string, args: { p_user: string }) => {
    assert.equal(name, "account_recovery_status");
    return { data: { userId: args.p_user, accountStatus: active ? "active" : "deactivated", mediaAccessAllowed: active }, error: null };
  },
  from: (table: string) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, limit: () => b,
      maybeSingle: async () => ({ data: table === "profiles" ? { account_status: "active", user_account_states: [] } : null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return b;
  },
};

describe("media-only browser session boundary", () => {
  before(async () => {
    _setTestClient(fake, true);
    const app = express();
    app.post("/session", establishMediaBrowserSession);
    app.delete("/session", clearMediaBrowserSession);
    app.get("/file", async (req, res) => {
      const beforeHeader = req.headers.authorization;
      const auth = await requireMediaViewer(req, res);
      assert.equal(req.headers.authorization, beforeHeader, "cookie adapter must not mutate request headers");
      if (auth) res.json({ viewerId: auth.user.id });
    });
    await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => { validTokens = new Map(); active = true; authCalls = []; });
  after(async () => { _setTestClient(null, false); await new Promise<void>(resolve => server.close(() => resolve())); });

  function verified(owner = VIEWER, remaining = 3600) {
    const value = token(owner, Math.floor(Date.now() / 1000) + remaining);
    validTokens.set(value, owner); return value;
  }
  function browserHeaders(value?: string) {
    return { "Sec-Fetch-Site": "same-origin", Origin: "https://rumazi.com", ...(value ? { Authorization: `Bearer ${value}` } : {}) };
  }
  const cookie = (value: string) => `portava_media_session=${encodeURIComponent(value)}`;

  it("issues a short HttpOnly Secure Strict cookie scoped only to the media file routes", async () => {
    const value = verified();
    const r = await fetch(`${base}/session`, { method: "POST", headers: browserHeaders(value) });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { viewerId: VIEWER, ttlSeconds: 90 });
    const set = r.headers.get("set-cookie")!;
    assert.match(set, /^portava_media_session=/); assert.match(set, /HttpOnly/); assert.match(set, /Secure/);
    assert.match(set, /SameSite=Strict/); assert.match(set, /Path=\/api\/media\/file/); assert.match(set, /Max-Age=90/);
    assert.doesNotMatch(set, /Domain=/); assert.match(r.headers.get("cache-control")!, /no-store/);
  });

  it("never extends cookie authority beyond the verified token expiry", async () => {
    const r = await fetch(`${base}/session`, { method: "POST", headers: browserHeaders(verified(VIEWER, 20)) });
    assert.equal(r.status, 200);
    const body = await r.json() as { ttlSeconds: number };
    assert.ok(body.ttlSeconds > 0 && body.ttlSeconds <= 20);
  });

  it("requires bearer renewal and active account even when a valid cookie already exists", async () => {
    const value = verified();
    const cookieOnly = await fetch(`${base}/session`, { method: "POST", headers: { ...browserHeaders(), Cookie: cookie(value) } });
    assert.equal(cookieOnly.status, 401); assert.equal(cookieOnly.headers.get("set-cookie"), null);
    active = false;
    const inactive = await fetch(`${base}/session`, { method: "POST", headers: browserHeaders(value) });
    assert.equal(inactive.status, 403); assert.equal(inactive.headers.get("set-cookie"), null);
  });

  it("refuses missing, same-site, and cross-site Fetch Metadata before authentication", async () => {
    const value = verified();
    for (const site of [undefined, "same-site", "cross-site", "none"]) {
      const r = await fetch(`${base}/session`, { method: "POST", headers: { Authorization: `Bearer ${value}`, ...(site ? { "Sec-Fetch-Site": site } : {}) } });
      assert.equal(r.status, 403); assert.equal(r.headers.get("set-cookie"), null);
    }
    assert.equal(authCalls.length, 0);
  });

  it("authenticates same-origin bytes through requireUser and binds their viewer", async () => {
    const value = verified();
    const r = await fetch(`${base}/file?viewer=${VIEWER}`, { headers: { ...browserHeaders(), Cookie: cookie(value) } });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { viewerId: VIEWER }); assert.deepEqual(authCalls, [value]);
    const other = await fetch(`${base}/file?viewer=${OTHER}`, { headers: { ...browserHeaders(), Cookie: cookie(value) } });
    assert.equal(other.status, 403);
    const missing = await fetch(`${base}/file`, { headers: { ...browserHeaders(), Cookie: cookie(value) } });
    assert.equal(missing.status, 403);
  });

  it("refuses cookie-only cross-origin embedding and duplicate cookies", async () => {
    const value = verified();
    for (const headers of [
      { "Sec-Fetch-Site": "cross-site", Cookie: cookie(value) },
      { "Sec-Fetch-Site": "same-site", Cookie: cookie(value) },
      { "Sec-Fetch-Site": "same-origin", Cookie: `${cookie(value)}; ${cookie(value)}` },
      { "Sec-Fetch-Site": "same-origin", Cookie: "portava_media_session=%GG" },
    ]) assert.equal((await fetch(`${base}/file?viewer=${VIEWER}`, { headers })).status, 401);
    assert.equal(authCalls.length, 0);
  });

  it("native bearer headers work independently, and invalid headers never fall back to cookies", async () => {
    const value = verified();
    const native = await fetch(`${base}/file?viewer=${VIEWER}`, { headers: { Authorization: `Bearer ${value}` } });
    assert.equal(native.status, 200);
    const invalid = await fetch(`${base}/file?viewer=${VIEWER}`, { headers: { ...browserHeaders("invalid"), Cookie: cookie(value) } });
    assert.equal(invalid.status, 401); assert.equal(authCalls.at(-1), "invalid");
  });

  it("cookie credentials are reverified on every request, not treated as prior authorization", async () => {
    const value = verified(); const headers = { ...browserHeaders(), Cookie: cookie(value) };
    assert.equal((await fetch(`${base}/file?viewer=${VIEWER}`, { headers })).status, 200);
    validTokens.delete(value);
    assert.equal((await fetch(`${base}/file?viewer=${VIEWER}`, { headers })).status, 401);
    assert.equal(authCalls.length, 2);
  });

  it("clears an expired cookie at sign-out without bearer authentication", async () => {
    const r = await fetch(`${base}/session`, { method: "DELETE", headers: browserHeaders() });
    assert.equal(r.status, 204);
    const set = r.headers.get("set-cookie")!;
    assert.match(set, /^portava_media_session=;/); assert.match(set, /Path=\/api\/media\/file/); assert.match(set, /HttpOnly/);
    assert.match(set, /Expires=Thu, 01 Jan 1970/); assert.equal(authCalls.length, 0);
    assert.equal((await fetch(`${base}/session`, { method: "DELETE", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  });

  it("does not issue a cookie from an expired or unbounded source token", async () => {
    const expired = verified(VIEWER, -1);
    const malformed = `e30.${Buffer.from(JSON.stringify({ sub: VIEWER })).toString("base64url")}.c2ln`;
    validTokens.set(malformed, VIEWER);
    for (const value of [expired, malformed]) {
      const r = await fetch(`${base}/session`, { method: "POST", headers: browserHeaders(value) });
      assert.equal(r.status, 401); assert.equal(r.headers.get("set-cookie"), null);
    }
  });
});
