/**
 * census L18 — "**Safe Return** owns escalation, return-state UX, **notification
 * priority**; must not recompute core feasibility."
 *
 * The `W` sentence names two gaps and one holding boundary:
 *   holds   — `shouldSuggestSafeReturn` recomputes nothing.
 *   missing — there is **no escalation ladder** and **no notification priority**.
 *
 * §13/§17 built `safeReturnPosture`, which is the escalation LADDER's
 * consequences (what the surface must do at each rung). The second gap was
 * untouched: nothing anywhere in the layover surface carried a notification
 * priority, so the four §15 rungs were indistinguishable to the one pipeline
 * that decides whether a message reaches a traveller at all. A RETURN_NOW
 * deadline and a NORMAL nudge were the same message to
 * `NotificationPreferenceService.filterChannels`, which means a traveller with
 * quiet hours on got NEITHER.
 *
 * This suite is about that: the rung must carry a priority out of the app's own
 * `NotificationPriority` vocabulary, and it is asserted THROUGH the real
 * preference service rather than by comparing strings — the question is not
 * "does it say urgent", it is "does the message actually survive quiet hours".
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverReturnEscalation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import {
  RETURN_ESCALATION_LADDER,
  returnEscalationRung,
  ESCALATION_LEVELS,
} from "../LayoverReturnEscalation.js";
import { safeReturnPosture } from "../LayoverSafeReturnService.js";
import { certifySessionFeasibility } from "../LayoverFeasibility.js";
import { NotificationPreferenceService } from "../../notifications/NotificationPreferenceService.js";
import type { LayoverReturnState } from "../LayoverSafetyEngine.js";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";

const STATES: LayoverReturnState[] = ["NORMAL", "RETURN_SOON", "RETURN_NOW", "CONNECTION_AT_RISK"];
const PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, important: 2, urgent: 3 };

describe("§15 escalation ladder — total, ordered, and owned by Safe Return", () => {
  it("every §15 state has a rung; the ladder has no extra rungs", () => {
    assert.deepEqual(RETURN_ESCALATION_LADDER.map((r) => r.state), STATES);
    for (const s of STATES) assert.ok(returnEscalationRung(s), `no rung for ${s}`);
  });

  it("level is strictly increasing and priority never steps back down the ladder", () => {
    let lastLevel = -1;
    let lastPriority = -1;
    for (const state of STATES) {
      const rung = returnEscalationRung(state);
      assert.ok(rung.level > lastLevel, `${state}: level ${rung.level} did not increase past ${lastLevel}`);
      const rank = PRIORITY_RANK[rung.priority];
      assert.ok(rank !== undefined, `${state}: ${rung.priority} is not a NotificationPriority`);
      assert.ok(rank >= lastPriority, `${state}: priority ${rung.priority} is calmer than the rung below it`);
      lastLevel = rung.level;
      lastPriority = rank;
    }
    assert.deepEqual(ESCALATION_LEVELS, [0, 1, 2, 3]);
  });

  it("the ladder does not recompute feasibility — it reads a certified state", () => {
    const src = readFileSync(new URL("../LayoverReturnEscalation.ts", import.meta.url), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*(import|}\s*from)/.test(l) || /from "/.test(l));
    for (const banned of ["computeReturnDeadline", "computeWindow", "computeBuffer", "certifySessionFeasibility", "assess"]) {
      assert.ok(
        !importLines.some((l) => l.includes(banned)),
        `L18's "must not recompute core feasibility" — this module imports ${banned}`,
      );
    }
  });
});

describe("the priority is the app's own, measured through the pipeline that uses it", () => {
  const prefs = {
    userId: "u", pushEnabled: true, emailEnabled: false, inAppEnabled: true,
    smsEnabled: false, safetyOverride: true,
    quietHoursEnabled: true, quietStart: "00:00", quietEnd: "23:59", quietTimezone: null,
  } as any;

  /**
   * STRENGTHENED BY THE §20 MUTATION PASS. This test previously passed
   * `[...rung.channels]` — and the NORMAL rung asks for `in_app` only, so the
   * assertion "push was dropped" held for a reason that had nothing to do with
   * the priority: there was no push to drop. Mutating NORMAL's priority from
   * `low` to `urgent` left it GREEN, which means it did not test the thing its
   * own name claims.
   *
   * The claim is about the PRIORITY, so the push is requested explicitly and
   * only the rung's priority is allowed to decide. `filterChannels` drops it
   * unless `priority === "urgent"`, so this now goes red the moment a calm rung
   * is given an override it has not earned.
   */
  it("a NORMAL-rung priority does not buy a push through quiet hours", () => {
    const svc = new NotificationPreferenceService(null as any);
    const rung = returnEscalationRung("NORMAL");
    assert.equal(rung.piercesQuietHours, false, "the rung must not claim to pierce");
    const out = svc.filterChannels(["in_app", "push"], prefs, undefined, rung.priority, "airport");
    assert.ok(!out.includes("push"), "a calm nudge must not wake a traveller at 03:00");
  });

  it("a RETURN_SOON-rung priority does not buy one either — only the top two rungs do", () => {
    const svc = new NotificationPreferenceService(null as any);
    const rung = returnEscalationRung("RETURN_SOON");
    assert.equal(rung.piercesQuietHours, false);
    const out = svc.filterChannels(["in_app", "push"], prefs, undefined, rung.priority, "airport");
    assert.ok(!out.includes("push"), "a thirty-minute warning must not spend the override");
  });

  it("a RETURN_NOW-rung push survives quiet hours — this is the whole point of the priority", () => {
    const svc = new NotificationPreferenceService(null as any);
    const rung = returnEscalationRung("RETURN_NOW");
    assert.ok(rung.channels.includes("push"), "RETURN_NOW must at least ask for push");
    const out = svc.filterChannels([...rung.channels], prefs, undefined, rung.priority, "airport");
    assert.ok(out.includes("push"), "a traveller who must leave NOW is not told 'quiet hours'");
  });

  it("CONNECTION_AT_RISK survives too", () => {
    const svc = new NotificationPreferenceService(null as any);
    const rung = returnEscalationRung("CONNECTION_AT_RISK");
    const out = svc.filterChannels([...rung.channels], prefs, undefined, rung.priority, "airport");
    assert.ok(out.includes("push"));
  });
});

describe("the priority is REACHABLE — it rides the posture every session response already carries", () => {
  const airport = {
    id: "ap-1", iataCode: "TPE", name: "Taoyuan", city: "Taipei", country: "Taiwan",
    countryCode: "TW", timezone: "Asia/Taipei", lat: 25.08, lng: 121.23, verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
    checkedBagsExtraMin: 15, trafficExtraMin: 20,
  } as any;

  const sessionAt = (minutesToDeparture: number) => ({
    id: "s1", userId: "u1", airportId: "ap-1", tripId: null,
    arrivalTime: new Date(Date.now() - 3_600_000).toISOString(),
    departureTime: new Date(Date.now() + minutesToDeparture * 60_000).toISOString(),
    boardingTime: null, layoverMinutes: 300, flightType: "international",
    immigrationRequired: true, checkedBags: false, loungeAccess: false, wantsToLeave: true,
    comfortLevel: "moderate", vibeChips: [], manualAirportName: null, manualCity: null,
    manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false,
    returnReminderAt: null, status: "active", createdAt: "", updatedAt: "",
  }) as any;

  it("a calm session's posture carries the calm rung", () => {
    const record = certifySessionFeasibility(airport, sessionAt(600), { nowMs: Date.now() });
    const posture = safeReturnPosture(record);
    assert.equal(posture.returnState, "NORMAL");
    assert.equal(posture.notification.priority, returnEscalationRung("NORMAL").priority);
    assert.equal(posture.notification.level, 0);
  });

  it("a session past its hard return carries the urgent rung, on the same posture object", () => {
    const record = certifySessionFeasibility(airport, sessionAt(100), { nowMs: Date.now() });
    const posture = safeReturnPosture(record);
    assert.ok(posture.returnState === "RETURN_NOW" || posture.returnState === "CONNECTION_AT_RISK",
      `expected an escalated state, got ${posture.returnState}`);
    assert.equal(posture.notification.priority, "urgent");
    assert.ok(posture.notification.level >= 2);
  });
});

// ── The wire ─────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;
const TOKEN = "escalation-token";
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

describe("GET /airport/sessions/:id/overview publishes the rung", () => {
  it("safeReturn.notification names a priority, a level and the channels the rung asks for", async () => {
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({ user_id: USER_ID })],
      layover_events: [], layover_plan_stops: [], trip_plan_items: [],
    };
    _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
    const r = await req("/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const n = r.body?.safeReturn?.notification;
    assert.ok(n, "the posture the dashboard already reads must carry the rung");
    assert.ok(PRIORITY_RANK[n.priority] !== undefined, `not a NotificationPriority: ${n.priority}`);
    assert.ok(Array.isArray(n.channels) && n.channels.length > 0);
    assert.equal(typeof n.level, "number");
  });
});
