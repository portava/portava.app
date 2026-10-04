/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-110, D-W11X2-111): GET /hidden-gems (Discovery
 * serve point 11) never serves a gem state or confidence derived from a failed aggregate read, and never
 * answers an unread `hidden_gems_enabled` as `404 feature_disabled`.
 *
 * `batchFetchGemAggregates` (services/hiddenGems/HiddenGemContributionService.ts) logged a failed
 * verifications, visits or contributions read as "non-fatal" and took `[]`, so `projectGem` derived a
 * measured-looking state from zeros; and the route's local `isFlagEnabled` answered `false` for a failed flag
 * read. A projection now carries the reads that failed (`unreadSources`), every caller serves no state or
 * confidence from it and names the failure (`refusal: partial`, `gem_state_unread`), and every flag gate
 * answers an unreadable flag 503 `flag_unreadable` (§111.1 B4).
 *
 * The round-13 verifier's probes, copied in unchanged (V13-GM0, GM1, GF1), and this lane's:
 *   GM2  the visits read fails → no state, no confidence; the refusal names hidden_gem_visits
 *   GM3  the contributions read fails → the same, naming hidden_gem_contributions
 *   GM4  GET /hidden-gems/:id, the verifications read fails → no state or confidence, `gemStateUnread` names it
 *   GM5  GET /hidden-gems/nearby, the same → no state; the refusal names it
 *   GM6  POST /hidden-gems/:id/contribute, the same → gemState and gemConfidence null, gemStateUnread; GM6c their control
 *   WL1  the Wall's Live strip, the contributions read fails on a gem the community reported closed → no "recently
 *        confirmed" item (a failed read dropped the closed reports and made the state MORE positive); WLc its control
 *   WL2  the Wall's context thread, the verifications read fails → no hidden-gem thread; WL2c its control
 *   GMc  CONTROL: healthy reads → state and confidence served, no refusal key (the body is unchanged)
 *   GF2  CONTROL: the flag read succeeds and is off → 404 feature_disabled, as before
 *   GF4  CONTROL: no flag row → 404 feature_disabled, as before
 *   GF3  GET /hidden-gems/:id, the flag read fails → 503 flag_unreadable
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import { buildGemLiveCandidates } from "../services/wall/LiveForYouService.js";
import { _internal as contextThreadInternal } from "../services/wall/ContextThreadService.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const GEM = { id: "9e000000-0000-4000-a000-000000000001", name: "Tile courtyard", category: "viewpoint", city: "Lisbon", country: "PT", neighborhood: null, description: "x", latitude: 38.71, longitude: -9.13, approx_latitude: 38.71, approx_longitude: -9.13, vibe_tags: [], price_range: null, safety_notes: null, best_time_to_go: null, local_etiquette: null, layover_safe: false, minimum_layover_minutes: null, sensitivity_level: "public", verification_level: "community", status: "active", crowd_level: "quiet", submitted_by: null, guide_verified_by: null, save_count: 3, visit_count: 4, report_count: 0, image_url: "https://x/y.jpg", canonical_place_id: null, source_type: "user", moderation_status: "approved", created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), updated_at: new Date().toISOString() };
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
const VERIFS = Array.from({ length: 5 }, (_, i) => ({ gem_id: GEM.id, user_id: `ab000000-0000-4000-a000-00000000010${i}`, result: "approved", created_at: recent }));

function client(opts: { fail?: string[]; flagOff?: boolean; flagAbsent?: boolean } = {}) {
  const fail = new Set(opts.fail ?? []);
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (fail.has(table)) return { data: null, error: ERR };
      if (table === "feature_flags" && opts.flagAbsent) return { data: single ? null : [], error: null };
      if (table === "feature_flags") return { data: single ? { enabled: !opts.flagOff } : [{ enabled: !opts.flagOff }], error: null };
      if (table === "hidden_gems") return { data: single ? GEM : [GEM], error: null };
      if (table === "hidden_gem_verifications") return { data: VERIFS, error: null };
      return { data: single ? null : [], error: null, count: 0 };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async (t?: string) => (t === "tok-gem" ? { data: { user: { id: "ab000000-0000-4000-a000-0000000000a1" } }, error: null } : { data: { user: null }, error: { message: "anon" } }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", hiddenGemsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
async function gems(c: ReturnType<typeof client>) {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/hidden-gems?city=Lisbon`);
  return { status: r.status, body: await r.json() as any };
}

describe("v13: GET /hidden-gems' gem state and confidence over a failed aggregate read", () => {
  let healthy: any;
  it("V13-GM0 CONTROL: healthy reads → the gem is served with its measured state and confidence", async () => {
    const { status, body } = await gems(client());
    assert.equal(status, 200, JSON.stringify(body));
    healthy = body.gems?.[0];
    assert.ok(healthy?.gemConfidence, JSON.stringify(body));
  });
  it("V13-GM1 the verifications read fails → the gem is not served a lower confidence / other state as if measured", async () => {
    const { status, body } = await gems(client({ fail: ["hidden_gem_verifications"] }));
    const g = body.gems?.[0];
    const stated = status === 200 && g && g.gemConfidence && !("gemConfidenceUnread" in g) && !body.refusal;
    const differs = stated && (g.gemConfidence.band !== healthy.gemConfidence.band || g.gemConfidence.score !== healthy.gemConfidence.score || g.gemState !== healthy.gemState);
    assert.ok(!differs, `healthy ${JSON.stringify({ s: healthy.gemState, c: healthy.gemConfidence })} vs failed read ${JSON.stringify({ s: g?.gemState, c: g?.gemConfidence, refusal: body.refusal ?? null })}`);
  });
  it("V13-GF1 the hidden_gems_enabled flag read fails → never 'feature_disabled'", async () => {
    const { status, body } = await gems(client({ fail: ["feature_flags"] }));
    assert.notEqual(body.error, "feature_disabled", `an unread flag was answered as the feature being off: ${status} ${JSON.stringify(body)}`);
  });
  it("GM2 the visits read fails → no state or confidence, and the refusal names hidden_gem_visits", async () => {
    const { status, body } = await gems(client({ fail: ["hidden_gem_visits"] }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.gems[0].gemState, undefined, JSON.stringify(body.gems[0]));
    assert.equal(body.gems[0].gemConfidence, undefined, JSON.stringify(body.gems[0]));
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body.refusal));
    assert.deepEqual(body.refusal?.failedSources, ["hidden_gem_visits"], JSON.stringify(body.refusal));
  });
  it("GM3 the contributions read fails → the same, naming hidden_gem_contributions", async () => {
    const { body } = await gems(client({ fail: ["hidden_gem_contributions"] }));
    assert.equal(body.gems[0].gemState, undefined, JSON.stringify(body.gems[0]));
    assert.deepEqual(body.refusal?.failedSources, ["hidden_gem_contributions"], JSON.stringify(body.refusal));
  });
  it("GM1b the verifications read fails → no state or confidence, and the refusal names it", async () => {
    const { body } = await gems(client({ fail: ["hidden_gem_verifications"] }));
    assert.equal(body.gems[0].gemState, undefined, JSON.stringify(body.gems[0]));
    assert.equal(body.gems[0].gemConfidence, undefined, JSON.stringify(body.gems[0]));
    assert.equal(body.refusal?.code, "gem_state_unread", JSON.stringify(body.refusal));
    assert.deepEqual(body.refusal?.failedSources, ["hidden_gem_verifications"], JSON.stringify(body.refusal));
  });
  it("GM4 GET /hidden-gems/:id, the verifications read fails → no state or confidence; gemStateUnread names it", async () => {
    const c = client({ fail: ["hidden_gem_verifications"] });
    _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const r = await fetch(`${base}/hidden-gems/${GEM.id}`); const body = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.gem.gemState, undefined, JSON.stringify(body.gem));
    assert.equal(body.gem.gemConfidence, undefined, JSON.stringify(body.gem));
    assert.deepEqual(body.gem.gemStateUnread, ["hidden_gem_verifications"], JSON.stringify(body.gem));
  });
  it("GMc CONTROL: healthy reads → state and confidence served, and no refusal key", async () => {
    const { body } = await gems(client());
    assert.ok(body.gems[0].gemState && body.gems[0].gemConfidence, JSON.stringify(body.gems[0]));
    assert.equal("refusal" in body, false, JSON.stringify(body));
    const c = client(); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const d = await (await fetch(`${base}/hidden-gems/${GEM.id}`)).json() as any;
    assert.ok(d.gem.gemState && d.gem.gemConfidence && !("gemStateUnread" in d.gem), JSON.stringify(d.gem));
  });
  it("GF2 CONTROL: the flag read succeeds and is off → 404 feature_disabled", async () => {
    const { status, body } = await gems(client({ flagOff: true }));
    assert.equal(status, 404, JSON.stringify(body));
    assert.equal(body.error, "feature_disabled");
  });
  it("GF4 CONTROL: no flag row (absent) → 404 feature_disabled, as before", async () => {
    const { status, body } = await gems(client({ flagAbsent: true }));
    assert.equal(status, 404, JSON.stringify(body));
    assert.equal(body.error, "feature_disabled");
  });
  it("GF3 GET /hidden-gems/:id, the flag read fails → 503 flag_unreadable", async () => {
    const c = client({ fail: ["feature_flags"] }); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const r = await fetch(`${base}/hidden-gems/${GEM.id}`); const body = await r.json() as any;
    assert.equal(r.status, 503, JSON.stringify(body));
    assert.equal(body.error, "degraded_unavailable"); assert.equal(body.reason, "flag_unreadable");
  });
  it("GF1b GET /hidden-gems, the flag read fails → 503 degraded_unavailable / flag_unreadable", async () => {
    const { status, body } = await gems(client({ fail: ["feature_flags"] }));
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body.reason, "flag_unreadable", JSON.stringify(body));
  });
  it("GM5 GET /hidden-gems/nearby, the verifications read fails → no state or confidence, and the refusal names it", async () => {
    const c = client({ fail: ["hidden_gem_verifications"] }); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const r = await fetch(`${base}/hidden-gems/nearby?lat=38.71&lng=-9.13&radiusKm=5`, { headers: { Authorization: "Bearer tok-gem" } }); const body = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.ok(body.gems.length > 0, JSON.stringify(body));
    assert.equal(body.gems[0].gemState, undefined, JSON.stringify(body.gems[0]));
    assert.deepEqual(body.refusal?.failedSources, ["hidden_gem_verifications"], JSON.stringify(body.refusal));
  });
  it("GM6 POST /hidden-gems/:id/contribute, the verifications read fails → gemState and gemConfidence null, gemStateUnread names it", async () => {
    const c = client({ fail: ["hidden_gem_verifications"] }); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const r = await fetch(`${base}/hidden-gems/${GEM.id}/contribute`, { method: "POST", headers: { Authorization: "Bearer tok-gem", "content-type": "application/json" }, body: JSON.stringify({ contributionType: "still_here" }) }); const body = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.gemState, null, JSON.stringify(body));
    assert.equal(body.gemConfidence, null, JSON.stringify(body));
    assert.deepEqual(body.gemStateUnread, ["hidden_gem_verifications"], JSON.stringify(body));
  });
  it("GM6c CONTROL: nearby and contribute over healthy reads → state and confidence served, no refusal or marker", async () => {
    const c = client(); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const n = await (await fetch(`${base}/hidden-gems/nearby?lat=38.71&lng=-9.13&radiusKm=5`, { headers: { Authorization: "Bearer tok-gem" } })).json() as any;
    assert.ok(n.gems[0]?.gemState && !("refusal" in n), JSON.stringify(n).slice(0, 300));
    const k = await (await fetch(`${base}/hidden-gems/${GEM.id}/contribute`, { method: "POST", headers: { Authorization: "Bearer tok-gem", "content-type": "application/json" }, body: JSON.stringify({ contributionType: "still_here" }) })).json() as any;
    assert.ok(k.gemState && k.gemConfidence && !("gemStateUnread" in k), JSON.stringify(k));
  });
});

// ── The Wall's two readers of the same projection (census-wall surfaces; the same derivation) ──
const WALL_NOW = new Date();
const wallRecent = new Date(WALL_NOW.getTime() - 86_400_000).toISOString();
function wallClient(opts: { fail?: string[]; closedReports?: number } = {}) {
  const fail = new Set(opts.fail ?? []);
  const gem = { id: "g1", canonical_place_id: "p1", sensitivity_level: "public", verification_level: "community", status: "active", crowd_level: "low", save_count: 0, visit_count: 0, updated_at: wallRecent, latitude: 1, longitude: 1, approx_latitude: null, approx_longitude: null, image_url: null };
  const rows: Record<string, any[]> = {
    hidden_gems: [gem],
    hidden_gem_verifications: Array.from({ length: 5 }, (_, i) => ({ gem_id: "g1", user_id: `u${i}`, result: "approved", created_at: wallRecent })),
    hidden_gem_visits: [],
    hidden_gem_contributions: Array.from({ length: opts.closedReports ?? 0 }, (_, i) => ({ gem_id: "g1", user_id: `c${i}`, contribution_type: "closed", updated_at: wallRecent })),
  };
  const b = (table: string): any => {
    const answer = (single: boolean) => fail.has(table) ? { data: null, error: ERR } : { data: single ? (rows[table] ?? [])[0] ?? null : rows[table] ?? [], error: null };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return () => p;
    } });
    return p;
  };
  return { from: b };
}
describe("the Wall's gem state over a failed aggregate read (§111, D-W11X2-110)", () => {
  const PLACES = [{ placeId: "p1", name: "Secret Cove" }];
  it("WLc CONTROL: healthy reads → the strip surfaces the confirmed gem; two closed reports → it does not", async () => {
    const ok = await buildGemLiveCandidates(wallClient(), PLACES, { now: WALL_NOW });
    assert.equal(ok.length, 1, JSON.stringify(ok));
    assert.match(String(ok[0].resolved?.label), /recently confirmed/, JSON.stringify(ok));
    assert.deepEqual(await buildGemLiveCandidates(wallClient({ closedReports: 2 }), PLACES, { now: WALL_NOW }), []);
  });
  it("WL1 the contributions read fails on a gem reported closed → never 'recently confirmed'", async () => {
    const out = await buildGemLiveCandidates(wallClient({ closedReports: 2, fail: ["hidden_gem_contributions"] }), PLACES, { now: WALL_NOW });
    assert.deepEqual(out, [], `a failed read dropped the closed reports and the strip said: ${JSON.stringify(out.map((c) => c.resolved?.label))}`);
  });
  it("WL2c CONTROL: the context thread's gem candidate over healthy reads", async () => {
    const cand = await contextThreadInternal.readHiddenGemCandidate(wallClient(), { place: { placeId: "p1", name: "Secret Cove" } } as any, { now: WALL_NOW } as any);
    assert.ok(cand, "a candidate is built over healthy reads");
  });
  it("WL2 the context thread, the verifications read fails → no hidden-gem thread", async () => {
    const cand = await contextThreadInternal.readHiddenGemCandidate(wallClient({ fail: ["hidden_gem_verifications"] }), { place: { placeId: "p1", name: "Secret Cove" } } as any, { now: WALL_NOW } as any);
    assert.equal(cand, null, JSON.stringify(cand));
  });
});
