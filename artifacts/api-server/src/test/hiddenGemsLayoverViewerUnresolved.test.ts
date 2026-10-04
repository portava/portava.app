/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the sweep beside the round-23 verifier's B42): a layover-safe
 * gem list is never answered from the query's own minutes for a viewer whose token could not be RESOLVED.
 *
 * `resolveCallerId` (routes/hiddenGems.ts) read the lookup's `data` alone, inside a catch that returned null: a lookup
 * that threw, or that Supabase Auth did not answer, was an anonymous caller. `layoverGemWindow(sc, null)` then answered
 * "no traveller, no layover", so a traveller IN a live layover was served the list for whatever `availableMinutes` the
 * request carried (§56, A13/A14: in a live layover the window is the certified snapshot's, and the query figure is
 * ignored). That is the answer the route already refuses when the snapshot itself is unreadable. An unresolved viewer is
 * the same unknown one step earlier, and gets the same refusal: 503 `degraded_unavailable`, retryable.
 *
 * A token Auth REJECTED is still an anonymous caller (D-W11X2-21's classifier), and a request that did not ask for the
 * layover-safe window is unchanged.
 *
 *   GL0  CONTROL: the viewer resolves, in no layover → GET /hidden-gems/layover-safe serves the stated window
 *   GL1  the lookup THROWS → /hidden-gems/layover-safe is 503 degraded_unavailable, no gems
 *   GL2  Auth answers 503 → the same
 *   GL3  the lookup THROWS → GET /hidden-gems?layoverSafe=1 is 503 degraded_unavailable
 *   GL4  CONTROL: Auth REJECTS the token (401 bad_jwt) → an anonymous caller: served
 *   GL5  CONTROL: no token → served
 *   GL6  CONTROL: the lookup THROWS on the plain list (no layoverSafe) → served as before
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/hiddenGemsLayoverViewerUnresolved.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "ab000000-0000-4000-a000-0000000000b2";
const GEM = { id: "9e000000-0000-4000-a000-000000000002", name: "Quiet cloister", category: "viewpoint", city: "Lisbon", country: "PT", neighborhood: null, description: "x", latitude: 38.71, longitude: -9.13, approx_latitude: 38.71, approx_longitude: -9.13, vibe_tags: [], price_range: null, safety_notes: null, best_time_to_go: null, local_etiquette: null, layover_safe: true, minimum_layover_minutes: 60, sensitivity_level: "public", verification_level: "community", status: "active", crowd_level: "quiet", submitted_by: null, guide_verified_by: null, save_count: 3, visit_count: 4, report_count: 0, image_url: "https://x/y.jpg", canonical_place_id: null, source_type: "user", moderation_status: "approved", created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), updated_at: new Date().toISOString() };

type Auth = "resolves" | "throws" | "503" | "rejected";
function client(auth: Auth) {
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ enabled: true }], error: null };
      if (table === "hidden_gems") return { data: single ? GEM : [GEM], error: null, count: 1 };
      return { data: single ? null : [], error: null, count: 0 };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return () => p;
    } });
    return p;
  };
  return {
    auth: { getUser: async (t?: string) => {
      if (auth === "throws") throw new Error("auth service unreachable");
      if (auth === "503") return { data: { user: null }, error: { name: "AuthApiError", status: 503, message: "upstream unavailable" } };
      if (auth === "rejected") return { data: { user: null }, error: { name: "AuthApiError", status: 401, code: "bad_jwt", message: "invalid JWT" } };
      return t === "tok-gem" ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { name: "AuthApiError", status: 401, code: "bad_jwt", message: "invalid JWT" } };
    } },
    from: b, rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", hiddenGemsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => { _setTestServiceClient(null); _setTestClient(null as any, false); server.close(); });

const LAYOVER_SAFE = "/hidden-gems/layover-safe?availableMinutes=600&city=Lisbon";
const LIST_LAYOVER = "/hidden-gems?layoverSafe=1&availableMinutes=600&city=Lisbon";
const LIST_PLAIN = "/hidden-gems?city=Lisbon";
async function get(path: string, auth: Auth, token: string | null = "tok-gem") {
  const c = client(auth);
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await r.json() as any;
  return { status: r.status, error: body.error ?? null, gems: Array.isArray(body.gems) ? body.gems.length : null };
}
const REFUSED = { status: 503, error: "degraded_unavailable", gems: null };

describe("census-discovery §123: a layover-safe gem list is not answered for a viewer nobody resolved", () => {
  it("GL0 CONTROL: the viewer resolves, in no layover → the stated window is served", async () => {
    const r = await get(LAYOVER_SAFE, "resolves");
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.notEqual(r.gems, null);
  });
  it("GL1 the lookup THROWS → /hidden-gems/layover-safe is 503 degraded_unavailable", async () => {
    assert.deepEqual(await get(LAYOVER_SAFE, "throws"), REFUSED);
  });
  it("GL2 Auth answers 503 → the same", async () => {
    assert.deepEqual(await get(LAYOVER_SAFE, "503"), REFUSED);
  });
  it("GL3 the lookup THROWS → GET /hidden-gems?layoverSafe=1 is 503 degraded_unavailable", async () => {
    assert.deepEqual(await get(LIST_LAYOVER, "throws"), REFUSED);
  });
  it("GL4 CONTROL: Auth REJECTS the token → an anonymous caller: served", async () => {
    const r = await get(LAYOVER_SAFE, "rejected");
    assert.equal(r.status, 200, JSON.stringify(r));
    const l = await get(LIST_LAYOVER, "rejected");
    assert.equal(l.status, 200, JSON.stringify(l));
  });
  it("GL5 CONTROL: no token → served", async () => {
    const r = await get(LAYOVER_SAFE, "throws", null);
    assert.equal(r.status, 200, JSON.stringify(r));
  });
  it("GL6 CONTROL: the lookup THROWS on the plain list (no layoverSafe) → served as before", async () => {
    const r = await get(LIST_PLAIN, "throws");
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.notEqual(r.gems, null);
  });
});
