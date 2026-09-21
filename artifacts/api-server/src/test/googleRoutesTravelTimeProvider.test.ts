/**
 * Tests for the prepared (NOT wired) Google Routes API adapter.
 *
 * The point of most of these is not that the happy path works — it is that
 * every failure shape comes back as a DISTINCT typed unknown rather than as a
 * number. §7's whole argument rests on absence never being read as zero, and on
 * a non-routed value never being stamped as routed.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isRoutedSourceClass } from "../lib/travelEstimate.js";
import {
  ROUTED_ESTIMATE_TTL_MS,
  cacheKeyFor,
  createGoogleRoutesTravelTimeProvider,
} from "../domain/trips/contracts/GoogleRoutesTravelTimeProvider.js";

const FROM = { lat: 14.5995, lng: 120.9842 }; // Manila
const TO = { lat: 14.5176, lng: 121.0509 };   // Taguig, ~10 km
const DEPART = new Date("2026-10-01T09:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerWith(fetchImpl: typeof fetch, apiKey: string | undefined = "test-key") {
  return createGoogleRoutesTravelTimeProvider({
    fetchImpl,
    apiKey,
    now: () => new Date("2026-10-01T08:00:00.000Z"),
  });
}

describe("GoogleRoutesTravelTimeProvider", () => {
  it("declares routed:true — the flag the departure-band wrapper keys on", () => {
    // If this ever became false, TripDepartureAssumptions would stack a static
    // PEAK multiplier on top of a live traffic-aware route and double-count
    // congestion. census-trips records that exact hazard.
    const p = providerWith(async () => jsonResponse({}));
    assert.equal(p.routed, true);
    assert.equal(p.id, "google-routes-v2");
  });

  it("is not wired into any consumer", async () => {
    // The whole file is prepared-not-wired. If someone imports it into a seam,
    // this test should be updated deliberately, as part of that decision.
    const { readFileSync } = await import("node:fs");
    for (const seam of [
      "src/routes/tripFeasibility.ts",
      "src/domain/trips/projections/TripFreedomProjection.ts",
      "src/domain/trips/projections/TripRouteChainProjection.ts",
      "src/services/airport/LayoverTravelTime.ts",
    ]) {
      const src = readFileSync(new URL(`../../${seam}`, import.meta.url), "utf8");
      assert.ok(
        !src.includes("GoogleRoutesTravelTimeProvider"),
        `${seam} imports the Google Routes adapter — wiring it is an owner decision with a per-call cost`,
      );
    }
  });

  it("missing coordinates is NO_COORDINATES, not a zero", async () => {
    const p = providerWith(async () => jsonResponse({}));
    const r = await p.estimate({ from: null, to: TO, departAt: DEPART });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "NO_COORDINATES");
  });

  it("no API key degrades to NO_ROUTED_PROVIDER, exactly like today's deployment", async () => {
    let called = false;
    // Built directly rather than through providerWith: that helper's default
    // parameter would swallow an explicit `undefined` and hand back "test-key",
    // which is how this test first passed a key while claiming to pass none.
    const p = createGoogleRoutesTravelTimeProvider({
      fetchImpl: async () => { called = true; return jsonResponse({}); },
      apiKey: undefined,
      now: () => new Date("2026-10-01T08:00:00.000Z"),
    });
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "NO_ROUTED_PROVIDER");
    assert.equal(called, false, "must not spend a billable call without a key");
  });

  it("an HTTP failure is PROVIDER_UNAVAILABLE", async () => {
    const p = providerWith(async () => new Response("nope", { status: 500 }));
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") {
      assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
      assert.match(r.detail ?? "", /HTTP 500/);
    }
  });

  it("a thrown fetch (timeout, DNS) is PROVIDER_UNAVAILABLE, never an exception", async () => {
    const p = providerWith(async () => { throw new Error("boom"); });
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
  });

  it("a non-JSON body is PROVIDER_MALFORMED", async () => {
    const p = providerWith(async () => new Response("<html>", { status: 200 }));
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "PROVIDER_MALFORMED");
  });

  it("a 200 with no route is an absence, not a zero-minute journey", async () => {
    const p = providerWith(async () => jsonResponse({ routes: [] }));
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
  });

  it("an unreadable duration is PROVIDER_MALFORMED", async () => {
    const p = providerWith(async () => jsonResponse({ routes: [{ duration: "soon" }] }));
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "PROVIDER_MALFORMED");
  });

  it("a routed answer is stamped routed, dated, and carries no assumption", async () => {
    const p = providerWith(async () => jsonResponse({ routes: [{ duration: "1500s" }] }));
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART, mode: "drive" });
    assert.equal(r.kind, "estimate");
    if (r.kind !== "estimate") return;
    assert.equal(r.estimate.minutes, 25);
    assert.equal(r.estimate.sourceClass, "LIVE");
    assert.ok(isRoutedSourceClass(r.estimate.sourceClass));
    assert.equal(r.estimate.fallbackLevel, 0);
    // A routed provider answered for the departure it was given — nothing to assume.
    assert.equal(r.assumption, null);
    // It must expire: a traffic-aware number is about a moment.
    assert.ok(r.estimate.expiresAt, "a traffic-aware estimate must expire");
    const ttl = Date.parse(r.estimate.expiresAt!) - Date.parse(r.estimate.observedAt!);
    assert.equal(ttl, ROUTED_ESTIMATE_TTL_MS);
  });

  it("honours departAt — the whole of the future-time requirement", async () => {
    let sent: any = null;
    const p = providerWith(async (_u, init: any) => {
      sent = JSON.parse(String(init.body));
      return jsonResponse({ routes: [{ duration: "600s" }] });
    });
    await p.estimate({ from: FROM, to: TO, departAt: DEPART, mode: "drive" });
    assert.equal(sent.departureTime, DEPART.toISOString());
    assert.equal(sent.routingPreference, "TRAFFIC_AWARE");
  });

  it("never asks for a departure in the past (Routes API rejects it)", async () => {
    let sent: any = null;
    const p = providerWith(async (_u, init: any) => {
      sent = JSON.parse(String(init.body));
      return jsonResponse({ routes: [{ duration: "600s" }] });
    });
    // now() is pinned to 08:00; ask for 06:00.
    await p.estimate({ from: FROM, to: TO, departAt: new Date("2026-10-01T06:00:00.000Z"), mode: "drive" });
    assert.ok(Date.parse(sent.departureTime) >= Date.parse("2026-10-01T08:00:00.000Z"));
  });

  it("keeps the lower bound: a short hop where walking beats driving is NOT stamped routed", async () => {
    // ~300 m apart. A drive answer of 9 minutes is not a lower bound when the
    // straight-line walk is ~4. The smaller wins AND the stamp becomes
    // STATIC_DEFAULT, because the binding term did not come from a route.
    const near = { lat: 14.5995, lng: 120.9842 };
    const alsoNear = { lat: 14.6022, lng: 120.9842 };
    const p = providerWith(async () => jsonResponse({ routes: [{ duration: "540s" }] }));
    const r = await p.estimate({ from: near, to: alsoNear, departAt: DEPART });
    assert.equal(r.kind, "estimate");
    if (r.kind !== "estimate") return;
    assert.ok(r.estimate.minutes < 9, "the walk bound should bind on a 300 m hop");
    assert.equal(r.estimate.sourceClass, "STATIC_DEFAULT");
    assert.equal(
      isRoutedSourceClass(r.estimate.sourceClass), false,
      "a great-circle number must never be stamped as a route",
    );
  });

  it("a long hop with no mode keeps the routed answer", async () => {
    const p = providerWith(async () => jsonResponse({ routes: [{ duration: "1500s" }] }));
    const r = await p.estimate({ from: FROM, to: TO, departAt: DEPART });
    assert.equal(r.kind, "estimate");
    if (r.kind !== "estimate") return;
    assert.equal(r.estimate.sourceClass, "LIVE");
  });

  it("cacheKeyFor is route-shaped and buckets the departure", () => {
    const a = cacheKeyFor({ from: FROM, to: TO, departAt: DEPART, mode: "drive" });
    const b = cacheKeyFor({
      from: FROM, to: TO, mode: "drive",
      departAt: new Date(DEPART.getTime() + 60_000),
    });
    const c = cacheKeyFor({
      from: FROM, to: TO, mode: "drive",
      departAt: new Date(DEPART.getTime() + 2 * ROUTED_ESTIMATE_TTL_MS),
    });
    assert.equal(a, b, "a minute apart is the same traffic bucket");
    assert.notEqual(a, c, "two buckets later is a different question");
    assert.equal(cacheKeyFor({ from: null, to: TO, departAt: DEPART }), null);
    // Reversing the journey is a different key.
    assert.notEqual(a, cacheKeyFor({ from: TO, to: FROM, departAt: DEPART, mode: "drive" }));
  });
});
