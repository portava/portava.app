/**
 * census-discovery §101 (lane W11-X2 round 5; DV-83, §100.11 finding 4) —
 * GET /discovery/community with NO SERVICE CLIENT is a refusal, not a quiet
 * city. Register D-W11X2-31.
 *
 * With no client the community table cannot be read at all. The route answered
 * 200 `{ items: [], city, total: 0 }` with no refusal — byte-identical to a city
 * whose travelers submitted nothing — and `useCommunityDiscovery` cached that
 * answer for five minutes. §98 fixed the same class for the feed. The arm now
 * sends the D11 refusal envelope, `upstream_unavailable` /
 * `community_service_unavailable`, coverage `nothing`, beside the same padding
 * the read-failure arm sends — so a consumer that reads `items` alone is no
 * worse off, and one that reads `refusal` (the hook: refused, never cached) is
 * told.
 *
 *   NC1  the table was not read: the body carries a refusal (the verifier's probe, unchanged)
 *   NC2  the refusal's shape: upstream_unavailable / community_service_unavailable, `nothing`, the route
 *   NC3  the padding is the read-failure arm's: items [], the city, total 0
 *   C1   CONTROL: no city is still 400 invalid_payload — validation comes first
 *
 * WHY THIS IS ITS OWN FILE: the same reason as discoveryFeedNoServiceClient.test.ts —
 * `lib/supabase.ts` computes `isServiceClientReady` from `process.env` once, at
 * module evaluation, so the env vars are cleared before the route is imported.
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityNoServiceClient.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const express = (await import("express")).default;
const pino = (await import("pino")).default;
const supabase = await import("../lib/supabase.js");
const discoveryRouter = (await import("../routes/discovery.js")).default;

let server: http.Server;
let base = "";

type CommunityBody = { items?: unknown[]; city?: string; total?: number; refusal?: { class: string; code: string; route: string; coverage: string }; error?: unknown };

function get(path: string, auth: boolean): Promise<{ status: number; body: CommunityBody }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET",
      headers: auth ? { authorization: "Bearer some-viewer-token" } : {},
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: unknown; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b as CommunityBody }); });
    });
    r.on("error", reject);
    r.end();
  });
}

before(async () => {
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

after(() => { server.close(); });

const PATH = "/api/discovery/community?city=Miami&type=all&limit=20";

describe("§101 — GET /discovery/community with no service client is a refusal (DV-83)", () => {
  it("NC1 the community table was not read: must not answer a bare empty list (needs a refusal)", async () => {
    const r = await get(PATH, false);
    assert.equal(r.status, 200);
    assert.ok(r.body.refusal, `unread table answered as empty: ${JSON.stringify(r.body)}`);
  });

  it("NC2 the refusal names the missing upstream, covers nothing, and names the route", async () => {
    for (const auth of [false, true]) {
      const r = await get(PATH, auth);
      assert.equal(r.body.refusal?.class, "upstream_unavailable");
      assert.equal(r.body.refusal?.code, "community_service_unavailable");
      assert.equal(r.body.refusal?.coverage, "nothing");
      assert.equal(r.body.refusal?.route, "GET /discovery/community");
    }
  });

  it("NC3 the padding is the read-failure arm's: items [], the city, total 0", async () => {
    const r = await get(PATH, false);
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.city, "Miami");
    assert.equal(r.body.total, 0);
  });

  it("C1 CONTROL no city is still 400 invalid_payload — validation comes first", async () => {
    const r = await get("/api/discovery/community?type=all", false);
    assert.equal(r.status, 400);
    assert.equal(r.body.refusal, undefined);
  });
});
