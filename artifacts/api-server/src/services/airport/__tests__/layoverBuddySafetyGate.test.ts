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
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { LAYOVER_COMPATIBLE_BUDDY_CATEGORIES } from "../LayoverBuddyGate.js";

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
  categories: ["city"],
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
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
  return tables;
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

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
      buddy({ id: "b-city", user_id: "u-city", categories: ["city"] }),
      buddy({ id: "b-night", user_id: "u-night", categories: ["nightlife", "packages"] }),
    ] });
    const r = await req(URL_);
    const ids = r.body.buddies.map((b: any) => b.id);
    assert.ok(ids.includes("b-city"));
    assert.ok(!ids.includes("b-night"), "a nightlife/packages-only profile is not a layover service");
  });

  it("a profile that declares NO categories is kept, and honestly marked not-a-specialist", async () => {
    stage({ hoursToDeparture: 12, buddies: [buddy({ id: "b-blank", user_id: "u-blank", categories: [] })] });
    const r = await req(URL_);
    assert.equal(r.body.buddies.length, 1, "an absent declaration is an unknown, not a disqualification");
    assert.equal(r.body.buddies[0].layoverCompatible, false);
  });

  it("the compatible set is declared, non-empty, and drawn from the real vocabulary", () => {
    assert.ok(LAYOVER_COMPATIBLE_BUDDY_CATEGORIES.length > 0);
    for (const c of LAYOVER_COMPATIBLE_BUDDY_CATEGORIES) {
      assert.ok(["city", "language", "arrival", "shopping", "content"].includes(c),
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
   * THE NIGHT-LAYOVER ARM IS NOT TESTED HERE BECAUSE IT IS NOT SHIPPED. See
   * LayoverBuddyGate.ts's header: every night formulation is a function of the
   * wall clock at request time, and `src/test/layoverBuddiesMasterFlag.test.ts`
   * stages its positive control relative to `Date.now()`, so the night arm
   * makes that suite pass in the morning and fail in the evening. A flake in
   * another lane's file is not a closed row.
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
    _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
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
    // PINNED, not relative: "in 12 hours" lands in the 22:00-08:00 band on some
    // runs and not others, and a control that is only sometimes a control is
    // worse than none. 14:00 Asia/Taipei is 06:00 UTC, two days out.
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 2);
    day.setUTCHours(6, 0, 0, 0);
    stage({ hoursToDeparture: 0, departAt: day, buddies: [buddy({ id: "b-unverified", user_id: "u-unverified", verified: false })] });
    const r = await req(URL_);
    assert.equal(r.body.trustRequirement.applied, false, JSON.stringify(r.body.trustRequirement));
    assert.equal(r.body.buddies.length, 1, "the rule must not quietly become an always-on filter");
  });
});

// ── L294/C2 on the same endpoint ─────────────────────────────────────────────

describe("L294 — an unreadable rent_buddy_profiles is not 'nobody is here'", () => {
  it("a failed read refuses instead of serving an empty, ok:true list", async () => {
    const now = Date.now();
    _setTestClient(makeLayoverDb({
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
    }, {
      users: { [TOKEN]: USER_ID },
      failures: { "rent_buddy_profiles:select": { message: "relation unavailable" } },
    }), true);
    const r = await req(URL_);
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
  });
});
