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
  evaluateSharingGate as readSharingGate, discloseSharingGate,
  publishableUserIds,
  readTripGhostMode,
  disclosePresence,
  isSharingAllowed,
  sanitizeNearbyTraveler,
  presenceLevelAtMost,
  PRESENCE_LEVELS,
  PRESENCE_COUNT_MIN_K,
  type SharingGateResult,
} from "../services/airport/LayoverPrivacyGuard.js";
import { PRESENCE_INTENT_MIN_K } from "../services/layover/LayoverPresenceStore.js";

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
    const ghost = await readTripGhostMode(
      db({ failures: { "trip_crew_location_preferences:select": { message: "boom" } } }),
      null,
      USER,
    );
    // census L294: a LayoverRead. A read that was never issued cannot be degraded.
    assert.deepEqual(ghost, { kind: "read", value: false });
  });

  it("census L294: an UNREADABLE ghost-mode row is DEGRADED, its closed `true` a fallback, never a read value", async () => {
    const ghost = await readTripGhostMode(
      db({ failures: { "trip_crew_location_preferences:select": { message: "boom" } } }),
      TRIP,
      USER,
    );
    assert.deepEqual(ghost, { kind: "degraded", fallback: true, reasons: ["ghost_mode_unreadable"] });
    assert.equal("value" in ghost, false);
    // and the gate built on it still closes, and says which read failed
    const gate = await evaluateSharingGate(
      db({ prefs: [{ user_id: USER, location_mode: "nearby", sharing_paused: false }], failures: { "trip_crew_location_preferences:select": { message: "boom" } } }),
      { userId: USER, tripId: TRIP },
    );
    assert.equal(gate.allowed, false);
    assert.equal(gate.ghostMode, true);
    assert.equal(gate.degraded, true);
    assert.deepEqual(gate.reasons, ["ghost_mode", "ghost_mode_unreadable"]);
  });

  it("census L294: a stored switch is a READ value, on and off", async () => {
    for (const on of [true, false]) {
      const ghost = await readTripGhostMode(db({ crewPrefs: [{ trip_id: TRIP, user_id: USER, ghost_mode_enabled: on }] }), TRIP, USER);
      assert.deepEqual(ghost, { kind: "read", value: on });
    }
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
    assert.equal(r.kind, "read");
    if (r.kind !== "read") return;
    assert.deepEqual(r.value.allowed.sort(), ["c", "d"]);
    assert.deepEqual(r.value.denied.sort(), ["a", "b"]);
  });

  it("an UNREADABLE location_preferences publishes NOBODY", async () => {
    const r = await publishableUserIds(
      db({
        prefs: [{ user_id: "c", location_mode: "nearby", sharing_paused: false }],
        failures: { "location_preferences:select": { message: "db down" } },
      }),
      ["a", "b", "c"],
    );
    // census L294: DEGRADED, and the closed answer is a FALLBACK — there is no `value` to publish from.
    assert.equal(r.kind, "degraded");
    if (r.kind !== "degraded") return;
    assert.equal("value" in r, false);
    assert.deepEqual(r.fallback.allowed, [], "a failed read must not publish anyone");
    assert.deepEqual(r.fallback.denied.sort(), ["a", "b", "c"]);
    assert.deepEqual(r.reasons, ["sharing_preferences_unreadable"]);
  });

  it("an empty candidate set issues no query and is not degraded", async () => {
    const r = await publishableUserIds(
      db({ failures: { "location_preferences:select": { message: "db down" } } }),
      [],
    );
    assert.deepEqual(r, { kind: "read", value: { allowed: [], denied: [] } });
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

  // RESTATED 2026-10-08 under D-PRESENCE-K-4 (and D-PRESENCE-K rule 2): the L2
  // profiles are today's response, unchanged; the COUNT beside them is withheld.
  it("ladder OFF serves today's profiles, and NO count beside them (roster_visible)", () => {
    const d = disclosePresence({
      gate: allowed, sessionOptedIn: true, ladderEnabled: false, count: 14, travelers,
    });
    assert.equal(d.level, "L2_DISCOVERY");
    assert.strictEqual(d.count, null, "a count beside a roster that names people is withheld whole");
    assert.equal(d.countWithheld, "roster_visible");
    assert.deepEqual(d.travelers, travelers);
  });

  it("ladder ON never serves a count under k, whatever is handed in (D-PRESENCE-K-4 rule 1)", () => {
    for (const raw of [0, 1, 4]) {
      const d = disclosePresence({ gate: allowed, sessionOptedIn: true, ladderEnabled: true, count: raw, travelers });
      assert.strictEqual(d.count, null, `a count of ${raw} reached the wire`);
      assert.equal(d.countWithheld, "below_k");
    }
    const at = disclosePresence({ gate: allowed, sessionOptedIn: true, ladderEnabled: true, count: PRESENCE_COUNT_MIN_K, travelers });
    assert.equal(at.count, 5);
    assert.strictEqual(at.countWithheld, null);
    const unreadable = disclosePresence({ gate: allowed, sessionOptedIn: true, ladderEnabled: true, count: null, countWithheld: "unreadable", travelers });
    assert.strictEqual(unreadable.count, null);
    assert.equal(unreadable.countWithheld, "unreadable");
    assert.equal(PRESENCE_COUNT_MIN_K, PRESENCE_INTENT_MIN_K, "one k for every presence count");
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

// Existing gate assertions exercise the wire projection; the store itself now requires an explicit branch.
async function evaluateSharingGate(...args: Parameters<typeof readSharingGate>): Promise<SharingGateResult> {
  return discloseSharingGate(await readSharingGate(...args));
}
describe("L294 typed sharing-read boundary", () => {
  it("does not expose a failed settings read as measured allowed data", async () => {
    const result = await readSharingGate(db({ failures: { "location_preferences:select": { message: "settings unavailable" } } }), { userId: USER });
    assert.equal(result.kind, "degraded");
    assert.equal("value" in result, false);
    assert.equal("allowed" in result, false);
    if (result.kind !== "degraded") assert.fail("expected typed degradation");
    assert.equal(result.fallback.allowed, false);
    assert.ok(result.reasons.includes("preferences_unreadable"));
    assert.equal(discloseSharingGate(result).degraded, true);
  });
  it("reports a thrown transport read as degraded and refuses sharing", async () => {
    const throwing = { from() { throw new Error("privacy transport unavailable"); } } as unknown as Parameters<typeof readSharingGate>[0];
    const result = await readSharingGate(throwing, { userId: USER, tripId: TRIP });
    assert.equal(result.kind, "degraded");
    if (result.kind !== "degraded") assert.fail("expected typed degradation");
    assert.deepEqual(result.reasons, ["sharing_gate_read_threw"]);
    assert.equal(discloseSharingGate(result).allowed, false);
  });
});
