/**
 * Layover §16: offline, battery and degraded-mode.
 *
 * node:test + node:assert/strict. Pure functions over a certified feasibility
 * record — no HTTP, no database. The verdict is the EXIT CODE.
 *
 * ── WHAT THE CENSUS SAYS IS MISSING, AND WHICH HALF IS SERVER-SIDE ──────────
 * L150: the return deadline is persisted server-side, "but nothing is cached
 * for DISPLAY … and there is no SNAPSHOT TIMESTAMP to persist." The cache is
 * client work and the client is not in this repository; the snapshot timestamp
 * is server work and is what this suite pins. L156: offline, the screen
 * "renders a generic failure with no distinction between 'removed' and
 * 'offline'". `localReplan` is the distinction, made explicit and refusable.
 *
 * ── TRAPS AVOIDED ───────────────────────────────────────────────────────────
 * A bundle that reports `stale: true` for everything would satisfy every
 * staleness test, so each one is paired with a fresh control at a nearby
 * instant. `localReplan` returning `allowed: false` for everything would
 * satisfy every refusal test, so the permitted case is asserted first and each
 * refusal differs from it in exactly one input.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverDegradedOffline.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import {
  buildOfflineBundle,
  bundleFreshness,
  localReplan,
  sensingPolicy,
  OFFLINE_BUNDLE_TTL_MIN,
  LAYOVER_OFFLINE_BUNDLE_VERSION,
} from "../services/airport/LayoverDegradedService.js";
import { RETURN_SOON_LEAD_MIN } from "../services/airport/LayoverSafetyEngine.js";

const NOW = Date.UTC(2026, 8, 8, 6, 0, 0);

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taiwan Taoyuan International Airport",
  city: "Taoyuan", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei",
  lat: 25.0797, lng: 121.2342,
  domesticBufferMin: 60, domesticBufferMax: 90,
  internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  verified: false, terminalInfo: null,
};

const SESSION: LayoverSession = {
  id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
  arrivalTime: new Date(NOW).toISOString(),
  departureTime: new Date(NOW + 8 * 3_600_000).toISOString(),
  boardingTime: null, layoverMinutes: 480,
  flightType: "international", immigrationRequired: false, checkedBags: false,
  loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: [],
  manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
  canonicalCityId: null, shareCityStatus: false,
  returnReminderAt: new Date(NOW + 5 * 3_600_000).toISOString(),
  status: "active",
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
};

const RECORD = certifySessionFeasibility(AIRPORT, SESSION, { nowMs: NOW });

function bundle(over: Parameters<typeof buildOfflineBundle>[0] | null = null) {
  return buildOfflineBundle(
    over ?? {
      session: SESSION, airport: AIRPORT, record: RECORD,
      hardReturnLocal: "12:00",
      stops: [{ title: "Night market", durationMin: 60, travelMin: 25, insideAirport: false }],
    },
  );
}

const replanInputs = {
  certifiedUsableMinutes: RECORD.envelope.usableMinutes,
  currentDepartureTime: SESSION.departureTime,
  currentBoardingTime: SESSION.boardingTime,
  certifiedDepartureTime: SESSION.departureTime,
  certifiedBoardingTime: SESSION.boardingTime,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("§16 L150 — the bundle carries its own snapshot timestamp", () => {
  it("carries certifiedAt, staleAfter and the certification of the record behind it", () => {
    const b = bundle();
    assert.equal(b.bundleVersion, LAYOVER_OFFLINE_BUNDLE_VERSION);
    assert.equal(b.certifiedAt, new Date(NOW).toISOString());
    assert.equal(b.staleAfter, new Date(NOW + OFFLINE_BUNDLE_TTL_MIN * 60_000).toISOString());
    assert.equal(b.certification.inputHash, RECORD.inputHash);
    assert.equal(b.certification.engineVersion, RECORD.engineVersion);
  });

  it("the deadline in the bundle IS the certified deadline — no second derivation", () => {
    const b = bundle();
    assert.equal(b.returnDeadline.hardReturnTime, RECORD.deadline.hardReturnTime.toISOString());
    assert.equal(b.returnDeadline.bufferMinutes, RECORD.deadline.breakdown.totalBuffer);
    assert.equal(b.returnDeadline.returnState, RECORD.envelope.returnState);
    assert.equal(b.returnDeadline.returnReminderAt, SESSION.returnReminderAt);
  });

  it("the TTL is bounded by the escalation ladder's own first step", () => {
    // A bundle older than half the RETURN_SOON lead could show NORMAL to a
    // traveller who has already crossed into RETURN_SOON.
    assert.ok(
      OFFLINE_BUNDLE_TTL_MIN <= RETURN_SOON_LEAD_MIN / 2,
      `TTL ${OFFLINE_BUNDLE_TTL_MIN} exceeds half the ${RETURN_SOON_LEAD_MIN}-minute RETURN_SOON lead`,
    );
  });
});

describe("§16 L151-L155 — every unavailable capability says so by name", () => {
  it("route, map geometry, flight status, crew point and phrases are explicitly unavailable", () => {
    const b = bundle();
    assert.deepEqual(b.route, { available: false, value: null, reason: "no_routing_provider" });
    assert.deepEqual(b.mapGeometry, { available: false, value: null, reason: "no_envelope_geometry" });
    assert.deepEqual(b.flightStatus, { available: false, value: null, reason: "no_flight_feed" });
    assert.deepEqual(b.crewMeetingPoint, { available: false, value: null, reason: "no_crew_storage" });
    assert.deepEqual(b.translationPhrases, { available: false, value: null, reason: "no_phrase_catalogue" });
  });

  it("the traveller's own schedule is NOT dressed up as a confirmed flight status", () => {
    const b = bundle();
    assert.equal(b.flightStatus.available, false);
    assert.equal(b.flightStatus.value, null);
  });

  it("the airport IS cacheable and carries what exists", () => {
    const b = bundle();
    assert.equal(b.airport.iataCode, "TPE");
    assert.equal(b.airport.timezone, "Asia/Taipei");
    assert.equal(b.airport.terminalInfo, null, "0 production rows carry terminal_info; none is invented");
  });
});

describe("§16 staleness", () => {
  it("POSITIVE CONTROL: a bundle read one minute later is fresh", () => {
    const f = bundleFreshness(bundle(), NOW + 60_000);
    assert.equal(f.stale, false);
    assert.equal(f.ageMinutes, 1);
    assert.equal(f.freshForMinutes, OFFLINE_BUNDLE_TTL_MIN - 1);
  });

  it("goes stale exactly at the TTL, not before", () => {
    const b = bundle();
    assert.equal(bundleFreshness(b, NOW + (OFFLINE_BUNDLE_TTL_MIN * 60_000) - 1).stale, false);
    assert.equal(bundleFreshness(b, NOW + OFFLINE_BUNDLE_TTL_MIN * 60_000).stale, true);
  });

  it("age never goes negative on a clock that runs backwards", () => {
    const f = bundleFreshness(bundle(), NOW - 600_000);
    assert.equal(f.ageMinutes, 0);
  });
});

describe("§16 L156 — local replan only when the cached inputs still suffice", () => {
  it("POSITIVE CONTROL: fresh bundle, unchanged schedule, deadline ahead → allowed", () => {
    const d = localReplan(bundle(), { ...replanInputs, nowMs: NOW + 5 * 60_000 });
    assert.equal(d.allowed, true, `refusals: ${d.refusals.join(",")}`);
    assert.deepEqual(d.refusals, []);
    assert.equal(d.conservativeUsableMinutes, RECORD.envelope.usableMinutes - 5);
  });

  it("a STALE bundle refuses — and still hands back the deadline", () => {
    const d = localReplan(bundle(), { ...replanInputs, nowMs: NOW + 60 * 60_000 });
    assert.equal(d.allowed, false);
    assert.ok(d.refusals.includes("bundle_stale"));
    assert.equal(d.conservativeUsableMinutes, null);
    assert.equal(
      d.lastCertifiedDeadline,
      RECORD.deadline.hardReturnTime.toISOString(),
      "the deadline is the one number that must survive everything else going dark",
    );
    assert.equal(d.lastCertifiedReturnState, RECORD.envelope.returnState);
  });

  it("a CHANGED schedule refuses — the cached deadline is about a different flight", () => {
    const d = localReplan(bundle(), {
      ...replanInputs,
      currentDepartureTime: new Date(NOW + 9 * 3_600_000).toISOString(),
      nowMs: NOW + 60_000,
    });
    assert.equal(d.allowed, false);
    assert.ok(d.refusals.includes("schedule_changed_since_certification"));
  });

  it("a changed BOARDING time refuses too", () => {
    const d = localReplan(bundle(), {
      ...replanInputs,
      currentBoardingTime: new Date(NOW + 7 * 3_600_000).toISOString(),
      nowMs: NOW + 60_000,
    });
    assert.equal(d.allowed, false);
    assert.ok(d.refusals.includes("schedule_changed_since_certification"));
  });

  it("past the hard return, §15 owns the moment and §16 refuses", () => {
    const past = RECORD.deadline.hardReturnTime.getTime() + 60_000;
    const b = buildOfflineBundle({
      session: SESSION, airport: AIRPORT,
      record: certifySessionFeasibility(AIRPORT, SESSION, { nowMs: past - 60_000 }),
    });
    const d = localReplan(b, { ...replanInputs, nowMs: past });
    assert.equal(d.allowed, false);
    assert.ok(d.refusals.includes("already_past_hard_return"));
  });

  it("the conservative window only ever SHRINKS with age", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let m = 0; m < OFFLINE_BUNDLE_TTL_MIN; m++) {
      const d = localReplan(bundle(), { ...replanInputs, nowMs: NOW + m * 60_000 });
      assert.equal(d.allowed, true);
      const u = d.conservativeUsableMinutes!;
      assert.ok(u <= RECORD.envelope.usableMinutes, "it may never exceed the certified window");
      assert.ok(u <= previous, "it may never grow as the bundle ages");
      previous = u;
    }
    assert.ok(previous < RECORD.envelope.usableMinutes, "control: it actually moved");
  });
});

describe("§16 adaptive sensing", () => {
  const base = { returnState: "NORMAL" as const, stationary: false, insideAirport: false, locationGranted: true };

  it("NO permission means NO sensing, in every state including the worst one", () => {
    for (const returnState of ["NORMAL", "RETURN_SOON", "RETURN_NOW", "CONNECTION_AT_RISK"] as const) {
      const p = sensingPolicy({ ...base, returnState, locationGranted: false });
      assert.equal(p.cadence, "none", `${returnState} must not sense without permission`);
      assert.equal(p.continuousGpsPermitted, false);
      assert.equal(p.intervalSeconds, null);
    }
  });

  it("safe and stationary uses semantic checkpoints, not polling", () => {
    const p = sensingPolicy({ ...base, stationary: true });
    assert.equal(p.cadence, "significant_change");
    assert.equal(p.intervalSeconds, null, "no interval means no polling loop");
    assert.equal(p.continuousGpsPermitted, false);
  });

  it("inside the airport is treated as stationary", () => {
    assert.equal(sensingPolicy({ ...base, insideAirport: true }).cadence, "significant_change");
  });

  it("near the decision boundary moves to a moderate cadence, still not continuous", () => {
    const p = sensingPolicy({ ...base, returnState: "RETURN_SOON" });
    assert.equal(p.cadence, "periodic");
    assert.equal(p.continuousGpsPermitted, false);
    assert.ok((p.intervalSeconds ?? 0) > 0);
  });

  it("continuous GPS is permitted in EXACTLY the returning states and nowhere else", () => {
    let permitted = 0;
    for (const returnState of ["NORMAL", "RETURN_SOON", "RETURN_NOW", "CONNECTION_AT_RISK"] as const) {
      for (const stationary of [true, false]) {
        for (const insideAirport of [true, false]) {
          for (const locationGranted of [true, false]) {
            const p = sensingPolicy({ returnState, stationary, insideAirport, locationGranted });
            if (p.continuousGpsPermitted) {
              permitted++;
              assert.equal(locationGranted, true);
              assert.ok(
                returnState === "RETURN_NOW" || returnState === "CONNECTION_AT_RISK",
                `continuous GPS leaked into ${returnState}`,
              );
              assert.equal(p.cadence, "navigation");
            }
          }
        }
      }
    }
    assert.ok(permitted > 0, "vacuity guard: the navigation case must actually be reachable");
  });

  it("moving landside well before the deadline polls at the LOWEST frequency of any polling state", () => {
    const far = sensingPolicy(base);
    const near = sensingPolicy({ ...base, returnState: "RETURN_SOON" });
    const nav = sensingPolicy({ ...base, returnState: "RETURN_NOW" });
    assert.ok(far.intervalSeconds! > near.intervalSeconds!);
    assert.ok(near.intervalSeconds! > nav.intervalSeconds!);
  });
});
