/**
 * census-layover L27 (`layover_presence`), L129 (§14 "L1 opt-in intent — 5 open
 * to food") and L187 (`updatePresence(sessionId, input)`), over the real
 * airport router and `fakeLayoverDb`, asserting the STORE and the WIRE:
 *
 *   - flag OFF (production, and the seed): nothing is read or written, and
 *     the answer says the surface is off — `counts: null`, never zeros;
 *   - a traveller sharing their city may say what they are open to, until a
 *     time no later than their flight, and how far they would go;
 *   - others see COUNTS per intent among the travellers `cityPresence`
 *     already cleared (same city, opted in, not blocked, sharing not paused)
 *     — never an id, a name or a window;
 *   - every refusal is named, and a failed read is a 503, never "nobody";
 *   - the record carries no coordinate and cannot enable precise location.
 *
 * Controlled evidence only: migration 3900 is applied to no database.
 *
 * Run: node --import tsx/esm --test src/test/layoverPresenceIntents.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  PRESENCE_INTENTS,
  PRESENCE_INTENTS_FLAG,
  clearPresenceIntents,
  intentCounts,
  parsePresenceInput,
} from "../services/layover/LayoverPresenceStore.js";

let server: http.Server;
let base: string;
const TOKEN = "presence-intents-token";
const VIEWER = "user-1";
const A = "user-a", B = "user-b", C = "user-c-blocked", D = "user-d-no-record", E = "user-e-aggregate-only", F = "user-f-expired", G = "user-g-elsewhere", P = "user-p-paused";
const DEPARTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();
const HOUR = 3_600_000;

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any; raw: string }> {
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
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p, raw }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function other(id: string, userId: string, city = "Taoyuan") {
  return sessionRow({ id, user_id: userId, share_city_status: true, manual_city: city, airport_id: null, departure_time: DEPARTURE });
}
function presence(sessionId: string, userId: string, intents: string[], over: Record<string, unknown> = {}) {
  return {
    session_id: sessionId, user_id: userId, visibility_scope: "intent", intents,
    available_from: new Date(Date.now() - HOUR).toISOString(), available_until: DEPARTURE,
    max_travel_minutes: null, precise_location_enabled: false, expires_at: DEPARTURE, ...over,
  };
}

function stage(opts: { flag?: boolean; viewerShares?: boolean; viewerStatus?: string; failures?: Record<string, { message: string; code?: string }> } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      ...(opts.flag === false ? [] : [{ flag: PRESENCE_INTENTS_FLAG, enabled: true }]),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ user_id: VIEWER, share_city_status: opts.viewerShares !== false, departure_time: DEPARTURE, status: opts.viewerStatus ?? "active" }),
      other("s-a", A), other("s-b", B), other("s-c", C), other("s-d", D), other("s-e", E), other("s-f", F), other("s-g", G, "Osaka"), other("s-p", P),
    ],
    layover_presence: [
      presence("s-a", A, ["food", "nightlife"]),
      presence("s-b", B, ["food"]),
      presence("s-c", C, ["food"]),
      presence("s-e", E, ["food"], { visibility_scope: "aggregate" }),
      presence("s-f", F, ["food"], { available_until: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString(), available_from: new Date(Date.now() - 2 * HOUR).toISOString() }),
      presence("s-g", G, ["food"]),
      presence("s-p", P, ["food"]),
    ],
    blocks: [{ blocker_id: VIEWER, blocked_id: C }],
    location_preferences: [{ user_id: P, location_mode: "city_only", sharing_paused: true }],
    trip_crew_location_preferences: [],
    profiles: [], layover_events: [], layover_plan_stops: [], layover_recommendations: [], trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: VIEWER }, failures: opts.failures }), true);
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

const I = "/api/airport/sessions/session-1/presence/intents";

describe("flag OFF — production today", () => {
  it("GET says the surface is off: counts null, never zeros", async () => {
    stage({ flag: false });
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { ok: true, available: false, own: null, counts: null });
  });
  it("PUT is refused and nothing is written", async () => {
    const t = stage({ flag: false });
    const before = t.layover_presence.length;
    const r = await req("PUT", I, { intents: ["food"] });
    assert.equal(r.body.error, "feature_disabled", r.raw);
    assert.equal(t.layover_presence.length, before);
  });
  it("the overview tells the client the surface is off", async () => {
    stage({ flag: false });
    const r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, r.raw.slice(0, 300));
    assert.equal(r.body.share.intentsEnabled, false);
  });
});

describe("flag ON — the traveller's own record", () => {
  it("PUT stores the intents, sorted and de-duplicated, open until the flight by default, with no coordinate and precise location off", async () => {
    const t = stage();
    const r = await req("PUT", I, { intents: ["culture", "food", "food"], maxTravelMinutes: 30 });
    assert.equal(r.status, 200, r.raw);
    const row = t.layover_presence.find((x) => x.session_id === "session-1");
    assert.ok(row, "no presence row was written");
    assert.deepEqual(row.intents, ["food", "culture"]);
    assert.equal(row.user_id, VIEWER);
    assert.equal(row.visibility_scope, "intent");
    assert.equal(Date.parse(row.available_until), Date.parse(DEPARTURE));
    assert.equal(row.expires_at, row.available_until);
    assert.equal(row.max_travel_minutes, 30);
    assert.strictEqual(row.precise_location_enabled, false);
    for (const k of Object.keys(row)) assert.ok(!/(^|_)(lat|lng|lon|latitude|longitude|geom|point)($|_)/i.test(k), `coordinate column: ${k}`);
    assert.deepEqual(r.body.own.intents, ["food", "culture"]);
  });

  it("a second PUT replaces the record (one per session); DELETE removes it", async () => {
    const t = stage();
    await req("PUT", I, { intents: ["food"] });
    await req("PUT", I, { intents: ["shopping"] });
    assert.equal(t.layover_presence.filter((x) => x.session_id === "session-1").length, 1);
    assert.deepEqual(t.layover_presence.find((x) => x.session_id === "session-1").intents, ["shopping"]);
    const del = await req("DELETE", I);
    assert.equal(del.status, 200, del.raw);
    assert.equal(t.layover_presence.filter((x) => x.session_id === "session-1").length, 0);
  });

  it("the overview tells the client the surface is on", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.body.share.intentsEnabled, true);
  });
});

describe("flag ON — what others see: counts, never people", () => {
  it("counts only cleared travellers: same city, not blocked, sharing not paused, window still open", async () => {
    stage();
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.available, true);
    // A (food, nightlife) + B (food). Excluded: C blocked, E aggregate-only, F expired, G other city, P paused, D no record.
    assert.deepEqual(r.body.counts, { food: 2, nightlife: 1, shopping: 0, culture: 0, meetups: 0 });
  });

  it("no other traveller's id, session or window reaches the wire", async () => {
    stage();
    const r = await req("GET", I);
    for (const id of [A, B, C, D, E, F, G, P, "s-a", "s-b", "s-c", "s-e", "s-g", "s-p"]) assert.ok(!r.raw.includes(id), `leaked ${id}`);
    assert.ok(!r.raw.includes("available_until") && !r.raw.includes("max_travel"), r.raw);
  });

  it("a traveller not sharing sees no counts (the reciprocity rule of GET /:id/presence)", async () => {
    stage({ viewerShares: false });
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "sharing_off");
  });
});

describe("refusals are named; a failed read is a refusal, never 'nobody'", () => {
  it("PUT while not sharing the city: 409 sharing_off, nothing written", async () => {
    const t = stage({ viewerShares: false });
    const r = await req("PUT", I, { intents: ["food"] });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.reason, "sharing_off");
    assert.ok(!t.layover_presence.some((x) => x.session_id === "session-1"));
  });
  for (const [label, body, reason] of [
    ["an unknown intent", { intents: ["food", "partying"] }, "intents_invalid"],
    ["a 'rest' intent (not shared: resting is not being open)", { intents: ["rest"] }, "intents_invalid"],
    ["a window past the flight", { intents: ["food"], availableUntil: new Date(Date.parse(DEPARTURE) + 60_000).toISOString() }, "available_until_past_departure"],
    ["a window already over", { intents: ["food"], availableUntil: new Date(Date.now() - 60_000).toISOString() }, "available_until_not_in_future"],
    ["a zero travel time", { intents: ["food"], maxTravelMinutes: 0 }, "max_travel_invalid"],
    ["no intents list", { maxTravelMinutes: 20 }, "intents_invalid"],
  ] as const) {
    it(`PUT with ${label}: 400 ${reason}`, async () => {
      const t = stage();
      const r = await req("PUT", I, body);
      assert.equal(r.status, 400, r.raw);
      assert.equal(r.body.reason, reason);
      assert.ok(!t.layover_presence.some((x) => x.session_id === "session-1"));
    });
  }
  it("an ended layover takes no intents", async () => {
    stage({ viewerStatus: "completed" });
    const r = await req("PUT", I, { intents: ["food"] });
    assert.equal(r.status, 409, r.raw);
  });
  it("an unreadable presence table is 503 — not 'you have none' and not 'nobody is open'", async () => {
    stage({ failures: { "layover_presence:select": { message: "boom" } } });
    const r = await req("GET", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
  });
  it("a failed write is 503 and stores nothing", async () => {
    const t = stage({ failures: { "layover_presence:upsert": { message: "boom" } } });
    const r = await req("PUT", I, { intents: ["food"] });
    assert.equal(r.status, 503, r.raw);
    assert.ok(!t.layover_presence.some((x) => x.session_id === "session-1"));
  });
});

describe("the pure parts", () => {
  it("the vocabulary is migration 3900's CHECK, in order", () => {
    assert.deepEqual([...PRESENCE_INTENTS], ["food", "nightlife", "shopping", "culture", "meetups"]);
  });
  it("a traveller with two sessions counts once per intent", async () => {
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: PRESENCE_INTENTS_FLAG, enabled: true }],
      // Different windows, so the two rows differ in everything but the traveller: only a per-USER count gives 1.
      layover_presence: [presence("x1", A, ["food"]), presence("x2", A, ["food", "culture"], { available_from: new Date(Date.now() - 2 * HOUR).toISOString() })],
    };
    const r = await intentCounts(makeLayoverDb(tables) as any, [A], Date.now());
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.counts.food, 1);
    assert.equal(r.counts.culture, 1);
  });
  it("the traveller's own record: an unreadable table is read_failed, never 'none'", async () => {
    const { readOwnPresence } = await import("../services/layover/LayoverPresenceStore.js");
    const tables: Record<string, any[]> = { feature_flags: [{ flag: PRESENCE_INTENTS_FLAG, enabled: true }], layover_presence: [] };
    const r = await readOwnPresence(makeLayoverDb(tables, { failures: { "layover_presence:select": { message: "boom" } } }) as any, "x1", Date.now());
    assert.deepEqual(r, { ok: false, reason: "read_failed" });
    const none = await readOwnPresence(makeLayoverDb(tables) as any, "x1", Date.now());
    assert.deepEqual(none, { ok: true, record: null });
  });
  it("a window that has not opened yet is not counted", async () => {
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: PRESENCE_INTENTS_FLAG, enabled: true }],
      layover_presence: [presence("x1", A, ["food"], { available_from: new Date(Date.now() + HOUR).toISOString() })],
    };
    const r = await intentCounts(makeLayoverDb(tables) as any, [A], Date.now());
    assert.ok(r.ok && r.counts.food === 0);
  });
  it("parsePresenceInput defaults the window to the departure and refuses non-integers", () => {
    const now = Date.now();
    const ok = parsePresenceInput({ intents: ["food"] }, { departureTime: DEPARTURE }, now);
    assert.ok(ok.ok && Date.parse(ok.value.availableUntil) === Date.parse(DEPARTURE));
    const bad = parsePresenceInput({ intents: ["food"], maxTravelMinutes: 12.5 }, { departureTime: DEPARTURE }, now);
    assert.ok(!bad.ok && bad.error === "max_travel_invalid");
  });
});

// ── each read and write answers for itself ───────────────────────────────────
// The route reads `layover_presence` twice on GET: the traveller's own record,
// then the counts. One failure-injected table fails BOTH, which cannot tell
// which refusal fired. `failNthPresenceCall` fails exactly one of them.
function failNthPresenceCall(tables: Record<string, Record<string, unknown>[]>, n: number) {
  const db = makeLayoverDb(tables, { users: { [TOKEN]: VIEWER } });
  const failing = makeLayoverDb({ layover_presence: [] }, { failures: { "layover_presence:select": { message: "boom" } } });
  const realFrom = db.from;
  let calls = 0;
  db.from = (t: string) => {
    if (t !== "layover_presence") return realFrom(t);
    calls += 1;
    return calls === n ? failing.from(t) : realFrom(t);
  };
  _setTestClient(db, true);
  return () => calls;
}

describe("each read answers for itself — a failure is never 'nobody' or 'none'", () => {
  it("the OWN record unreadable while the counts would read: 503, and no counts are served", async () => {
    const t = stage();
    const calls = failNthPresenceCall(t, 1);
    const r = await req("GET", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.counts, undefined, r.raw);
    assert.equal(calls(), 1, "the counts were read after the own record failed");
  });

  it("the COUNTS unreadable while the own record reads: 503 — not five zeros", async () => {
    const t = stage();
    const calls = failNthPresenceCall(t, 2);
    const r = await req("GET", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(calls(), 2);
  });

  it("who else is here unreadable (blocks): 503 — an outage is not an empty city", async () => {
    stage({ failures: { "blocks:select": { message: "boom" } } });
    const r = await req("GET", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("a failed DELETE is 503 and the record still stands", async () => {
    const t = stage({ failures: { "layover_presence:delete": { message: "boom" } } });
    t.layover_presence.push(presence("session-1", VIEWER, ["food"]));
    const r = await req("DELETE", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.ok(t.layover_presence.some((x) => x.session_id === "session-1"));
  });

  it("the traveller's own record never counts toward what THEY see", async () => {
    const t = stage();
    t.layover_presence.push(presence("session-1", VIEWER, ["food", "shopping"]));
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.own.intents, ["food", "shopping"]);
    assert.deepEqual(r.body.counts, { food: 2, nightlife: 1, shopping: 0, culture: 0, meetups: 0 });
  });

  it("an expired own record reads as none", async () => {
    const t = stage();
    const past = new Date(Date.now() - 60_000).toISOString();
    t.layover_presence.push(presence("session-1", VIEWER, ["food"], { available_from: new Date(Date.now() - 2 * HOUR).toISOString(), available_until: past, expires_at: past }));
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.own, null);
  });

  it("flag OFF: the counts and the delete read and write nothing, and say why", async () => {
    const tables: Record<string, Record<string, unknown>[]> = { feature_flags: [], layover_presence: [presence("x1", A, ["food"])] };
    const db = makeLayoverDb(tables);
    let touched = 0;
    const realFrom = db.from;
    db.from = (t: string) => { if (t === "layover_presence") touched += 1; return realFrom(t); };
    assert.deepEqual(await intentCounts(db, [A], Date.now()), { ok: false, reason: "intents_disabled" });
    assert.deepEqual(await clearPresenceIntents(db, "x1"), { ok: false, reason: "intents_disabled" });
    assert.equal(touched, 0);
    assert.equal(tables.layover_presence.length, 1);
  });
});
