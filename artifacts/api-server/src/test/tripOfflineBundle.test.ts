/**
 * Trips spec §18.1 — the signed / versioned offline bundle (census-trips
 * TR334) and "stale / live-unavailable must be visible" on the wire (TR342).
 *
 * Run: node --import tsx/esm --test src/test/tripOfflineBundle.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildOfflineBundle, bundleSigningSecret, bundleStaleness, canonicalBundleJson, signOfflineBundle, verifyOfflineBundle,
  OFFLINE_BUNDLE_SCHEMA_VERSION, OFFLINE_BUNDLE_TTL_MS,
} from "../domain/trips/services/TripOfflineBundle.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const T = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const SECRET = "a-secret-long-enough-for-hmac-0001";
const input = {
  tripId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", sourceTripVersion: 12,
  commitments: [
    { id: "c-late", type: "train", title: "Train to Porto", startsAt: T(30), requiredArrivalAt: T(30), placeName: "Santa Apolónia" },
    { id: "c-soon", type: "dinner", title: "Dinner", startsAt: T(3), requiredArrivalAt: null, placeName: "Rua Augusta 10" },
    { id: "c-past", type: "flight", title: "Arrival", startsAt: T(-5), requiredArrivalAt: T(-5), placeName: "LIS" },
  ],
  plans: [
    { id: "p-now", title: "Museum", status: "in_progress", dayDate: "2026-09-13", startsAt: T(-1), endsAt: T(1), locationName: "MAAT" },
    { id: "p-next", title: "Walk", status: "confirmed", dayDate: "2026-09-13", startsAt: T(2), endsAt: T(3), locationName: "Belém" },
    { id: "p-gone", title: "Cancelled", status: "cancelled", dayDate: "2026-09-13", startsAt: T(4), endsAt: T(5), locationName: null },
  ],
  reservations: [{ id: "r1", title: "Hotel Aurora", locationName: "Av. da Liberdade 1", startsAt: T(-20) }],
};

describe("TR334 — the bundle", () => {
  it("carries the next commitments in order, the active plan, the plans, the critical addresses and the certified context", () => {
    const b = buildOfflineBundle(input, NOW);
    assert.equal(b.bundleSchemaVersion, OFFLINE_BUNDLE_SCHEMA_VERSION); assert.equal(b.sourceTripVersion, 12);
    assert.deepEqual(b.contents.nextCommitments.map((c) => c.id), ["c-soon", "c-late"], "past commitments are not next");
    assert.equal(b.contents.activePlan?.id, "p-now", "the in-progress plan is the active one");
    assert.deepEqual(b.contents.plans.map((p) => p.id), ["p-now", "p-next"], "a cancelled plan is not carried");
    assert.deepEqual(b.contents.criticalAddresses.map((a) => `${a.kind}:${a.id}`), ["reservation:r1", "commitment:c-soon", "commitment:c-late", "plan:p-next"]);
    assert.equal(b.contents.certifiedContext.sourceTripVersion, 12);
    assert.equal(b.expiresAt, new Date(NOW + OFFLINE_BUNDLE_TTL_MS).toISOString());
    assert.equal(b.contents.selectedRoute, null); assert.deepEqual(b.contents.meetingPoints, []);
    assert.match(b.notCarried.mapTiles, /permission/);
  });
  it("with no in-progress plan the next confirmed one is active; with none, null", () => {
    const b = buildOfflineBundle({ ...input, plans: input.plans.filter((p) => p.id !== "p-now") }, NOW);
    assert.equal(b.contents.activePlan?.id, "p-next");
    assert.equal(buildOfflineBundle({ ...input, plans: [] }, NOW).contents.activePlan, null);
  });
});

// §63 (census-trips TR337, TR341): §18.1 names seven contents, and two of them
// — "selected route" and "the most recent certified context" — had nothing to
// carry until §62 gave the trip a route chain and §40.3 the freedom windows.
describe("TR337 / TR341 — the selected route and the certified context", () => {
  const route = {
    decisionId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", partySize: 2, disclosure: "straight-line bound, static band",
    stops: [
      { planItemId: "p-now", title: "Museum", startsAt: T(-1), endsAt: T(1), locationName: "MAAT" },
      { planItemId: "p-next", title: "Walk", startsAt: T(2), endsAt: T(3), locationName: "Belém" },
    ],
    hops: [{
      from: "p-now", to: "p-next", departAt: T(1),
      boundMinutes: 18, expectedMinutes: 24, unknownReason: null,
      arrivalAtBound: T(1.3), expectedArrivalAt: T(1.4), band: "SHOULDER",
    }],
    unplaced: [{ planItemId: "p-loose", reason: "NO_TIME" }],
  };
  const windows = [
    { id: "w1", beginsAt: T(3), endsAt: T(6), durationMinutes: 180, certified: false, confidence: "MEDIUM", participants: ["u1", "u2"], afterCommitmentId: "c-soon", beforeCommitmentId: "c-late", reservedMinutes: 25 },
  ];

  it("carries the route chain as the selected route, and notCarried says what it is instead of why it is missing", () => {
    const b = buildOfflineBundle({ ...input, selectedRoute: route, routeReading: "unused" }, NOW);
    assert.equal(b.contents.selectedRoute?.decisionId, route.decisionId);
    assert.deepEqual(b.contents.selectedRoute?.stops.map((st) => st.planItemId), ["p-now", "p-next"]);
    assert.equal(b.contents.selectedRoute?.hops[0]?.boundMinutes, 18);
    assert.equal(b.contents.selectedRoute?.hops[0]?.expectedArrivalAt, T(1.4));
    assert.deepEqual(b.contents.selectedRoute?.unplaced, [{ planItemId: "p-loose", reason: "NO_TIME" }]);
    assert.match(b.notCarried.selectedRoute, /carried/);
    assert.match(b.notCarried.selectedRoute, /2 placed plan item\(s\)/);
    assert.match(b.notCarried.selectedRoute, /1 hop\(s\)/);
    assert.match(b.notCarried.selectedRoute, /TR437/, "a route_plans row is still not a trip's route");
  });

  it("carries the §7.3 windows as the certified context, counting the certified ones, with the decision they were read as", () => {
    const b = buildOfflineBundle({ ...input, freeWindows: windows, windowsDecisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1", windowsReading: "provider straight-line (not routed)" }, NOW);
    const ctx = b.contents.certifiedContext;
    assert.equal(ctx.freeWindows?.length, 1);
    assert.equal(ctx.freeWindows?.[0]?.id, "w1");
    assert.equal(ctx.freeWindows?.[0]?.certified, false);
    assert.equal(ctx.windowsDecisionId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1");
    assert.match(ctx.windowsReading, /1 §7\.3 window\(s\)/);
    assert.match(ctx.windowsReading, /0 certified/, "no routed provider, so nothing is certified (TR128)");
    assert.match(ctx.windowsReading, /not routed/);
    assert.equal(ctx.sourceTripVersion, 12, "the context is the version it was read at");
  });

  it("neither is refused when it could not be read: the bundle still carries the plan, and says why each is absent", () => {
    const b = buildOfflineBundle({ ...input, selectedRoute: null, routeReading: "the route chain could not be read (TRIP_PROJECTION_UNAVAILABLE): the plan could not be read", freeWindows: null, windowsReading: "trip_operational_projections_enabled is off: not read for this bundle" }, NOW);
    assert.equal(b.contents.selectedRoute, null);
    assert.equal(b.contents.certifiedContext.freeWindows, null);
    assert.equal(b.contents.certifiedContext.windowsDecisionId, null);
    assert.match(b.notCarried.selectedRoute, /could not be read/);
    assert.match(b.contents.certifiedContext.windowsReading, /is off/);
    assert.equal(b.contents.plans.length, 2, "the plan still travels");
    assert.ok(b.contents.criticalAddresses.length > 0, "the addresses still travel");
  });

  it("the signature covers them: a route hop edited after signing does not verify", () => {
    const b = buildOfflineBundle({ ...input, selectedRoute: route, freeWindows: windows }, NOW);
    const signed = signOfflineBundle(b, SECRET);
    assert.equal(verifyOfflineBundle(signed.bundle, signed.signature, SECRET), true);
    const tampered = JSON.parse(JSON.stringify(b)) as typeof b;
    tampered.contents.selectedRoute!.hops[0]!.boundMinutes = 1;
    assert.equal(verifyOfflineBundle(tampered, signed.signature, SECRET), false);
  });
});

describe("TR334 — signed", () => {
  it("the same bundle always has the same bytes, whatever the key order", () => {
    assert.equal(canonicalBundleJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalBundleJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
  it("a bundle this server signed verifies; an edited one does not; a wrong secret does not", () => {
    const b = buildOfflineBundle(input, NOW);
    const s = signOfflineBundle(b, SECRET);
    assert.equal(s.algorithm, "hmac-sha256"); assert.match(s.signature, /^[0-9a-f]{64}$/);
    assert.equal(verifyOfflineBundle(b, s.signature, SECRET), true);
    const edited = { ...b, contents: { ...b.contents, criticalAddresses: b.contents.criticalAddresses.map((a) => ({ ...a, address: "somewhere else" })) } };
    assert.equal(verifyOfflineBundle(edited, s.signature, SECRET), false, "a moved address fails verification");
    assert.equal(verifyOfflineBundle({ ...b, sourceTripVersion: 99 }, s.signature, SECRET), false, "a forged version fails verification");
    assert.equal(verifyOfflineBundle(b, s.signature, "another-secret-long-enough-0002"), false);
    assert.equal(verifyOfflineBundle(b, "zz", SECRET), false, "a malformed signature is false, not a throw");
  });
  it("the secret comes from TRIP_OFFLINE_BUNDLE_SECRET, else SESSION_SECRET, else nothing — never a default", () => {
    assert.equal(bundleSigningSecret({ TRIP_OFFLINE_BUNDLE_SECRET: SECRET } as any), SECRET);
    assert.equal(bundleSigningSecret({ SESSION_SECRET: SECRET } as any), SECRET);
    assert.equal(bundleSigningSecret({} as any), null);
    assert.equal(bundleSigningSecret({ SESSION_SECRET: "short" } as any), null);
  });
});

describe("TR342 — stale is visible", () => {
  it("current: not stale, and the detail says until when", () => {
    const st = bundleStaleness(buildOfflineBundle(input, NOW), NOW + 3_600_000, 12);
    assert.equal(st.stale, false); assert.equal(st.reasonCode, null); assert.match(st.detail, /valid until/);
  });
  it("expired: TRIP_OFFLINE_BUNDLE_STALE, because expired", () => {
    const st = bundleStaleness(buildOfflineBundle(input, NOW), NOW + OFFLINE_BUNDLE_TTL_MS + 1, 12);
    assert.equal(st.stale, true); assert.equal(st.reasonCode, "TRIP_OFFLINE_BUNDLE_STALE"); assert.equal(st.because, "expired");
  });
  it("the trip moved on: TRIP_OFFLINE_BUNDLE_STALE, because version_behind, naming both versions", () => {
    const st = bundleStaleness(buildOfflineBundle(input, NOW), NOW + 1000, 13);
    assert.equal(st.stale, true); assert.equal(st.because, "version_behind"); assert.match(st.detail, /version 12 and the trip is at 13/);
  });
  it("an unknown current version cannot make it stale by version — only by time", () => {
    assert.equal(bundleStaleness(buildOfflineBundle(input, NOW), NOW + 1000, null).stale, false);
  });
});
