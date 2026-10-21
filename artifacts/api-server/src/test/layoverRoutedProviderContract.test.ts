/**
 * LAYOVER 165, lane B1-R1 — the Google Routes adapter against CONTRACT FIXTURES.
 *
 * Owner decision 2026-10-18: Google Routes is approved for Layover. Before any
 * layover row can rest on the adapter, the adapter has to read what Google
 * actually sends. The fixtures under `fixtures/googleRoutes/` mirror the
 * documented `routes.googleapis.com/directions/v2:computeRoutes` response
 * (Route → legs → steps; `duration` traffic-aware, `staticDuration` free-flow,
 * both "Ns" strings; `steps[].travelMode`, `navigationInstruction.maneuver`,
 * `transitDetails.stopCount` / `stopDetails.{arrival,departure}Stop.name`;
 * top-level `fallbackInfo.{routingMode,reason}`), restricted to the fields the
 * adapter's X-Goog-FieldMask asks for — which is what a masked response
 * contains. No recorded response existed in the repository (grep for
 * computeRoutes/staticDuration/transitDetails: only in-test literals), so these
 * are built from the reference, read 2026-10-18:
 *   developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes
 *   developers.google.com/maps/documentation/routes/reference/rest/v2/FallbackInfo
 * Real DRIVE responses are turn-by-turn: every step is `travelMode: DRIVE`.
 *
 * WHAT IS PINNED
 *   A. the shape: one leg per CONVEYANCE (a 4-turn drive is one drive, not 3
 *      transfers), the route's traffic-aware total over its free-flow steps,
 *      alternatives counted and reduced to independent routes, a FERRY step and
 *      a 1-stop express are non-interruptible, a TRAFFIC_UNAWARE fallback is
 *      HISTORICAL / LOW and named;
 *   B. the request: POST, the key and the field mask in headers (the two new
 *      mask entries are Essentials-level), TRAFFIC_AWARE + departureTime for
 *      DRIVE only, alternatives asked;
 *   C. every degraded state is a NAMED refusal and never a number: no key, not
 *      enabled, budget exhausted, the layover session's cap spent, HTTP 5xx,
 *      HTTP 429, timeout (and the read's time then spent), a partial body, no
 *      route;
 *   D. R5: a layover scope is charged to the layover gate with its SESSION and
 *      person — never to a trip's D-7 share — and a Trips scope exactly as before;
 *   E. R5(b): identical legs are asked once (concurrent asks share one request;
 *      an answer is reused until it expires; a refusal is never replayed).
 *
 * NO NETWORK: every fetch is an injected double; nothing is sent anywhere.
 *
 * Run: node --import tsx/esm --test src/test/layoverRoutedProviderContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createGoogleRoutesCorridorProvider,
  conveyanceLegs,
  CREDENTIAL_ENV,
  ENABLEMENT_ENV,
} from "../lib/providers/googleRoutesCorridorProvider.js";
import { routeInterruptibility, type CorridorQuery } from "../lib/providers/routeCorridorProvider.js";
import { assessReturnRisk } from "../lib/providers/returnRouteRisk.js";
import { withRoutesRequestBudget, currentRoutesRequestBudget } from "../domain/trips/contracts/RoutesRequestBudget.js";
import type { LayoverRoutesSpendGate, LayoverSpendVerdict } from "../services/airport/layoverRoutesSpendGate.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/googleRoutes/${name}`, import.meta.url), "utf8"));
const LIVE = (n: string) => (n === CREDENTIAL_ENV ? "test-key-not-real" : n === ENABLEMENT_ENV ? "true" : undefined);
const NOW = new Date("2026-10-18T09:00:00.000Z");
const AIRPORT = { lat: 25.0797, lng: 121.2342 };
const PLACE = { lat: 24.9937, lng: 121.3010 };

interface Seen { url: string; init: RequestInit; body: any }
function fetchServing(answer: (body: any) => { status?: number; json?: unknown; throws?: Error; bad?: boolean }) {
  const seen: Seen[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, init, body });
    const a = answer(body);
    if (a.throws) throw a.throws;
    const status = a.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => { if (a.bad) throw new SyntaxError("Unexpected token"); return a.json; },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
}
function gates(verdict: string = "granted") {
  const trip = { calls: [] as unknown[], async decide(s: any) { trip.calls.push(s); return verdict as any; } };
  const layover: LayoverRoutesSpendGate & { calls: unknown[] } = {
    calls: [] as unknown[],
    async decide(s) { layover.calls.push(s); return verdict as LayoverSpendVerdict; },
  };
  return { trip, layover };
}
const Q: CorridorQuery = { from: PLACE, to: AIRPORT, departAt: new Date(NOW.getTime() + 3 * 3_600_000), mode: "drive", wantAlternatives: true };
const inLayover = <T>(fn: () => Promise<T>) => withRoutesRequestBudget({ userId: "user-1", layoverSessionId: "session-1" }, fn);

describe("A. the response SHAPE, read from documented fixtures", () => {
  it("A1. three DRIVE alternatives, turn-by-turn: one drive leg each, 0 transfers, 3 independent, sorted best-first, traffic-aware total", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const g = gates();
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: g.layover });
    const r = await inLayover(() => p.corridor(Q));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.deepEqual(r.value.routes.map((x) => x.totalMinutes), [33, 37, 40], "the route's own traffic-aware `duration`, best first");
    for (const route of r.value.routes) {
      assert.equal(route.legs.length, 1, "four DRIVE turns are ONE conveyance");
      assert.equal(route.transferCount, 0, "a taxi ride is not a change of vehicle per turn (the defect conveyanceLegs closes)");
      assert.equal(routeInterruptibility(route.legs), "interruptible");
    }
    assert.equal(r.value.routes[0]!.legs[0]!.minutes, 19, "the free-flow leg is the steps' summed staticDuration (1085 s), ceiled ONCE");
    assert.equal(r.value.independentRouteCount, 3);
    assert.equal(r.value.sourceClass, "LIVE", "DRIVE + TRAFFIC_AWARE, no fallback: a forecast for the instant asked");
    const risk = assessReturnRisk(r.value, NOW.getTime());
    assert.equal(risk?.returnRouteUnreliable, false, "three independent, interruptible ways back with a narrow spread are not unreliable");
    assert.equal(risk?.fragileCorridor, false);
  });

  it("A2. the per-step reading (the pre-fix behaviour) would have called the same drive 3 transfers — pinned so the fix cannot regress", () => {
    const steps = (fixture("drive-alternatives-return.json") as any).routes[0].legs[0].steps;
    const merged = conveyanceLegs(steps, () => { throw new Error("no TRANSIT step here"); });
    assert.equal(merged.length, 1);
    assert.equal(steps.length, 4, "the fixture really is turn-by-turn");
  });

  it("A3. a FERRY maneuver inside a DRIVE route makes that way back non-interruptible (L70)", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-ferry-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: gates().layover });
    const r = await inLayover(() => p.corridor(Q));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(routeInterruptibility(r.value.routes[0]!.legs), "committed", "the ferry route is committed");
    assert.equal(routeInterruptibility(r.value.routes[1]!.legs), "interruptible", "the all-road alternative is not");
  });

  it("A4. TRANSIT: a 1-stop express is committed, the change is one transfer, two routes through one interchange are ONE independent way back → RETURN_ROUTE_UNRELIABLE", async () => {
    const f = fetchServing(() => ({ json: fixture("transit-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: gates().layover });
    const r = await inLayover(() => p.corridor({ ...Q, mode: "transit" }));
    assert.ok(r.ok);
    if (!r.ok) return;
    const best = r.value.routes[0]!;
    assert.deepEqual(best.legs.map((l) => l.mode), ["walk", "transit", "walk", "transit", "walk"], "consecutive WALK steps are one walk");
    assert.equal(best.transferCount, 1);
    assert.equal(best.legs[1]!.interruptibility, "committed", "stopCount 1: a non-stop hop");
    assert.equal(r.value.independentRouteCount, 1, "both routes change at Taoyuan HSR Station");
    assert.equal(r.value.sourceClass, "HISTORICAL", "a timetable, not a traffic measurement");
    const risk = assessReturnRisk(r.value, NOW.getTime());
    assert.equal(risk?.returnRouteUnreliable, true, "fragile AND committed — the real signal behind RETURN_ROUTE_UNRELIABLE (L282)");
    assert.ok(risk?.contributingFactors.includes("no_independent_alternative_route"));
  });

  it("A5. a TRAFFIC_UNAWARE fallback is HISTORICAL / LOW and names itself; it is never presented as the traffic at the instant asked", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-fallback-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: gates().layover });
    const r = await inLayover(() => p.corridor(Q));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.sourceClass, "HISTORICAL");
    assert.equal(r.value.confidence, "LOW");
    assert.ok(r.value.sourceRefs.includes("google:routes.v2:fallback:FALLBACK_TRAFFIC_UNAWARE:LATENCY_EXCEEDED"), r.value.sourceRefs.join(" "));
  });

  it("A6. WALK: several walking steps are one walk, no transfer", async () => {
    const f = fetchServing(() => ({ json: fixture("walk.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: gates().layover });
    const r = await inLayover(() => p.corridor({ ...Q, mode: "walk" }));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.routes[0]!.legs.length, 1);
    assert.equal(r.value.routes[0]!.legs[0]!.mode, "walk");
    assert.equal(r.value.routes[0]!.totalMinutes, 9);
  });
});

describe("B. the REQUEST Google receives", () => {
  it("B1. POST to computeRoutes with the key and the field mask in headers; DRIVE asks TRAFFIC_AWARE at the departure instant, with alternatives", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: gates().layover });
    await inLayover(() => p.corridor(Q));
    const s = f.seen[0]!;
    assert.equal(s.url, "https://routes.googleapis.com/directions/v2:computeRoutes");
    assert.equal(s.init.method, "POST");
    const h = s.init.headers as Record<string, string>;
    assert.equal(h["X-Goog-Api-Key"], "test-key-not-real");
    for (const field of ["routes.duration", "routes.staticDuration", "routes.legs.steps.travelMode", "routes.legs.steps.staticDuration",
      "routes.legs.steps.transitDetails.stopCount", "routes.legs.steps.navigationInstruction.maneuver", "fallbackInfo"]) {
      assert.ok(h["X-Goog-FieldMask"]!.split(",").includes(field), `field mask lacks ${field}`);
    }
    assert.ok(!/speedReadingIntervals|tollInfo/.test(h["X-Goog-FieldMask"]!) && s.body.extraComputations === undefined, "no Enterprise-SKU field (traffic on polylines, toll calculation) is asked for"); // Enterprise triggers per Google's SKU details (read 2026-10-20): two-wheeled, toll calculation, traffic information on polylines, large vehicle. The BASIC routes.polyline.geoJsonLinestring is none of them; it is requested since ee52da82 for L270's Google-map-only route display (layoverMapGeometry.test.ts), so the old blanket "no polyline" no longer stood for this rule
    assert.equal(s.body.travelMode, "DRIVE");
    assert.equal(s.body.routingPreference, "TRAFFIC_AWARE");
    assert.equal(s.body.departureTime, Q.departAt.toISOString(), "priced at the instant asked — the return instant, not now");
    assert.equal(s.body.computeAlternativeRoutes, true);
    assert.deepEqual(s.body.origin, { location: { latLng: { latitude: PLACE.lat, longitude: PLACE.lng } } });
  });

  it("B2. WALK sends no routing preference and no departure time (a walk takes what it takes)", async () => {
    const f = fetchServing(() => ({ json: fixture("walk.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: gates().layover });
    await inLayover(() => p.corridor({ ...Q, mode: "walk" }));
    assert.equal(f.seen[0]!.body.travelMode, "WALK");
    assert.equal(f.seen[0]!.body.routingPreference, undefined);
    assert.equal(f.seen[0]!.body.departureTime, undefined);
  });
});

describe("C. every degraded state is a NAMED refusal, never a figure", () => {
  const run = async (opts: { env?: (n: string) => string | undefined; verdict?: string; answer?: Parameters<typeof fetchServing>[0] }) => {
    const f = fetchServing(opts.answer ?? (() => ({ json: fixture("drive-alternatives-return.json") })));
    const g = gates(opts.verdict);
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: opts.env ?? LIVE, now: () => NOW, layoverSpendGate: g.layover, spendGate: g.trip });
    const r = await inLayover(() => p.corridor(Q));
    return { r, f, g };
  };
  it("C1. no key → CREDENTIAL_ABSENT, nothing fetched, nothing charged", async () => {
    const { r, f, g } = await run({ env: (n) => (n === ENABLEMENT_ENV ? "true" : undefined) });
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, "CREDENTIAL_ABSENT");
    assert.equal(f.seen.length, 0); assert.equal(g.layover.calls.length, 0);
  });
  it("C2. not enabled → PROVIDER_NOT_ENABLED, asked first, nothing fetched", async () => {
    const { r, f } = await run({ env: (n) => (n === CREDENTIAL_ENV ? "k" : undefined) });
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, "PROVIDER_NOT_ENABLED");
    assert.equal(f.seen.length, 0);
  });
  for (const verdict of ["budget_exhausted", "quota_exhausted", "session_share_exhausted", "user_share_exhausted", "off", "unavailable", "unscoped"]) {
    it(`C3. the layover gate answers ${verdict} → PROVIDER_REJECTED naming it, Google never asked`, async () => {
      const { r, f } = await run({ verdict });
      assert.equal(r.ok, false); if (!r.ok) { assert.equal(r.reason, "PROVIDER_REJECTED"); assert.match(r.detail, new RegExp(`layover ${verdict}`)); }
      assert.equal(f.seen.length, 0);
    });
  }
  it("C4. HTTP 503 → PROVIDER_UNAVAILABLE", async () => {
    const { r } = await run({ answer: () => ({ status: 503, json: {} }) });
    assert.equal(r.ok, false); if (!r.ok) { assert.equal(r.reason, "PROVIDER_UNAVAILABLE"); assert.match(r.detail, /HTTP 503/); }
  });
  it("C5. HTTP 429 → PROVIDER_REJECTED (quota)", async () => {
    const { r } = await run({ answer: () => ({ status: 429, json: {} }) });
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, "PROVIDER_REJECTED");
  });
  it("C6. a timeout → PROVIDER_UNAVAILABLE naming it; when the READ's time is gone, the next call is refused before Google", async () => {
    const f = fetchServing(() => ({ throws: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: gates().layover });
    const out = await withRoutesRequestBudget({ userId: "user-1", layoverSessionId: "session-1" }, async () => {
      const first = await p.corridor(Q);
      const b = currentRoutesRequestBudget()!;
      (b.counter as { startedAt: number }).startedAt = Date.now() - b.budgetMs; // the read's 8 s have gone
      const second = await p.corridor({ ...Q, from: AIRPORT, to: PLACE });
      return { first, second };
    });
    assert.equal(out.first.ok, false); if (!out.first.ok) { assert.equal(out.first.reason, "PROVIDER_UNAVAILABLE"); assert.match(out.first.detail, /TimeoutError/); }
    assert.equal(out.second.ok, false); if (!out.second.ok) assert.match(out.second.detail, /request_time_budget/);
    assert.equal(f.seen.length, 1, "the second leg was never asked of Google");
  });
  it("C7. a partial body (no readable duration) → PROVIDER_MALFORMED; no route → PROVIDER_UNAVAILABLE; not JSON → PROVIDER_MALFORMED", async () => {
    const a = await run({ answer: () => ({ json: fixture("partial-no-duration.json") }) });
    assert.equal(a.r.ok, false); if (!a.r.ok) assert.equal(a.r.reason, "PROVIDER_MALFORMED");
    const b = await run({ answer: () => ({ json: fixture("no-route.json") }) });
    assert.equal(b.r.ok, false); if (!b.r.ok) assert.equal(b.r.reason, "PROVIDER_UNAVAILABLE");
    const c = await run({ answer: () => ({ bad: true }) });
    assert.equal(c.r.ok, false); if (!c.r.ok) assert.equal(c.r.reason, "PROVIDER_MALFORMED");
  });
});

describe("D. R5 — who a call is charged to", () => {
  it("D1. a layover scope is charged to the layover gate with the SESSION and the person; the Trips gate is never asked, even with a trip on the read", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const g = gates();
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: g.layover, spendGate: g.trip });
    const r = await withRoutesRequestBudget({ userId: "user-1", tripId: "trip-9" }, () =>
      withRoutesRequestBudget({ userId: "user-1", layoverSessionId: "session-1" }, () => p.corridor(Q)));
    assert.ok(r.ok);
    assert.deepEqual(g.layover.calls, [{ userId: "user-1", layoverSessionId: "session-1" }]);
    assert.deepEqual(g.trip.calls, [], "R5(b): a layover call is not charged to the trip's D-7 share");
  });
  it("D2. a Trips scope is charged exactly as before: the trip gate, person and trip", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const g = gates();
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: g.layover, spendGate: g.trip });
    const r = await withRoutesRequestBudget({ userId: "user-1", tripId: "trip-9" }, () => p.corridor(Q));
    assert.ok(r.ok);
    assert.deepEqual(g.trip.calls, [{ userId: "user-1", tripId: "trip-9" }]);
    assert.deepEqual(g.layover.calls, []);
  });
  it("D3. no session and no trip → unscoped refusal before any gate", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const g = gates();
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => NOW, layoverSpendGate: g.layover, spendGate: g.trip });
    const r = await withRoutesRequestBudget({ userId: "user-1" }, () => p.corridor(Q));
    assert.equal(r.ok, false); if (!r.ok) assert.match(r.detail, /unscoped/);
    assert.deepEqual(g.layover.calls, []); assert.deepEqual(g.trip.calls, []); assert.equal(f.seen.length, 0);
  });
});

describe("E. R5(b) — identical legs are asked once", () => {
  it("E1. concurrent identical asks share ONE request and ONE charge; a different bucket is a new request", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const g = gates();
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => new Date(), layoverSpendGate: g.layover, memo: true });
    const rs = await inLayover(() => Promise.all([p.corridor(Q), p.corridor(Q), p.corridor({ ...Q, mode: undefined })]));
    assert.ok(rs.every((r) => r.ok));
    assert.equal(f.seen.length, 1, "an unspecified mode is asked as DRIVE and shares DRIVE's entry");
    assert.equal(g.layover.calls.length, 1);
    await inLayover(() => p.corridor({ ...Q, departAt: new Date(Q.departAt.getTime() + 10 * 60_000) }));
    assert.equal(f.seen.length, 2, "ten minutes later is another bucket and another question");
  });
  it("E2. a refusal is never replayed: the next ask goes back to Google", async () => {
    let n = 0;
    const f = fetchServing(() => (++n === 1 ? { status: 503, json: {} } : { json: fixture("drive-alternatives-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => new Date(), layoverSpendGate: gates().layover, memo: true });
    const a = await inLayover(() => p.corridor(Q));
    const b = await inLayover(() => p.corridor(Q));
    assert.equal(a.ok, false);
    assert.equal(b.ok, true);
    assert.equal(f.seen.length, 2);
  });
  it("E3. an answer is not reused past its own expiry", async () => {
    let clock = Date.parse("2026-10-18T09:00:00.000Z");
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => new Date(clock), layoverSpendGate: gates().layover, memo: true });
    await inLayover(() => p.corridor(Q));
    clock += 4 * 60_000; await inLayover(() => p.corridor(Q));
    assert.equal(f.seen.length, 1, "inside its five minutes it is reused");
    clock += 2 * 60_000; await inLayover(() => p.corridor(Q));
    assert.equal(f.seen.length, 2, "past them it is asked again");
  });
  it("E5. a remembered answer is NOT served once the deployment turns Routes off: the provider's own gates are asked before the memo", async () => {
    let enabled = true;
    const env = (n: string) => (n === CREDENTIAL_ENV ? "k" : n === ENABLEMENT_ENV ? (enabled ? "true" : undefined) : undefined);
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: env, now: () => new Date(), layoverSpendGate: gates().layover, memo: true });
    assert.equal((await inLayover(() => p.corridor(Q))).ok, true);
    enabled = false;
    const r = await inLayover(() => p.corridor(Q));
    assert.equal(r.ok, false, "the memo served a route after Routes was switched off");
    if (!r.ok) assert.equal(r.reason, "PROVIDER_NOT_ENABLED");
    assert.equal(f.seen.length, 1);
  });
  it("E4. the production singleton has the memo; a provider built elsewhere asks per call unless it opts in", async () => {
    const f = fetchServing(() => ({ json: fixture("drive-alternatives-return.json") }));
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: f.impl, readEnv: LIVE, now: () => new Date(), layoverSpendGate: gates().layover });
    await inLayover(() => Promise.all([p.corridor(Q), p.corridor(Q)]));
    assert.equal(f.seen.length, 2);
    const src = readFileSync(new URL("../lib/providers/googleRoutesCorridorProvider.ts", import.meta.url), "utf8");
    assert.match(src, /export const googleRoutesCorridorProvider: RouteCorridorProvider =\n\s+createGoogleRoutesCorridorProvider\(\{ memo: true \}\)/);
  });
});
