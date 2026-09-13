/**
 * §3 L19 · §17 L162 — the Passport stamp, at completion, if the user chooses.
 *
 * ── WHAT WAS WRONG, IN THE CENSUS'S OWN WORDS ────────────────────────────────
 * L19 (*"Passport / Memory owns post-session durable artifacts **if the user
 * chooses**"*): *"the boundary holds — the stamp carries a city name only. But
 * it fires at session CREATION, not post-session, and the only gate is the
 * `passport_stamps_enabled` flag; the user never elects it."*
 * L162 (*"Completed places/stamps — durable only when the user elects
 * Passport/Memory behaviour"*): *"A stamp is written automatically at session
 * CREATION … before the traveller has completed anything and without electing
 * anything."*
 *
 * Both halves were real. `POST /airport/sessions` minted a durable, public
 * passport stamp for a city the traveller had not been to yet, on the strength
 * of having typed two flight times into a form — and if they then stayed
 * airside for eight hours, or cancelled the layover a minute later, the stamp
 * stayed. Nothing ever removed it and nothing ever asked.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────────────
 * 1. CREATION MINTS NOTHING. The first case is the regression pin for the
 *    deletion: it asserts `passport_stamps` is still EMPTY after a successful
 *    `POST /airport/sessions` that would previously have written one — same
 *    flag on, same resolvable city.
 * 2. COMPLETION + ELECTION MINTS ONE. Both terms are required and each is
 *    pinned by its own negative case, so neither can be dropped without a
 *    failure: completed-without-election writes nothing, and elected-on-a
 *    -CANCELLED-session writes nothing.
 * 3. THE ANSWER SAYS WHAT HAPPENED. `passportStamp.written` and `.reason` are
 *    asserted, not just the absence of a row — a client that has to infer
 *    whether a stamp was written is a client that will guess wrong.
 * 4. THE FLAG STILL GATES IT. Election is a user's choice, not an override of
 *    the kill switch.
 *
 * FALSE GREENS CONSIDERED. Every case asserts the exact `passport_stamps` row
 * COUNT rather than "no error", because a seam that writes twice and a seam
 * that writes once both leave a non-empty table. The stamp's own fields
 * (`source_type`, `city`) are asserted so a stamp written for a different
 * reason cannot satisfy the case. `req.log` is installed, so a handler throw
 * cannot masquerade as a considered refusal.
 *
 * Run: node --import tsx/esm --test src/test/layoverCompletionStamp.test.ts
 *
 * ── MUTATION LOG ─────────────────────────────────────────────────────────────
 * Recorded in §17.4 of docs/architecture/census-layover.md.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;
const TOKEN = "stamp-token";
const USER_ID = "user-1";

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * `sessionRow()` defaults `arrival_time` to `now + 5 minutes`. That default is
 * right for a session being CREATED and wrong for one being closed as
 * COMPLETED, and using it for the completion cases is what hid the occurrence
 * hole this suite was written beside: the happy-path case below was asserting
 * that a layover which had not begun earns a stamp, and passing. `arrived` puts
 * the declared arrival in the past, which is what "completed" actually means.
 * The fourth term is pinned separately — see layoverStampOccurrence.test.ts.
 */
function stage(opts: { stamps?: boolean; sessionOver?: Record<string, any>; arrived?: boolean } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "passport_stamps_enabled", enabled: opts.stamps !== false },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      user_id: USER_ID,
      ...(opts.arrived ? { arrival_time: new Date(Date.now() - 6 * 3_600_000).toISOString() } : {}),
      ...(opts.sessionOver ?? {}),
    })],
    layover_events: [],
    layover_plan_stops: [],
    passport_stamps: [],
    passport_visibility_preferences: [],
    trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
  return tables;
}

/** The seam is fire-and-forget on the server; give its microtasks a tick. */
const settle = () => new Promise<void>((r) => setTimeout(r, 40));

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

describe("the passport seam has moved off session creation (census L19, L162)", () => {
  it("POST /airport/sessions mints NO stamp, with the flag ON and a resolvable city", async () => {
    const t = stage();
    const now = Date.now();
    const r = await req("POST", "/api/airport/sessions", {
      iata: "TPE",
      arrivalTime: new Date(now + 5 * 60_000).toISOString(),
      departureTime: new Date(now + 8 * 3_600_000).toISOString(),
      flightType: "international",
      wantsToLeave: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    assert.equal(
      t.passport_stamps.length, 0,
      "creating a layover minted a durable passport stamp for a city nobody has been to yet",
    );
    assert.equal(
      t.layover_events.filter((e) => e.event_type === "passport_seam_emitted").length, 0,
      "the creation-time seam still fires",
    );
  });
});

describe("DELETE /airport/sessions/:id — completion AND election, both required", () => {
  it("a COMPLETED session the traveller elected to keep writes exactly one stamp", async () => {
    const t = stage({ arrived: true });
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed", passportStamp: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, "completed");
    assert.equal(r.body.session.status, "completed");
    assert.deepEqual(r.body.passportStamp, { requested: true, written: true, reason: "written" });

    await settle();
    assert.equal(t.passport_stamps.length, 1, JSON.stringify(t.passport_stamps));
    assert.equal(t.passport_stamps[0].city, "Taoyuan");
    assert.equal(t.passport_stamps[0].source_type, "layover_session");
    assert.equal(t.passport_stamps[0].user_id, USER_ID);

    const seam = t.layover_events.filter((e) => e.event_type === "passport_seam_emitted");
    assert.equal(seam.length, 1);
    assert.equal(seam[0].metadata.type, "layover_completed");
  });

  it("a COMPLETED session the traveller did NOT elect writes nothing", async () => {
    const t = stage();
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.status, "completed");
    assert.deepEqual(r.body.passportStamp, { requested: false, written: false, reason: "not_elected" });
    await settle();
    assert.equal(t.passport_stamps.length, 0);
  });

  it("an ELECTED but CANCELLED session writes nothing — nothing was completed", async () => {
    const t = stage();
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "cancelled", passportStamp: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.status, "cancelled");
    assert.deepEqual(r.body.passportStamp, { requested: true, written: false, reason: "not_completed" });
    await settle();
    assert.equal(t.passport_stamps.length, 0);
  });

  it("the default is still CANCELLED and still writes nothing", async () => {
    const t = stage();
    const r = await req("DELETE", "/api/airport/sessions/session-1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, "cancelled");
    await settle();
    assert.equal(t.passport_stamps.length, 0);
  });

  it("the kill switch still wins over the traveller's election", async () => {
    const t = stage({ stamps: false });
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed", passportStamp: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.passportStamp, { requested: true, written: false, reason: "feature_disabled" });
    await settle();
    assert.equal(t.passport_stamps.length, 0);
  });

  it("a session with no resolvable city says so rather than minting an 'Unknown' stamp", async () => {
    const t = stage({ arrived: true, sessionOver: { airport_id: null, manual_city: null, manual_iata: "ZZZ" } });
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed", passportStamp: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.passportStamp, { requested: true, written: false, reason: "no_city" });
    await settle();
    assert.equal(t.passport_stamps.length, 0);
  });
});
