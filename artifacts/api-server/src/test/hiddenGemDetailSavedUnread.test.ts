/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B36): GET /hidden-gems/:id never serves the viewer's own
 * saved state over a failed read as measured.
 *
 * The detail route read `hidden_gem_saves` with no error bound and served `savedByMe: !!saveRow`: `false` ("you have not
 * saved this gem") when the read failed. D-W11X2-128 left it as "not a Discovery result"; D-W11X2-177 rules the viewer's
 * own state inside DV-83, and the round-22 verifier holds the two in contradiction. `savedByMe` is now `null` over a
 * failed read, with the read named in `failedSources`; likewise when a token was presented but no viewer could be
 * resolved from it (the saved read could not be made for anyone), named `viewer`. An anonymous caller (no token) has
 * saved nothing: `false`, nothing named.
 *
 *   GS0 CONTROL: the viewer saved the gem → savedByMe true, nothing named
 *   GS1 the hidden_gem_saves read FAILS → savedByMe null, `hidden_gem_saves` named
 *   GS2 CONTROL: the viewer has not saved it → savedByMe false, nothing named
 *   GS3 CONTROL: no token → savedByMe false, nothing named
 *   GS4 a token whose viewer lookup THROWS → savedByMe null, `viewer` named
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const VIEWER = "ab000000-0000-4000-a000-0000000000a1";
const GEM = { id: "9e000000-0000-4000-a000-000000000001", name: "Tile courtyard", category: "viewpoint", city: "Lisbon", country: "PT", neighborhood: null, description: "x", latitude: 38.71, longitude: -9.13, approx_latitude: 38.71, approx_longitude: -9.13, vibe_tags: [], price_range: null, safety_notes: null, best_time_to_go: null, local_etiquette: null, layover_safe: false, minimum_layover_minutes: null, sensitivity_level: "public", verification_level: "community", status: "active", crowd_level: "quiet", submitted_by: null, guide_verified_by: null, save_count: 3, visit_count: 4, report_count: 0, image_url: "https://x/y.jpg", canonical_place_id: null, source_type: "user", moderation_status: "approved", created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), updated_at: new Date().toISOString() };

function client(opts: { fail?: string[]; saved?: boolean; authThrows?: boolean } = {}) {
  const fail = new Set(opts.fail ?? []);
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (fail.has(table)) return { data: null, error: ERR };
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ enabled: true }], error: null };
      if (table === "hidden_gems") return { data: single ? GEM : [GEM], error: null };
      if (table === "hidden_gem_saves") return { data: opts.saved ? (single ? { gem_id: GEM.id } : [{ gem_id: GEM.id }]) : (single ? null : []), error: null };
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
    auth: { getUser: async (t?: string) => { if (opts.authThrows) throw new Error("auth service unreachable"); return t === "tok-gem" ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "anon" } }; } },
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
async function detail(c: ReturnType<typeof client>, token: string | null = "tok-gem") {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/hidden-gems/${GEM.id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await r.json() as any;
  return { status: r.status, gem: body.gem?.id ?? null, savedByMe: body.savedByMe, failedSources: body.failedSources ?? null };
}

describe("census-discovery §122 (B36): GET /hidden-gems/:id never serves savedByMe over a failed read", () => {
  it("GS0 CONTROL: saved → savedByMe true, nothing named", async () => {
    assert.deepEqual(await detail(client({ saved: true })), { status: 200, gem: GEM.id, savedByMe: true, failedSources: null });
  });
  it("GS1 the hidden_gem_saves read FAILS → savedByMe null, `hidden_gem_saves` named", async () => {
    assert.deepEqual(await detail(client({ saved: true, fail: ["hidden_gem_saves"] })), { status: 200, gem: GEM.id, savedByMe: null, failedSources: ["hidden_gem_saves"] });
  });
  it("GS2 CONTROL: not saved → savedByMe false, nothing named", async () => {
    assert.deepEqual(await detail(client({ saved: false })), { status: 200, gem: GEM.id, savedByMe: false, failedSources: null });
  });
  it("GS3 CONTROL: no token → savedByMe false, nothing named", async () => {
    assert.deepEqual(await detail(client({ saved: true }), null), { status: 200, gem: GEM.id, savedByMe: false, failedSources: null });
  });
  it("GS4 a token whose viewer lookup THROWS → savedByMe null, `viewer` named", async () => {
    assert.deepEqual(await detail(client({ saved: true, authThrows: true })), { status: 200, gem: GEM.id, savedByMe: null, failedSources: ["viewer"] });
  });
});
