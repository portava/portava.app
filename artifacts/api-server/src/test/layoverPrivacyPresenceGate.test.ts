/**
 * Layover §17: the sharing gate DENIES, and a failed read is not consent.
 *
 * node:test + node:assert/strict (NOT vitest). Table-backed fake Supabase.
 * The verdict is the EXIT CODE.
 *
 * ── THE DEFECT THIS PINS ────────────────────────────────────────────────────
 * `LayoverPrivacyGuard.ts:1-6` claimed the module "Enforces Ghost Mode,
 * location mode settings, and meetup privacy rules". Measured 2026-09-08:
 * `isSharingAllowed` and `sanitizeNearbyTraveler` were referenced ONLY from
 * `src/test/airport.test.ts`. The live presence path consulted
 * `share_city_status` and nothing else, so a traveller who had set
 * `location_mode: "off"`, paused sharing, or turned ghost mode on for the trip
 * was still published to strangers in the same city. The settings were stored
 * correctly and then ignored.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS, AND WHAT STOPS IT ──────────────────
 * A gate that returns `true` for everything passes any test that only checks
 * the gate was CALLED. So every denial case asserts `allowed === false` AND
 * names the reason, and every one of them is paired with a POSITIVE CONTROL on
 * the same code path — a gate that denies everything fails just as loudly as
 * one that allows everything.
 *
 * The load-bearing case is the READ FAILURE. supabase-js RESOLVES on a database
 * error, so `const { data } = await` reads an unreadable preferences row as an
 * ABSENT one, and the shipped default for absent is CONSENT. The two failure
 * tests below assert the CLOSED answer and the specific `*_unreadable` reason,
 * so a fallback that quietly returns the permissive defaults cannot pass.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverPrivacyPresenceGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  evaluateSharingGate,
  publishableUserIds,
  readTripGhostMode,
  disclosePresence,
  isSharingAllowed,
  sanitizeNearbyTraveler,
  presenceLevelAtMost,
  PRESENCE_LEVELS,
  type SharingGateResult,
} from "../services/airport/LayoverPrivacyGuard.js";

const USER = "user-1";
const TRIP = "trip-1";

function db(opts: {
  prefs?: any[];
  crewPrefs?: any[];
  failures?: Record<string, { message: string }>;
} = {}) {
  return makeLayoverDb(
    {
      location_preferences: opts.prefs ?? [],
      trip_crew_location_preferences: opts.crewPrefs ?? [],
    },
    { failures: opts.failures ?? {} },
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("§17 sharing gate — the traveller's own settings decide", () => {
  it("POSITIVE CONTROL: a traveller with no stored row is allowed (shipped default)", async () => {
    const gate = await evaluateSharingGate(db(), { userId: USER, tripId: null });
    assert.equal(gate.allowed, true);
    assert.equal(gate.degraded, false);
    assert.deepEqual(gate.reasons, []);
    assert.equal(gate.locationMode, "city_only");
  });

  it("DENIES when location_mode is off", async () => {
    const gate = await evaluateSharingGate(
      db({ prefs: [{ user_id: USER, location_mode: "off", sharing_paused: false }] }),
      { userId: USER, tripId: null },
    );
    assert.equal(gate.allowed, false, "location_mode 'off' must deny");
    assert.ok(gate.reasons.includes("location_mode_off"), `reasons: ${gate.reasons.join(",")}`);
    assert.equal(gate.degraded, false, "a successful read of a real opt-out is not a degradation");
  });

  it("DENIES when sharing is paused, even with a permissive location_mode", async () => {
    const gate = await evaluateSharingGate(
      db({ prefs: [{ user_id: USER, location_mode: "nearby", sharing_paused: true }] }),
      { userId: USER, tripId: null },
    );
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.includes("sharing_paused"));
  });

  it("DENIES when ghost mode is on for the trip this layover belongs to", async () => {
    const gate = await evaluateSharingGate(
      db({
        prefs: [{ user_id: USER, location_mode: "nearby", sharing_paused: false }],
        crewPrefs: [{ trip_id: TRIP, user_id: USER, ghost_mode_enabled: true }],
      }),
      { userId: USER, tripId: TRIP },
    );
    assert.equal(gate.allowed, false, "ghost mode must deny");
    assert.ok(gate.reasons.includes("ghost_mode"));
    assert.equal(gate.ghostMode, true);
  });

  it("does NOT invent a ghost-mode answer for a layover with no trip", async () => {
    // No global ghost-mode store exists. Absence of a switch is not a switch
    // set to off, and it is certainly not a switch set to on: the gate must
    // neither deny on it nor claim to have read it.
    const { ghostMode, degraded } = await readTripGhostMode(
      db({ failures: { "trip_crew_location_preferences:select": { message: "boom" } } }),
      null,
      USER,
    );
    assert.equal(ghostMode, false);
    assert.equal(degraded, false, "a read that was never issued cannot be degraded");
  });

  // ── THE FALSE-CONSENT CASE ────────────────────────────────────────────────
  it("an UNREADABLE location_preferences DENIES — a failed read is not consent", async () => {
    const gate = await evaluateSharingGate(
      db({
        prefs: [{ user_id: USER, location_mode: "nearby", sharing_paused: false }],
        failures: { "location_preferences:select": { message: "connection reset" } },
      }),
      { userId: USER, tripId: null },
    );
    assert.equal(gate.allowed, false, "an unreadable preference row must not read as consent");
    assert.ok(
      gate.reasons.includes("preferences_unreadable"),
      `the reason must name the READ, not the traveller: ${gate.reasons.join(",")}`,
    );
    assert.equal(gate.degraded, true);
    // And the closed values must be the closed ones, not the permissive defaults.
    assert.equal(gate.locationMode, "off");
    assert.equal(gate.sharingPaused, true);
  });

  it("an UNREADABLE trip_crew_location_preferences DENIES via ghost mode", async () => {
    const gate = await evaluateSharingGate(
      db({
        prefs: [{ user_id: USER, location_mode: "nearby", sharing_paused: false }],
        failures: { "trip_crew_location_preferences:select": { message: "timeout" } },
      }),
      { userId: USER, tripId: TRIP },
    );
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.includes("ghost_mode_unreadable"));
    assert.equal(gate.ghostMode, true, "closed means hidden");
    assert.equal(gate.degraded, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§14 publish side — nobody is published on someone else's session flag alone", () => {
  it("drops the travellers whose own settings refuse, keeps the ones that do not", async () => {
    const r = await publishableUserIds(
      db({
        prefs: [
          { user_id: "a", location_mode: "off", sharing_paused: false },
          { user_id: "b", location_mode: "nearby", sharing_paused: true },
          { user_id: "c", location_mode: "nearby", sharing_paused: false },
          // "d" has no row at all — never opened settings; shipped default applies.
        ],
      }),
      ["a", "b", "c", "d"],
    );
    assert.deepEqual(r.allowed.sort(), ["c", "d"]);
    assert.deepEqual(r.denied.sort(), ["a", "b"]);
    assert.equal(r.degraded, false);
  });

  it("an UNREADABLE location_preferences publishes NOBODY", async () => {
    const r = await publishableUserIds(
      db({
        prefs: [{ user_id: "c", location_mode: "nearby", sharing_paused: false }],
        failures: { "location_preferences:select": { message: "db down" } },
      }),
      ["a", "b", "c"],
    );
    assert.deepEqual(r.allowed, [], "a failed read must not publish anyone");
    assert.deepEqual(r.denied.sort(), ["a", "b", "c"]);
    assert.equal(r.degraded, true);
  });

  it("an empty candidate set issues no query and is not degraded", async () => {
    const r = await publishableUserIds(
      db({ failures: { "location_preferences:select": { message: "db down" } } }),
      [],
    );
    assert.deepEqual(r, { allowed: [], denied: [], degraded: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§14 progressive disclosure", () => {
  const allowed: SharingGateResult = {
    allowed: true, reasons: [], degraded: false,
    locationMode: "city_only", sharingPaused: false, ghostMode: false,
  };
  const denied: SharingGateResult = {
    allowed: false, reasons: ["location_mode_off"], degraded: false,
    locationMode: "off", sharingPaused: false, ghostMode: false,
  };
  const travelers = [
    { id: "t1", handle: "one", name: "One", avatarUrl: null },
    { id: "t2", handle: "two", name: null, avatarUrl: null },
  ];

  it("a refused gate serves nothing — not a count, not a profile", () => {
    const d = disclosePresence({
      gate: denied, sessionOptedIn: true, ladderEnabled: false, count: 14, travelers,
    });
    assert.equal(d.sharing, false);
    assert.equal(d.count, 0, "the count is itself presence; a refused gate does not serve it");
    assert.deepEqual(d.travelers, []);
    assert.equal(d.level, "L0_AGGREGATE");
    assert.deepEqual(d.withheld, ["location_mode_off"]);
  });

  it("a session that has not opted in serves nothing, gate or no gate", () => {
    const d = disclosePresence({
      gate: allowed, sessionOptedIn: false, ladderEnabled: true, count: 14, travelers,
    });
    assert.equal(d.sharing, false);
    assert.equal(d.count, 0);
    assert.deepEqual(d.travelers, []);
  });

  it("ladder ON is aggregate-only: the count, and NO identities", () => {
    const d = disclosePresence({
      gate: allowed, sessionOptedIn: true, ladderEnabled: true, count: 14, travelers,
    });
    assert.equal(d.level, "L0_AGGREGATE");
    assert.equal(d.sharing, true);
    assert.equal(d.count, 14, "the aggregate IS the answer at L0");
    assert.deepEqual(d.travelers, [], "no identity may travel at L0");
  });

  it("ladder OFF reproduces today's response — count PLUS profiles", () => {
    const d = disclosePresence({
      gate: allowed, sessionOptedIn: true, ladderEnabled: false, count: 14, travelers,
    });
    assert.equal(d.level, "L2_DISCOVERY");
    assert.equal(d.count, 14);
    assert.deepEqual(d.travelers, travelers);
  });

  it("the ladder is ordered, and L0 is the least disclosing rung", () => {
    assert.deepEqual([...PRESENCE_LEVELS], [
      "L0_AGGREGATE", "L1_INTENT", "L2_DISCOVERY", "L3_CREW", "L4_TEMPORARY_LOCATION",
    ]);
    for (const level of PRESENCE_LEVELS) {
      assert.equal(presenceLevelAtMost("L0_AGGREGATE", level), true);
    }
    assert.equal(presenceLevelAtMost("L4_TEMPORARY_LOCATION", "L2_DISCOVERY"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the primitives the module always exported and nothing called", () => {
  it("isSharingAllowed refuses each of the three off-switches independently", () => {
    assert.equal(isSharingAllowed({ locationMode: "nearby", sharingPaused: false }), true);
    assert.equal(isSharingAllowed({ locationMode: "off", sharingPaused: false }), false);
    assert.equal(isSharingAllowed({ locationMode: "nearby", sharingPaused: true }), false);
    assert.equal(isSharingAllowed({ locationMode: "nearby", sharingPaused: false, ghostMode: true }), false);
  });

  it("sanitizeNearbyTraveler drops every field more precise than city/country", () => {
    const out = sanitizeNearbyTraveler({
      userId: "u", username: "u", avatarUrl: null,
      city: "Taoyuan", country: "Taiwan",
      lat: 25.0797, lng: 121.2342, neighborhood: "Dayuan",
    });
    assert.equal(out.approximateLocation, "Taoyuan, Taiwan");
    const keys = Object.keys(out).sort();
    assert.deepEqual(keys, ["approximateLocation", "avatarUrl", "userId", "username"]);
    const serialised = JSON.stringify(out);
    assert.equal(serialised.includes("25.07"), false);
    assert.equal(serialised.includes("121.2"), false);
    assert.equal(serialised.includes("Dayuan"), false);
  });
});
