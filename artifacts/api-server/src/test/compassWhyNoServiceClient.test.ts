/**
 * census-discovery §104 (DV-83, D-W11X2-58) — GET /compass/why with no service
 * client answers a generic sentence. It is a stub, not the explanation, and it now
 * carries the refusal envelope, so the For You "Why am I seeing this?" sheet says
 * the read failed instead of presenting the stub as the reason.
 *
 *   W3  a signed-in viewer, a valid token, no service client → refused `nothing`, ["service_client"]
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────────
 * As discoveryFeedNoServiceClient.test.ts: `lib/supabase.ts` computes
 * `isServiceClientReady` from `process.env` once, at module evaluation. The env
 * vars are cleared before the route is imported dynamically.
 *
 * Run: node --import tsx/esm --test src/test/compassWhyNoServiceClient.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const express = (await import("express")).default;
const supabase = await import("../lib/supabase.js");
const { _setTestClient } = await import("../lib/http.js");
const { encodeRecommendationToken } = await import("../compass/CompassExplanationEngine.js");
const compassRouter = (await import("../routes/compass.js")).default;

const VIEWER = "ab000000-0000-4000-a000-000000000001";
const TOKEN = "tok-why-no-client";
const auth = {
  auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
  from: () => { const b: any = new Proxy({}, { get(_t, p: string) { if (p === "then") return (f: any) => Promise.resolve({ data: null, error: null }).then(f); if (p === "maybeSingle" || p === "single") return () => Promise.resolve({ data: p === "maybeSingle" ? { account_status: "active" } : null, error: null }); return () => b; } }); return b; },
};

let server: Server;
let base = "";
before(async () => {
  assert.equal(supabase.isServiceClientReady, false, "env was not cleared before lib/supabase.ts evaluated");
  _setTestClient(auth as any, true);
  supabase._setTestServiceClient(null);
  assert.equal(supabase.getServiceClient(), null, "getServiceClient() must return null for this suite");
  const app = express();
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());

describe("§104 GET /compass/why with no service client", () => {
  it("W3 the generic sentence carries the refusal: it is a stub, not the explanation", async () => {
    const tok = encodeRecommendationToken({ userId: VIEWER, itemId: "place:1", itemType: "place", sectionName: "for_you", explanationKey: "k" } as any);
    const r = await fetch(`${base}/compass/why/${encodeURIComponent(tok)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await r.json();
    assert.equal(body.refusal?.code, "why_unavailable", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["service_client"]);
  });
});
