/**
 * §1 (Highlights/Memories) × §3 L19 / §17 L162 (Layover) — the term BOTH lanes
 * left out, found by integrating them.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * Wave 3 produced two independent fixes for the same seam, and the merge had to
 * choose between them. It turned out not to be a choice.
 *
 * The Highlights lane gated the CREATION-time stamp on occurrence: it kept the
 * seam where it was and refused when the declared arrival was still in the
 * future (`declaredOccurrenceHasHappened`). That answers §1 — *"planned, saved,
 * or nearby must never be represented as experienced without occurrence
 * evidence or user confirmation"* — and answers neither half of L19/L162,
 * because there is still no election and it is still not post-session.
 *
 * The Layover lane deleted the creation-time seam and re-hung it on
 * `DELETE /airport/sessions/:id` behind three terms: completed, elected, flag
 * on. That answers L19's *"if the user chooses"* and §17's *"durable only when
 * the user elects"* — and DROPS the occurrence term, because nothing in
 * `endSession` is temporal. It sets `status` to whatever the caller named and
 * emits an event; it does not look at the clock:
 *
 *     .update({ status: reason, updated_at: … })
 *     .in("status", [...LAYOVER_LIVE_SESSION_STATUSES])
 *
 * So at the Layover lane's tip, this sequence mints a durable
 * `passport_stamps` row with `verification_level: 'checkin'` for a city the
 * traveller has never been to:
 *
 *     POST   /api/airport/sessions      { arrival: next Tuesday }   → 201
 *     DELETE /api/airport/sessions/:id  { completed, passportStamp } → stamp
 *
 * It is the SAME defect the Highlights lane fixed, relocated to a different
 * route — and the relocation is what hid it, because each lane's tests only
 * covered its own half.
 *
 * THE LANE'S OWN GREEN CASE DEMONSTRATES IT. `sessionRow()` in
 * `helpers/fakeLayoverDb.ts` defaults `arrival_time` to `now + 5 minutes`, so
 * "a COMPLETED session the traveller elected to keep writes exactly one stamp"
 * — which passes — is asserting that a layover which has not begun earns a
 * stamp. That fixture is corrected alongside this file: a session being closed
 * as COMPLETED whose arrival is still in the future is not a realistic
 * completion, and using it as the happy path is what made the hole invisible.
 *
 * ── WHAT IS PINNED ───────────────────────────────────────────────────────────
 * 1. FUTURE ARRIVAL + COMPLETED + ELECTED + FLAG ON → NO ROW. All three of the
 *    Layover lane's terms are satisfied; only occurrence is not. This is the
 *    case that was red before the fourth term was added.
 * 2. THE REFUSAL IS NAMED. `reason: "not_occurred"` is published like the other
 *    five, so a client is not left to infer which of six meanings "nothing was
 *    written" carries this time.
 * 3. CONTROL — a PAST arrival still earns the stamp. Without it this file would
 *    pass just as well against a seam that had been deleted outright, which is
 *    the failure mode the Highlights lane's §F.10 recorded: a green that proves
 *    only that nothing happens.
 * 4. THE BOUNDARY IS `<= now`, matching the gate's own contract, so a layover
 *    completed at the very instant of arrival is not refused by a rounding.
 *
 * Run: node --import tsx/esm --test src/test/layoverStampOccurrence.test.ts
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
const TOKEN = "occ-token";
const USER_ID = "user-1";
const HOUR = 3_600_000;

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

/** Stage a live session whose declared arrival sits at `arrivalOffsetMs` from now. */
function stage(arrivalOffsetMs: number) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "passport_stamps_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      user_id: USER_ID,
      arrival_time: new Date(now + arrivalOffsetMs).toISOString(),
      departure_time: new Date(now + arrivalOffsetMs + 8 * HOUR).toISOString(),
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

describe("§1 × L19 — completion and election are not occurrence", () => {
  it("a layover that has NOT BEGUN earns no stamp, even completed and elected with the flag on", async () => {
    const t = stage(+6 * HOUR);
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed", passportStamp: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.status, "completed", "the session still closes — only the artifact is withheld");

    await settle();
    assert.equal(
      t.passport_stamps.length, 0,
      "a durable 'checkin' stamp was minted for a city the traveller has not reached — §1: planned is not experienced",
    );
    assert.equal(r.body.passportStamp.written, false);
    assert.equal(
      r.body.passportStamp.reason, "not_occurred",
      "the refusal must be named, not folded into one of the other five meanings of 'nothing was written'",
    );
    assert.equal(r.body.passportStamp.requested, true, "the election was still made and should still be reported");
  });

  it("CONTROL — a layover that DID happen still earns exactly one stamp", async () => {
    const t = stage(-6 * HOUR);
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed", passportStamp: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.passportStamp, { requested: true, written: true, reason: "written" });

    await settle();
    assert.equal(t.passport_stamps.length, 1, JSON.stringify(t.passport_stamps));
    assert.equal(t.passport_stamps[0].city, "Taoyuan");
    assert.equal(t.passport_stamps[0].source_type, "layover_session");
  });

  it("the boundary instant counts as arrived — `<= now`, so an on-time close is not refused by a rounding", async () => {
    const t = stage(-50);
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed", passportStamp: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.passportStamp.written, true, JSON.stringify(r.body.passportStamp));
    await settle();
    assert.equal(t.passport_stamps.length, 1);
  });

  it("occurrence does not rescue a session that was never elected", async () => {
    const t = stage(-6 * HOUR);
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.passportStamp.reason, "not_elected", "the election term must still bind independently");
    await settle();
    assert.equal(t.passport_stamps.length, 0);
  });
});
