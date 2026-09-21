/**
 * census L265 — "**Notification storm** — material-change threshold +
 *                suppression/debounce"
 * census L99  — "Notify only when user action should change"
 *
 * ── THE LIVE DEFECT THIS SUITE WAS WRITTEN FOR ──────────────────────────────
 * The layover surface's only notification is a single LOCAL reminder the
 * traveller asks for by pressing "Remind me". The client schedules it 30
 * minutes before the certified hard return, records `returnReminderAt` on the
 * session, and then never looks at it again.
 *
 * `LayoverFlightChangeCard` offers `15m earlier`. Press it and the server
 * replans: the hard return deadline moves FIFTEEN MINUTES EARLIER and the
 * device's notification stays exactly where it was. The traveller now has a
 * reminder that fires fifteen minutes into the window it was meant to open —
 * and the footer still says "Reminder set", which is the part that makes it a
 * defect rather than a nuisance: the screen asserts a warning is in place at a
 * moment when it no longer is.
 *
 * The opposite direction is the storm. A `+15m` delay moves the deadline out;
 * a policy that rescheduled on ANY movement would re-notify on every small
 * edit, which is exactly what L265's "material-change threshold" exists to
 * stop. So drift below the threshold must be SUPPRESSED, not corrected.
 *
 * ── WHAT THIS DOES NOT DECIDE ───────────────────────────────────────────────
 * Nothing here sends anything, and the open owner decision
 * `LAYOVER_RETURN_REMINDER_DELIVERY` (server push vs client-local schedule) is
 * not resolved by it: `reminderDisposition` answers a question ABOUT a reminder
 * that the traveller already asked for, on whichever path delivered it. It
 * carries the §15 rung beside its answer so that the client rendering it and
 * any future server sender read one ladder.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverReminderDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reminderDisposition,
  REMINDER_MATERIAL_DRIFT_MIN,
  RETURN_ESCALATION_LADDER,
} from "../LayoverReturnEscalation.js";
import { RETURN_SOON_LEAD_MIN } from "../LayoverSafetyEngine.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
/** Four hours out — comfortably NORMAL. */
const DEADLINE = new Date(NOW + 240 * MIN);

/** The reminder the client would have scheduled against `deadline`. */
const intendedFire = (deadline: Date) => new Date(deadline.getTime() - RETURN_SOON_LEAD_MIN * MIN);

const call = (over: Partial<Parameters<typeof reminderDisposition>[0]> = {}) =>
  reminderDisposition({
    reminderAt: intendedFire(DEADLINE).toISOString(),
    hardReturnTime: DEADLINE,
    returnState: "NORMAL",
    nowMs: NOW,
    ...over,
  });

describe("L265 — the threshold, in both directions", () => {
  it("a reminder still aligned with the certified deadline is left alone", () => {
    const d = call();
    assert.equal(d.action, "keep");
    assert.equal(d.materialChange, false);
    assert.equal(d.driftMinutes, 0);
  });

  it("a drift below the threshold is SUPPRESSED — this is the storm rule", () => {
    for (const shift of [1, -1, REMINDER_MATERIAL_DRIFT_MIN - 1, -(REMINDER_MATERIAL_DRIFT_MIN - 1)]) {
      const moved = new Date(DEADLINE.getTime() + shift * MIN);
      const d = call({ hardReturnTime: moved });
      assert.equal(d.action, "keep", `a ${shift}-minute move must not re-notify`);
      assert.equal(d.materialChange, false);
      assert.equal(d.reason, "below_material_threshold");
      assert.equal(d.driftMinutes, shift);
    }
  });

  it("a delay past the threshold reschedules, and says by how much", () => {
    const moved = new Date(DEADLINE.getTime() + 60 * MIN);
    const d = call({ hardReturnTime: moved });
    assert.equal(d.action, "reschedule");
    assert.equal(d.materialChange, true);
    assert.equal(d.reason, "deadline_moved");
    assert.equal(d.driftMinutes, 60);
    assert.equal(d.firesAt, intendedFire(moved).toISOString());
    assert.equal(d.staleFiresAt, intendedFire(DEADLINE).toISOString());
  });

  it("a flight brought forward reschedules EARLIER — the defect that started this", () => {
    const moved = new Date(DEADLINE.getTime() - 15 * MIN);
    const d = call({ hardReturnTime: moved });
    assert.equal(d.action, "reschedule");
    assert.equal(d.driftMinutes, -15);
    assert.equal(
      new Date(d.firesAt!).getTime(),
      intendedFire(DEADLINE).getTime() - 15 * MIN,
      "the warning must move with the flight, not stay where it was",
    );
  });

  it("the threshold is a boundary, not a suggestion: exactly at it is material", () => {
    const d = call({ hardReturnTime: new Date(DEADLINE.getTime() + REMINDER_MATERIAL_DRIFT_MIN * MIN) });
    assert.equal(d.action, "reschedule");
    assert.equal(d.materialChange, true);
  });
});

describe("L99 — nothing is proposed when no action of the traveller's would change", () => {
  it("no reminder was ever asked for: nothing is scheduled and nothing is offered", () => {
    const d = call({ reminderAt: null });
    assert.equal(d.action, "none");
    assert.equal(d.reason, "no_reminder_scheduled");
    assert.equal(d.materialChange, false);
    assert.equal(d.firesAt, null);
  });

  it("an unparseable stored reminder is reported, not guessed at", () => {
    const d = call({ reminderAt: "not a date" });
    assert.equal(d.action, "none");
    assert.equal(d.reason, "reminder_unreadable");
    assert.equal(d.firesAt, null);
  });

  it("a reminder that has already fired and is still aligned is left alone", () => {
    // now is PAST the stored fire time, deadline still ahead.
    const d = call({ nowMs: intendedFire(DEADLINE).getTime() + 5 * MIN });
    assert.equal(d.action, "fired");
    assert.equal(d.materialChange, false);
  });

  it("a delay AFTER the reminder fired earns a new one — the warning it gave is spent", () => {
    const moved = new Date(DEADLINE.getTime() + 120 * MIN);
    const d = call({ hardReturnTime: moved, nowMs: intendedFire(DEADLINE).getTime() + 5 * MIN });
    assert.equal(d.action, "reschedule");
    assert.equal(d.reason, "deadline_moved_after_fire");
    assert.equal(d.materialChange, true);
  });
});

describe("L265/L15 — a reminder that can no longer warn anyone is cancelled, not moved", () => {
  it("the new fire time is already in the past: cancelled, with the reason", () => {
    // The flight was brought forward by nearly four hours. The deadline is
    // still TEN MINUTES AWAY — so this is not the `deadline_passed` case — but
    // the instant a 30-minute warning would have to fire is twenty minutes ago.
    const moved = new Date(NOW + 10 * MIN);
    const d = call({ hardReturnTime: moved, returnState: "RETURN_NOW" });
    assert.equal(d.action, "cancel");
    assert.equal(d.reason, "rung_already_passed");
    assert.equal(d.firesAt, null);
  });

  it("the deadline itself has passed: cancelled", () => {
    const d = call({ hardReturnTime: new Date(NOW - MIN), returnState: "CONNECTION_AT_RISK" });
    assert.equal(d.action, "cancel");
    assert.equal(d.reason, "deadline_passed");
  });
});

describe("the §15 rung travels with the answer, and is not re-derived", () => {
  it("every certified state yields its ladder rung unchanged", () => {
    for (const rung of RETURN_ESCALATION_LADDER) {
      const d = call({ returnState: rung.state });
      assert.equal(d.rung.level, rung.level, rung.state);
      assert.equal(d.rung.priority, rung.priority, rung.state);
      assert.equal(d.rung.label, rung.label, rung.state);
      assert.equal(d.rung.delivery, "not_sent_here",
        "publishing a priority must never read as having sent something");
    }
  });
});

// ── On the wire: the dashboard's own read publishes it ───────────────────────
//
// `GET /airport/sessions/:id/overview` is what `app/layover/[id].tsx` calls on
// mount and on pull-to-refresh, and it is the only read that happens after a
// flight change. If the drift is not on THAT response, no screen can act on it.

import { before, after } from "node:test";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;
const TOKEN = "reminder-drift-token";
const USER_ID = "user-1";
const SESSION_ID = "session-reminder";

function get(path: string): Promise<{ status: number; body: any }> {
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

function stageSession(returnReminderAt: string | null) {
  const now = Date.now();
  _setTestClient(
    makeLayoverDb(
      {
        feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
        airport_profiles: [airportRow()],
        layover_sessions: [sessionRow({
          id: SESSION_ID, user_id: USER_ID, status: "active",
          arrival_time: new Date(now - 60 * MIN).toISOString(),
          departure_time: new Date(now + 8 * 60 * MIN).toISOString(),
          boarding_time: null,
          return_reminder_at: returnReminderAt,
        })],
        layover_plan_stops: [], layover_recommendations: [], layover_events: [],
        trip_plan_items: [], blocks: [], profiles: [], location_preferences: [], trips: [],
      },
      { users: { [TOKEN]: USER_ID } },
    ),
    true,
  );
}

describe("GET /airport/sessions/:id/overview — the drift is on the dashboard's own read", () => {
  it("a session with no reminder publishes the `none` disposition, not an absent member", async () => {
    stageSession(null);
    const r = await get(`/api/airport/sessions/${SESSION_ID}/overview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.reminder, `no reminder disposition on the overview: ${Object.keys(r.body)}`);
    assert.equal(r.body.reminder.action, "none");
    assert.equal(r.body.reminder.reason, "no_reminder_scheduled");
  });

  it("a reminder stranded 45 minutes behind the certified deadline asks to be moved", async () => {
    // Whatever the certified deadline turns out to be for this fixture, a fire
    // time 45 minutes before the departure time is well inside the window and
    // will not line up with hardReturn − 30; the assertion is that the server
    // MEASURES the gap rather than that it is any particular size.
    const firesAt = new Date(Date.now() + 30 * MIN).toISOString();
    stageSession(firesAt);
    const r = await get(`/api/airport/sessions/${SESSION_ID}/overview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reminder.staleFiresAt, firesAt);
    assert.equal(r.body.reminder.action, "reschedule", JSON.stringify(r.body.reminder));
    assert.equal(r.body.reminder.materialChange, true);
    // The proposed instant is exactly the §15 RETURN_SOON lead before the
    // deadline this same response published — not a second derivation.
    assert.equal(
      new Date(r.body.reminder.firesAt).getTime(),
      new Date(r.body.window.hardReturnTime ?? r.body.safeReturn.hardReturnTime).getTime() - RETURN_SOON_LEAD_MIN * MIN,
    );
    assert.equal(r.body.reminder.rung.delivery, "not_sent_here");
  });
});
