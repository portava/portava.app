/**
 * census-discovery §97 (DV-83, §94.10) — GET /discovery/feed with NO SERVICE
 * CLIENT and a presented Bearer token is an unresolved viewer, not an
 * anonymous one.
 *
 * With no client the viewer cannot be resolved at all, so the event-post read
 * the token asks for cannot happen. Before §97 that answered 200 with no posts
 * and no refusal: the "nothing live" screen, found by §97's independent
 * verifier after the first round had called this case unreachable.
 *
 *   N1  a Bearer token and no client: refused upstream_unavailable / feed_viewer_unresolved, "nothing", ["event_posts"]
 *   N2  CONTROL: no token and no client: an anonymous request, which owes no event-post read and carries no refusal
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────────
 * The same reason as authSignupStatusNoClient.test.ts: `lib/supabase.ts`
 * computes `isServiceClientReady` from `process.env` once, at module
 * evaluation, so `_setTestServiceClient(null)` never reaches the `!client`
 * branch. The env vars are cleared before the route is imported dynamically.
 *
 * Run: node --import tsx/esm --test src/test/discoveryFeedNoServiceClient.test.ts
 * (the file clears SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY itself, so the
 *  standard invocation works too.)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Cleared BEFORE the dynamic imports below so lib/supabase.ts evaluates
// `isServiceClientReady = false` and getServiceClient() genuinely returns null.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const express = (await import("express")).default;
const pino = (await import("pino")).default;
const supabase = await import("../lib/supabase.js");
const discoveryRouter = (await import("../routes/discovery.js")).default;

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const s = String(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const FEED_POSTS_ONLY = "/api/discovery/feed?city=Miami&lat=25.77&lng=-80.19&includePlaces=0&radiusKm=25";

let server: http.Server;
let base = "";

type FeedBody = { posts: unknown[]; refusal?: { class: string; code: string; coverage: string; failedSources: string[] } };

function get(path: string, auth: boolean): Promise<{ status: number; body: FeedBody }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET",
      headers: auth ? { authorization: "Bearer some-viewer-token" } : {},
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: unknown; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b as FeedBody }); });
    });
    r.on("error", reject);
    r.end();
  });
}

before(async () => {
  // The premise of every assertion below. If it stops holding, the cases would
  // exercise the client path and pass for the wrong reason.
  assert.equal(supabase.isServiceClientReady, false, "env was not cleared before lib/supabase.ts evaluated");
  assert.equal(supabase.getServiceClient(), null, "getServiceClient() must return null for this suite");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { log: unknown }).log = pino({ level: "silent" }); next(); });
  app.use("/api", discoveryRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); globalThis.fetch = _originalFetch; });

describe("GET /discovery/feed with no service client (DV-83, §97)", () => {
  it("N1 a Bearer token and no client: refused upstream_unavailable / feed_viewer_unresolved, coverage 'nothing'", async () => {
    const r = await get(FEED_POSTS_ONLY, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.ok(r.body.refusal, `a viewer nobody could resolve must not read as a quiet city: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.refusal.class, "upstream_unavailable");
    assert.equal(r.body.refusal.code, "feed_viewer_unresolved");
    assert.equal(r.body.refusal.coverage, "nothing");
    assert.deepEqual(r.body.refusal.failedSources, ["event_posts"]);
  });

  it("N2 CONTROL: no token and no client is an anonymous request, and carries no refusal", async () => {
    const r = await get(FEED_POSTS_ONLY, false);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.equal(r.body.refusal, undefined, "no read was owed, so none failed");
  });
});
