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
} from "../services/trips/TripOfflineBundle.js";

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
