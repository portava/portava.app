/**
 * census L273 — "**Rent a Buddy** — layover-specialist services **after the
 * safety/time gate**; strict boundaries"
 * census L254 — "Verified/trusted requirements for high-risk Buddy/marketplace
 * interactions"
 *
 * Both rows describe the same endpoint, `GET /airport/sessions/:id/buddies`,
 * and both name the same absence: the list was filtered on `status='active'`,
 * city, blocks and the marketplace flag, and on NOTHING ELSE.
 *
 *   L273 — "There is no safety gate, no layover-specialist category filter."
 *          A traveller whose certified window says `verdict: "no"` — they
 *          cannot leave the airport and get back in time — was still handed a
 *          list of people to go and meet in the city. The endpoint that knows
 *          the deadline and the endpoint that offers the meeting were the same
 *          request, and it never asked.
 *   L254 — "`verified` and `buddy_level` are read and returned … but nothing
 *          *requires* them." An unverified, brand-new buddy profile ranked by
 *          review count was served identically on a 03:00 night layover and a
 *          14:00 half-day one.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE: `rent_buddy_profiles.categories` has
 * no `layover` member anywhere in this repository — the vocabulary is
 * city / language / arrival / shopping / content (+ nightlife, group,
 * concierge, packages), `routes/rentABuddyRollout.ts:41`. So the filter below
 * is a COMPATIBILITY filter over the vocabulary that exists, not a specialist
 * credential, and the assertions say so.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverBuddySafetyGate.test.ts
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js"; import { withConfirmedCorridor } from "../../../test/helpers/confirmedCorridor.js";
import { LAYOVER_COMPATIBLE_BUDDY_CATEGORIES, landsideWindowTouchesNight } from "../LayoverBuddyGate.js";

let server: http.Server;
let base: string;
const TOKEN = "buddy-gate-token";
const USER_ID = "user-1";

function req(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const buddy = (over: Record<string, any> = {}) => ({
  id: over.id ?? "b1",
  user_id: over.user_id ?? "buddy-user-1",
  display_name: "A Buddy",
  tagline: null,
  city: "Taoyuan",
  country: "Taiwan",
  categories: ["layover"],
  hourly_rate_usd: 30,
  average_rating: 4.8,
  review_count: 40,
  verified: true,
  cover_photo_url: null,
  buddy_level: "seasoned",
  available_now: true,
  status: "active",
  ...over,
});

/**
 * A session whose window is wide open (arrival an hour ago, departure many
 * hours out) or shut (departure imminent). `airportRow()` is Taoyuan with the
 * generic buffers, so a ~2h remaining window is comfortably `verdict: "no"`
 * for an international immigration session.
 */
function stage(opts: { hoursToDeparture: number; buddies: any[]; sessionOver?: Record<string, any>; departAt?: Date }) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      user_id: USER_ID,
      arrival_time: new Date(now - 3_600_000).toISOString(),
      departure_time: (opts.departAt ?? new Date(now + opts.hoursToDeparture * 3_600_000)).toISOString(),
      boarding_time: null,
      flight_type: "international",
      immigration_required: true,
      wants_to_leave: true,
      ...(opts.sessionOver ?? {}),
    })],
    layover_events: [],
    rent_buddy_profiles: opts.buddies,
    rent_buddy_availability: [],
    blocks: [],
  };
  _setTestClient(makeLayoverDb(withConfirmedSpecialists(tables, { userIds: [USER_ID], destination: "TW" }), { users: { [TOKEN]: USER_ID } }), true);
  return tables;
}

/**
 * THE CLOCK IS PINNED (census-layover L254 night arm, wave W). Every session in
 * this file is staged relative to `Date.now()` and the route reads `Date.now()`;
 * with the night arm shipped, an unpinned clock makes the trust requirement a
 * function of when the suite runs. `DAY` is 10:00 Asia/Taipei (the fixture
 * airport), so every window staged below sits inside 06:00–22:00 local unless a
 * test moves the clock on purpose.
 */
const DAY = Date.parse("2026-09-13T02:00:00.000Z");   // 10:00 Asia/Taipei
const NIGHT = Date.parse("2026-09-13T15:00:00.000Z"); // 23:00 Asia/Taipei

before(() => {
  mock.timers.enable({ apis: ["Date"], now: DAY });
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => { mock.timers.reset(); return new Promise<void>((resolve) => server.close(() => resolve())); });

const URL_ = "/api/airport/sessions/session-1/buddies";

// ── L273: the safety/time gate comes FIRST ───────────────────────────────────

describe("L273 — layover buddies are offered only AFTER the safety/time gate", () => {
  it("a window that cannot support leaving the airport serves NO buddies, and names the gate", async () => {
    stage({ hoursToDeparture: 2.5, buddies: [buddy()] });
    const r = await req(URL_);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.buddies, [], "a traveller who cannot leave must not be offered someone to leave with");
    assert.equal(r.body.reason, "safety_gate_not_passed");
    assert.equal(r.body.safetyGate.passed, false);
    assert.equal(r.body.safetyGate.verdict, "no");
  });

  it("a traveller who chose to stay airside is not offered a landside meeting either", async () => {
    stage({ hoursToDeparture: 12, buddies: [buddy()], sessionOver: { wants_to_leave: false } });
    const r = await req(URL_);
    assert.deepEqual(r.body.buddies, []);
    assert.equal(r.body.safetyGate.verdict, "stay_airside");
  });

  it("positive control: a wide-open window passes the gate and serves the list", async () => {
    stage({ hoursToDeparture: 12, buddies: [buddy()] });
    const r = await req(URL_);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.safetyGate.passed, true);
    assert.equal(r.body.buddies.length, 1, JSON.stringify(r.body));
  });

  it("the gate is the CERTIFIED verdict, not a second arithmetic — it travels with the answer", async () => {
    stage({ hoursToDeparture: 12, buddies: [buddy()] });
    const r = await req(URL_);
    assert.ok(r.body.safetyGate.engineVersion, "the gate names the rules that produced it");
    assert.equal(typeof r.body.safetyGate.usableMinutes, "number");
  });
});

// ── L273: strict boundaries — the category filter ────────────────────────────

describe("L273 — strict boundaries over the category vocabulary that actually exists", () => {
  it("a profile that positively declares an unrelated service is excluded", async () => {
    stage({ hoursToDeparture: 12, buddies: [
      buddy({ id: "b-city", user_id: "u-city", categories: ["layover"] }),
      buddy({ id: "b-night", user_id: "u-night", categories: ["nightlife", "packages"] }),
    ] });
    const r = await req(URL_);
    const ids = r.body.buddies.map((b: any) => b.id);
    assert.ok(ids.includes("b-city"));
    assert.ok(!ids.includes("b-night"), "a nightlife/packages-only profile is not a layover service");
  });

  it("a profile that declares NO categories is excluded from specialist offers", async () => {
    stage({ hoursToDeparture: 12, buddies: [buddy({ id: "b-blank", user_id: "u-blank", categories: [] })] });
    const r = await req(URL_);
    assert.equal(r.body.buddies.length, 0, "an absent declaration cannot certify a specialist");
    assert.deepEqual(r.body.buddies, []);
  });

  it("the compatible set is declared, non-empty, and drawn from the real vocabulary", () => {
    assert.ok(LAYOVER_COMPATIBLE_BUDDY_CATEGORIES.length > 0);
    for (const c of LAYOVER_COMPATIBLE_BUDDY_CATEGORIES) {
      assert.ok(["layover"].includes(c),
        `${c} is not a category rent_buddy_profiles actually carries`);
    }
  });
});

// ── L254: verified / trusted REQUIRED on a high-risk layover ─────────────────

describe("L254 — a high-risk layover requires a verified, non-new buddy", () => {
  /**
   * High risk is the ENGINE's own word, not a second threshold: `tight` is
   * `verdict` for a window with 45-89 usable minutes. A stranger meeting on a
   * window that tight is the marketplace interaction L254 calls high-risk.
   *
   * The night arm is the describe below; this one runs at the pinned `DAY`.
   *
   * ~70 usable minutes: arrival now, departure now + 3h20m. Buffer for an
   * international immigration session at the generic profile is 170-190, so
   * the window lands in `tight` whatever the time-of-day term does.
   */
  function tightSession(buddies: any[]) {
    const now = Date.now();
    const tables: Record<string, any[]> = {
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true },
        { flag: "rent_buddy_enabled", enabled: true },
      ],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({
        user_id: USER_ID,
        arrival_time: new Date(now - 60 * 60_000).toISOString(),
        departure_time: new Date(now + 245 * 60_000).toISOString(),
        boarding_time: null,
        flight_type: "international",
        immigration_required: true,
        wants_to_leave: true,
      })],
      layover_events: [],
      rent_buddy_profiles: buddies,
      rent_buddy_availability: [],
      blocks: [],
    };
    _setTestClient(makeLayoverDb(withConfirmedSpecialists(tables, { userIds: [USER_ID], destination: "TW" }), { users: { [TOKEN]: USER_ID } }), true);
  }

  it("an unverified buddy is withheld on a tight window, and the requirement is named", async () => {
    tightSession([
      buddy({ id: "b-unverified", user_id: "u-unverified", verified: false }),
      buddy({ id: "b-verified", user_id: "u-verified", verified: true, buddy_level: "seasoned" }),
    ]);
    const r = await req(URL_);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.trustRequirement.applied, true, JSON.stringify(r.body.trustRequirement));
    const ids = r.body.buddies.map((b: any) => b.id);
    assert.ok(!ids.includes("b-unverified"), "an unverified stranger is not a tight-window match");
    assert.ok(ids.includes("b-verified"));
  });

  it("a brand-new buddy level is withheld on a tight window even when verified", async () => {
    tightSession([buddy({ id: "b-new", user_id: "u-new", verified: true, buddy_level: "new" })]);
    const r = await req(URL_);
    assert.deepEqual(r.body.buddies.map((b: any) => b.id), []);
    assert.equal(r.body.trustRequirement.applied, true);
  });

  it("on an ordinary wide-open layover the requirement is NOT applied — it is a risk rule, not a policy change", async () => {
    // PINNED: the clock is `DAY` (10:00 Taipei) and departure is 20:00 Taipei,
    // so the certified landside window (~10:45 → ~16:50 local) never touches
    // the night band. (The control used to depart two days out; with the night
    // arm a window that long always crosses a night, so it would no longer be
    // a control.)
    stage({ hoursToDeparture: 10, buddies: [buddy({ id: "b-unverified", user_id: "u-unverified", verified: false })] });
    const r = await req(URL_);
    assert.equal(r.body.trustRequirement.applied, false, JSON.stringify(r.body.trustRequirement));
    assert.equal(r.body.buddies.length, 1, "the rule must not quietly become an always-on filter");
  });
});

// ── L254: the NIGHT arm ──────────────────────────────────────────────────────

describe("L254 night arm — the night band is read in the AIRPORT's timezone, half-open at both edges", () => {
  const at = (iso: string) => Date.parse(iso);
  // Asia/Taipei is UTC+8 with no DST: 22:00 local = 14:00Z, 06:00 local = 22:00Z.
  it("the 22:00 edge: a window ending AT 22:00 local is day; ending one minute later is night", () => {
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-13T02:00:00Z"), at("2026-09-13T14:00:00Z")), false);
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-13T02:00:00Z"), at("2026-09-13T14:01:00Z")), true);
  });
  it("the 06:00 edge: a window starting AT 06:00 local is day; starting one minute earlier is night", () => {
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-13T22:00:00Z"), at("2026-09-14T08:00:00Z")), false);
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-13T21:59:00Z"), at("2026-09-14T08:00:00Z")), true);
  });
  it("a window wholly inside the night band (02:00–04:00 local) is night", () => {
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-12T18:00:00Z"), at("2026-09-12T20:00:00Z")), true);
  });
  it("the SAME instants are day at one airport and night at another — the zone is the airport's", () => {
    // 06:00Z–14:00Z: 14:00–22:00 in Taipei (day); 02:00–10:00 EDT in New York (night).
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-13T06:00:00Z"), at("2026-09-13T14:00:00Z")), false);
    assert.equal(landsideWindowTouchesNight("America/New_York", at("2026-09-13T06:00:00Z"), at("2026-09-13T14:00:00Z")), true);
  });
  it("a half-hour zone puts the edge on the half hour (Asia/Kolkata, UTC+05:30: 22:00 local = 16:30Z)", () => {
    assert.equal(landsideWindowTouchesNight("Asia/Kolkata", at("2026-09-13T04:00:00Z"), at("2026-09-13T16:30:00Z")), false);
    assert.equal(landsideWindowTouchesNight("Asia/Kolkata", at("2026-09-13T04:00:00Z"), at("2026-09-13T16:31:00Z")), true);
    // 06:00 local = 00:30Z
    assert.equal(landsideWindowTouchesNight("Asia/Kolkata", at("2026-09-13T00:30:00Z"), at("2026-09-13T10:00:00Z")), false);
    assert.equal(landsideWindowTouchesNight("Asia/Kolkata", at("2026-09-13T00:29:00Z"), at("2026-09-13T10:00:00Z")), true);
  });
  it("across a DST change the local hour is re-read, not counted (New York, fall-back 2026-11-01)", () => {
    // 06:00 EST on 2026-11-01 is 11:00Z (EDT ended at 06:00Z). 10:59Z is 05:59 EST.
    assert.equal(landsideWindowTouchesNight("America/New_York", at("2026-11-01T11:00:00Z"), at("2026-11-01T20:00:00Z")), false);
    assert.equal(landsideWindowTouchesNight("America/New_York", at("2026-11-01T10:59:00Z"), at("2026-11-01T20:00:00Z")), true);
  });
  it("fails closed: an unusable zone or an unreadable instant is night; no window is not", () => {
    assert.equal(landsideWindowTouchesNight("Not/AZone", at("2026-09-13T02:00:00Z"), at("2026-09-13T04:00:00Z")), true);
    assert.equal(landsideWindowTouchesNight(null, at("2026-09-13T02:00:00Z"), at("2026-09-13T04:00:00Z")), true);
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", Number.NaN, at("2026-09-13T04:00:00Z")), true);
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-13T04:00:00Z"), at("2026-09-13T04:00:00Z")), false);
  });
  it("a window longer than the day part always touches night", () => {
    assert.equal(landsideWindowTouchesNight("Asia/Taipei", at("2026-09-13T00:00:00Z"), at("2026-09-13T19:00:00Z")), true);
  });
});

describe("L254 night arm — through the route, on a pinned clock", () => {
  after(() => mock.timers.setTime(DAY));

  it("a night layover requires a verified, non-new buddy, and says why", async () => {
    mock.timers.setTime(NIGHT); // 23:00 Taipei; departure 11:00 next morning
    stage({ hoursToDeparture: 12, buddies: [
      buddy({ id: "b-unverified", user_id: "u-unverified", verified: false }),
      buddy({ id: "b-new", user_id: "u-new", verified: true, buddy_level: "new" }),
      buddy({ id: "b-ok", user_id: "u-ok", verified: true, buddy_level: "seasoned" }),
    ] });
    const r = await req(URL_);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.safetyGate.passed, true, "the night arm is a trust requirement, not a block");
    assert.deepEqual(r.body.trustRequirement, {
      applied: true, reason: "night_window", reasons: ["night_window"], requires: ["verified", "buddy_level_not_new"],
    });
    assert.deepEqual(r.body.buddies.map((b: any) => b.id), ["b-ok"]);
  });

  it("CONTROL: the same session shape at 10:00 local applies nothing", async () => {
    mock.timers.setTime(DAY);
    stage({ hoursToDeparture: 10, buddies: [buddy({ id: "b-unverified", user_id: "u-unverified", verified: false })] });
    const r = await req(URL_);
    assert.deepEqual(r.body.trustRequirement, { applied: false, reason: null, reasons: [], requires: [] });
    assert.equal(r.body.buddies.length, 1);
  });

  it("a night already BEHIND the traveller does not count: the window starts at the record's now, not at landing", async () => {
    mock.timers.setTime(DAY); // 10:00 Taipei; landed 05:00 local, out by ~05:45 — inside the band
    const now = Date.now();
    stage({ hoursToDeparture: 10, buddies: [buddy({ id: "b-unverified", user_id: "u-unverified", verified: false })],
      sessionOver: { arrival_time: new Date(now - 5 * 3_600_000).toISOString() } });
    const r = await req(URL_);
    assert.deepEqual(r.body.trustRequirement.reasons, [], JSON.stringify(r.body.trustRequirement));
    assert.equal(r.body.buddies.length, 1);
  });

  it("tight AND night: both reasons are named, tight first, and the same requirement applies", async () => {
    mock.timers.setTime(NIGHT);
    const now = Date.now();
    stage({ hoursToDeparture: 0, departAt: new Date(now + 245 * 60_000), buddies: [
      buddy({ id: "b-unverified", user_id: "u-unverified", verified: false }),
      buddy({ id: "b-ok", user_id: "u-ok", verified: true, buddy_level: "seasoned" }),
    ], sessionOver: { arrival_time: new Date(now - 60 * 60_000).toISOString() } });
    const r = await req(URL_);
    assert.equal(r.body.safetyGate.verdict, "tight", JSON.stringify(r.body.safetyGate));
    assert.deepEqual(r.body.trustRequirement.reasons, ["tight_window", "night_window"]);
    assert.equal(r.body.trustRequirement.reason, "tight_window", "the single-reason field keeps its old meaning");
    assert.deepEqual(r.body.buddies.map((b: any) => b.id), ["b-ok"]);
  });

  it("tight by DAY names only the tight arm", async () => {
    mock.timers.setTime(DAY);
    const now = Date.now();
    stage({ hoursToDeparture: 0, departAt: new Date(now + 245 * 60_000), buddies: [buddy()],
      sessionOver: { arrival_time: new Date(now - 60 * 60_000).toISOString() } });
    const r = await req(URL_);
    assert.deepEqual(r.body.trustRequirement.reasons, ["tight_window"]);
  });

  for (const flag of ["rent_buddy_enabled", "airport_mode_enabled"]) {
    it(`flag OFF (${flag}) answers byte-identically by night and by day`, async () => {
      const answer = async (clock: number) => {
        mock.timers.setTime(clock);
        const tables = stage({ hoursToDeparture: 12, buddies: [buddy({ verified: false })] });
        tables.feature_flags = tables.feature_flags.map((f) => (f.flag === flag ? { ...f, enabled: false } : f));
        return req(URL_);
      };
      const night = await answer(NIGHT);
      const day = await answer(DAY);
      assert.equal(night.status, day.status);
      assert.deepEqual(night.body, day.body, "with the flag off the night arm must not change the answer");
      assert.ok(!night.body?.buddies?.length, JSON.stringify(night.body));
      assert.equal(night.body?.trustRequirement, undefined, "no trust requirement is published behind a closed flag");
    });
  }
});

// ── L294/C2 on the same endpoint ─────────────────────────────────────────────

describe("L294 — an unreadable rent_buddy_profiles is not 'nobody is here'", () => {
  it("a failed read refuses instead of serving an empty, ok:true list", async () => {
    const now = Date.now();
    _setTestClient(makeLayoverDb(withConfirmedSpecialists({
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true },
        { flag: "rent_buddy_enabled", enabled: true },
      ],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({
        user_id: USER_ID,
        arrival_time: new Date(now - 3_600_000).toISOString(),
        departure_time: new Date(now + 12 * 3_600_000).toISOString(),
        flight_type: "international", immigration_required: true, wants_to_leave: true,
      })],
      layover_events: [], rent_buddy_profiles: [], rent_buddy_availability: [], blocks: [],
    }, { userIds: [USER_ID], destination: "TW" }), {
      users: { [TOKEN]: USER_ID },
      failures: { "rent_buddy_profiles:select": { message: "relation unavailable" } },
    }), true);
    const r = await req(URL_);
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

// ── L294/C2, the HALF §21.6 CLAIMED WAS ALREADY CLOSED ───────────────────────
//
// §21.6 of docs/architecture/census-layover.md says of the remaining C2 half —
// "a read that logs its error and then returns `[]` with no degraded flag" —
// *"Today no such site exists: every surface that still answers after a failed
// read publishes `degraded` with a named reason (presence, the session list,
// the active session, airport search) or refuses with 503 (session writes,
// session reads, **buddies**, session create)."*
//
// `/buddies` refuses with 503 for ONE of its three reads. The other two are
// inside the same handler and answer anyway:
//
//   * `blocks` unreadable  → `rows = []` → `{ ok: true, city, buddies: [] }`.
//     A traveller is told there is nobody in this city when what actually
//     happened is that we could not read their own block list. Serving nobody
//     is the right SAFETY posture and a wrong ANSWER: the emptiness was never
//     measured.
//   * `rent_buddy_availability` unreadable → every buddy is published with
//     `availableDuringLayover: false`, a positive claim about each person
//     derived from a read that did not happen, and the same field is the sort
//     key that picks which six of twelve are served.
//
// These cases assert on SHAPE — that the two empty answers are distinguishable
// from each other — before they bind the field that distinguishes them, so a
// rename of the reason string cannot make them vacuously green.
describe("L294 — the /buddies reads that answer anyway say that they are degraded", () => {
  function stageWithFailures(buddies: any[], failures: Record<string, { message: string }>) {
    const now = Date.now();
    _setTestClient(makeLayoverDb(withConfirmedSpecialists({
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true },
        { flag: "rent_buddy_enabled", enabled: true },
      ],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({
        user_id: USER_ID,
        arrival_time: new Date(now - 3_600_000).toISOString(),
        departure_time: new Date(now + 12 * 3_600_000).toISOString(),
        boarding_time: null,
        flight_type: "international",
        immigration_required: true,
        wants_to_leave: true,
      })],
      layover_events: [],
      rent_buddy_profiles: buddies,
      rent_buddy_availability: [],
      blocks: [],
    }, { userIds: [USER_ID], destination: "TW" }), { users: { [TOKEN]: USER_ID }, failures }), true);
  }

  it("an unreadable block list is NOT the same answer as a city with nobody in it", async () => {
    stageWithFailures([], {});
    const measuredEmpty = await req(URL_);
    stageWithFailures([buddy()], { "blocks:select": { message: "blocks unavailable" } });
    const unreadEmpty = await req(URL_);

    assert.equal(measuredEmpty.status, 200, JSON.stringify(measuredEmpty.body));
    assert.equal(unreadEmpty.status, 200, JSON.stringify(unreadEmpty.body));
    assert.deepEqual(measuredEmpty.body.buddies, [], "control: a city with no active buddies serves none");
    assert.deepEqual(unreadEmpty.body.buddies, [], "an unreadable block list must still serve nobody — fail closed");

    assert.notDeepEqual(
      unreadEmpty.body, measuredEmpty.body,
      "two empty lists, one measured and one from an outage, are byte-identical to the client",
    );
  });

  it("…and the thing that distinguishes them is a named degraded reason", async () => {
    stageWithFailures([buddy()], { "blocks:select": { message: "blocks unavailable" } });
    const r = await req(URL_);
    assert.equal(r.body.degraded, true);
    assert.ok(
      Array.isArray(r.body.degradedReasons) && r.body.degradedReasons.includes("blocks_unreadable"),
      JSON.stringify(r.body.degradedReasons),
    );
  });

  it("positive control: a readable surface is NOT degraded", async () => {
    stageWithFailures([buddy()], {});
    const r = await req(URL_);
    assert.equal(r.body.buddies.length, 1, JSON.stringify(r.body));
    assert.equal(r.body.degraded, false);
    assert.deepEqual(r.body.degradedReasons, []);
  });

  it("an unreadable availability table still serves the list, and does not publish 'not available' as a fact", async () => {
    stageWithFailures([buddy()], { "rent_buddy_availability:select": { message: "availability unavailable" } });
    const r = await req(URL_);
    assert.equal(r.body.buddies.length, 1, "availability is an ordering hint; losing it must not empty the list");
    assert.equal(r.body.degraded, true);
    assert.ok(
      Array.isArray(r.body.degradedReasons) && r.body.degradedReasons.includes("buddy_availability_unreadable"),
      JSON.stringify(r.body.degradedReasons),
    );
    assert.equal(
      r.body.buddies[0].availableDuringLayover, null,
      "an unmeasured availability is an unknown, not a false",
    );
  });

  it("a measured availability is still a real false, not an unknown", async () => {
    stageWithFailures([buddy()], {});
    const r = await req(URL_);
    assert.equal(r.body.buddies[0].availableDuringLayover, false,
      "the control that stops `null` from becoming the answer for everyone");
  });
});

/** Explicit current identity and payout fixtures; the legacy verified boolean still independently tests the extra high-risk rule. */
function withConfirmedSpecialists(tables:Record<string,any[]>,options:Parameters<typeof withConfirmedCorridor>[1]) {
 const enriched=withConfirmedCorridor(tables,options);enriched.feature_flags.push({flag:'layover_buddy_specialist_enabled',enabled:true});
 const buddies=tables.rent_buddy_profiles??[];
 enriched.profiles=[...(enriched.profiles??[]),...buddies.map(b=>({id:b.user_id,verification_level:'id_verified'}))];
 enriched.identity_verifications=buddies.map(b=>({id:`id-${b.user_id}`,user_id:b.user_id,provider:'stripe',provider_mode:'live',status:'verified',is_over_18:true,verified_at:new Date().toISOString(),created_at:new Date().toISOString()}));
 enriched.payment_parties=buddies.map(b=>({id:`party-${b.user_id}`,profile_id:b.user_id,kind:'user'}));
 enriched.rent_buddy_payment_recipients=buddies.map(b=>({party_id:`party-${b.user_id}`,provider:'stripe',recipient_ref:'fixture',country:'TW',settlement_currency:'TWD',onboarding:'verified',charges_enabled:true,payouts_enabled:true,livemode:false}));return enriched;
}
