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
  PRESENCE_INTENT_MIN_K, discloseIntentCounts,
  clearPresenceIntents,
  intentCounts,
  parsePresenceInput,
  _resetIntentCountSnapshots, _setIntentSnapshotClock, PRESENCE_INTENT_SNAPSHOT_MS,
  _setSnapshotCapForTest, cityPopulationSnapshot, emptyIntentCounts,
} from "../services/layover/LayoverPresenceStore.js";
import { readFileSync } from "node:fs";

let server: http.Server;
let base: string;
const TOKEN = "presence-intents-token";
const VIEWER = "user-1";
const A = "user-a", B = "user-b", C = "user-c-blocked", D = "user-d-no-record", E = "user-e-aggregate-only", F = "user-f-expired", G = "user-g-elsewhere", P = "user-p-paused";
// D-PRESENCE-K (k = 5): four more sharing travellers, so the base counts sit AT
// and ABOVE the minimum. D-PRESENCE-K-2 (2026-10-07) makes the count the SAME
// for every viewer, so C — whom the viewer blocked — is counted like anyone:
// food 7 (A, B, C, Q1-Q4), nightlife 5 (A, Q1-Q4); every exclusion below is
// still visible as a count of 8.
const Q = ["user-q1", "user-q2", "user-q3", "user-q4"] as const;
/** What the base fixture discloses: food 7, nightlife 5, and three intents below k (zero) withheld. */
const BASE_DISCLOSED = { food: 7, nightlife: 5, shopping: null, culture: null, meetups: null };
const DEPARTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();
const HOUR = 3_600_000;

function req(method: string, path: string, body?: any, token: string = TOKEN): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
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

function stage(opts: { flag?: boolean; ladder?: boolean | null; viewerShares?: boolean; viewerStatus?: string; failures?: Record<string, { message: string; code?: string }> } = {}) {
  // D-PRESENCE-K-3 rule 4: counts are one snapshot per city per hour, held in
  // the process. Each staged world starts with none, on the real clock.
  _resetIntentCountSnapshots();
  _setIntentSnapshotClock(null);
  _setSnapshotCapForTest(null);
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      ...(opts.flag === false ? [] : [{ flag: PRESENCE_INTENTS_FLAG, enabled: true }]),
      // D-PRESENCE-K rule 2: counts need the aggregate-only presence surface.
      ...(opts.ladder === null ? [] : [{ flag: "layover_presence_ladder_enabled", enabled: opts.ladder !== false }]),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ user_id: VIEWER, share_city_status: opts.viewerShares !== false, departure_time: DEPARTURE, status: opts.viewerStatus ?? "active" }),
      other("s-a", A), other("s-b", B), other("s-c", C), other("s-d", D), other("s-e", E), other("s-f", F), other("s-g", G, "Osaka"), other("s-p", P),
      ...Q.map((q) => other(`s-${q}`, q)),
    ],
    layover_presence: [
      presence("s-a", A, ["food", "nightlife"]),
      presence("s-b", B, ["food"]),
      presence("s-c", C, ["food"]),
      presence("s-e", E, ["food"], { visibility_scope: "aggregate" }),
      presence("s-f", F, ["food"], { available_until: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString(), available_from: new Date(Date.now() - 2 * HOUR).toISOString() }),
      presence("s-g", G, ["food"]),
      presence("s-p", P, ["food"]),
      ...Q.map((q) => presence(`s-${q}`, q, ["food", "nightlife"])),
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
  // RESTATED 2026-10-07 under D-PRESENCE-K-2: the population no longer depends on
  // the viewer, so a block relation changes no number (C is counted). A block
  // that changed the count would let a viewer learn the blocked person's intents
  // by blocking them; one that withheld it would tell them that person is here.
  it("counts the city's sharing travellers whose window is open — the same for every viewer, a block included", async () => {
    stage();
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.available, true);
    // A (food, nightlife) + B (food) + C (food; blocked by the viewer, counted) + Q1-Q4 (both). Excluded: E aggregate-only, F expired,
    // G other city, P paused, D no record — any one of them counted makes food 8. Shopping, culture and meetups are zero: withheld.
    assert.deepEqual(r.body.counts, BASE_DISCLOSED);
    assert.equal(r.body.minimumCount, 5);
  });

  it("no other traveller's id, session or window reaches the wire", async () => {
    stage();
    const r = await req("GET", I);
    for (const id of [A, B, C, D, E, F, G, P, ...Q, "s-a", "s-b", "s-c", "s-e", "s-g", "s-p"]) assert.ok(!r.raw.includes(id), `leaked ${id}`);
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

  // RESTATED under D-PRESENCE-K-2: the intents read no longer reads blocks (the
  // count is viewer-invariant); the population's own consent read is the one
  // whose failure must not become an empty city.
  it("who else is here unreadable (sharing preferences): 503 — an outage is not an empty city", async () => {
    // Fail ONLY the population's consent read (publishableUserIds asks with
    // `.in("user_id", …)`); the viewer's own sharing gate reads the same table
    // by `.eq` and must still pass, or this would test the gate instead.
    const t = stage();
    const db = makeLayoverDb(t, { users: { [TOKEN]: VIEWER } });
    const realFrom = db.from.bind(db);
    db.from = (name: string) => {
      const b = realFrom(name);
      if (name !== "location_preferences") return b;
      b.in = () => ({ then: (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "boom" } }) });
      return b;
    };
    _setTestClient(db, true);
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

  // RESTATED under D-PRESENCE-K-2: the number is the same for every viewer, so
  // the viewer's own record counts like anyone's. Leaving themselves out made
  // the number differ by viewer; it told nobody anything, but "the same for
  // every viewer" is the property the ruling asks for, and it is checkable.
  it("the traveller's own record counts like anyone's: the number is the same for every viewer", async () => {
    const t = stage();
    t.layover_presence.push(presence("session-1", VIEWER, ["food", "shopping"]));
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.own.intents, ["food", "shopping"]);
    // V-R6 R6-1: the fake now resolves the airport_profiles(city) embed, so the
    // viewer's airport-backed Taoyuan session IS in the city population, as in
    // production, and their own food counts: 7 -> 8. Shopping (1) stays under k.
    assert.deepEqual(r.body.counts, { ...BASE_DISCLOSED, food: 8 });
  });

  // RESTATED under D-PRESENCE-K-2: the viewer is in the city population (a
  // manual-city session here) and counts ONCE per intent, like anyone with two
  // records.
  it("the viewer in the city population counts once per intent, however many records", async () => {
    const t = stage();
    t.layover_sessions.push(other("s-v2", VIEWER));
    t.layover_presence.push(presence("s-v2", VIEWER, ["food"]));
    t.layover_presence.push(presence("session-1", VIEWER, ["food"]));
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.counts.food, 8, `the viewer must count once: ${r.raw}`);
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

// ── D-PRESENCE-K (lead ruling 2026-10-06): k = 5, no count beside a roster ──

describe("D-PRESENCE-K — a count below 5 is never shown, and never beside a roster", () => {
  it("a count of 4 is withheld and a count of exactly 5 is shown (the threshold is k = 5)", async () => {
    const t = stage();
    t.layover_presence = t.layover_presence.filter((x) => x.user_id !== "user-q4" && x.user_id !== C);
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.counts, { food: 5, nightlife: null, shopping: null, culture: null, meetups: null });
    assert.equal(PRESENCE_INTENT_MIN_K, 5);
  });

  it("§52.1's probe P4 — ONE cleared traveller: nothing about them is shown, not even a zero", async () => {
    const t = stage();
    t.layover_presence = t.layover_presence.filter((x) => x.user_id === A);
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.counts, { food: null, nightlife: null, shopping: null, culture: null, meetups: null });
  });

  it("the presence ladder OFF (a named roster is served): counts withheld whole, and nobody else's record is read", async () => {
    const t = stage({ ladder: false });
    const db = makeLayoverDb(t, { users: { [TOKEN]: VIEWER } });
    const realFrom = db.from;
    let presenceReads = 0;
    db.from = (name: string) => { if (name === "layover_presence") presenceReads += 1; return realFrom(name); };
    _setTestClient(db, true);
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "roster_visible");
    assert.equal(presenceReads, 1, "only the traveller's own record may be read");
  });

  it("the ladder flag ABSENT reads as off: withheld", async () => {
    stage({ ladder: null });
    const r = await req("GET", I);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "roster_visible");
  });

  // RESTATED 2026-10-07 under D-PRESENCE-K-2 (verifier F1 on ab67f861bb): a
  // crewmate in the counted population is no longer SUBTRACTED — that made the
  // count a per-viewer differencing oracle — the counts are WITHHELD whole.
  it("a member of the viewer's LAYOVER CREW (named to them) is counted: the counts are withheld WHOLE, never reduced", async () => {
    const t = stage();
    const later = new Date(Date.now() + 3 * HOUR).toISOString();
    t.layover_crews = [{ id: "crew-1", city: "Taoyuan", airport_ref: null, created_by: VIEWER, created_session_id: "session-1", title: "Night market", meeting_point_label: null, status: "open", max_members: 6, expires_at: later, created_at: new Date().toISOString() }];
    t.layover_crew_members = [
      { crew_id: "crew-1", user_id: VIEWER, session_id: "session-1", role: "owner", joined_at: new Date().toISOString(), left_at: null },
      { crew_id: "crew-1", user_id: "user-q1", session_id: "s-user-q1", role: "member", joined_at: new Date().toISOString(), left_at: null },
    ];
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "roster_visible");
  });

  it("an accepted member of the layover's TRIP (named to them) in the population: withheld whole", async () => {
    const t = stage();
    t.layover_sessions[0].trip_id = "trip-1";
    t.trips = [{ id: "trip-1", owner_id: VIEWER }];
    t.trip_members = [{ trip_id: "trip-1", user_id: "user-q2", role: "member", status: "accepted" }];
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "roster_visible");
  });

  // REPLACED 2026-10-07 under D-PRESENCE-K-3 (fourth verification, F1). The case
  // here pinned "a named person OUTSIDE the counted population withholds
  // nothing" — which made the withholding bit report whether a named crewmate
  // was sharing their city. Under K-3 a non-empty roster withholds, whoever is
  // counted; this is the verifier's sharing-flip probe, and it shows no change.
  it("the verifier's sharing-flip probe: a named crewmate turning city sharing ON changes nothing either viewer can read", async () => {
    const t = stage();
    const V2 = "user-v2", TOKEN2 = "presence-intents-token-2";
    // The snapshot is computed AT its clock, so the clock starts at the real now
    // (a past instant would count the fixture's already-expired traveller F).
    const NOW0 = Date.now();
    const HOUR0 = Math.floor(NOW0 / PRESENCE_INTENT_SNAPSHOT_MS) * PRESENCE_INTENT_SNAPSHOT_MS;
    let clock = NOW0;
    _setIntentSnapshotClock(() => clock);
    // A is the viewer's crewmate and is NOT sharing their city yet.
    const later = new Date(Date.now() + 3 * HOUR).toISOString(), now = new Date().toISOString();
    t.layover_crews = [{ id: "crew-a", city: "taoyuan", airport_ref: null, created_by: A, created_session_id: "s-a", title: "Night market", meeting_point_label: null, status: "open", max_members: 6, expires_at: later, created_at: now }];
    t.layover_crew_members = [
      { crew_id: "crew-a", user_id: A, session_id: "s-a", role: "owner", joined_at: now, left_at: null },
      { crew_id: "crew-a", user_id: VIEWER, session_id: "session-1", role: "member", joined_at: now, left_at: null },
    ];
    const sA = t.layover_sessions.find((x: any) => x.id === "s-a");
    sA.share_city_status = false;
    // V2 shares the city, names nobody, and is the second account of the probe.
    t.layover_sessions.push(sessionRow({ id: "session-2", user_id: V2, share_city_status: true, departure_time: DEPARTURE }));
    _setTestClient(makeLayoverDb(t, { users: { [TOKEN]: VIEWER, [TOKEN2]: V2 } }), true);

    const x1 = await req("GET", I);
    const y1 = await req("GET", "/api/airport/sessions/session-2/presence/intents", undefined, TOKEN2);
    sA.share_city_status = true; // the flip
    const x2 = await req("GET", I);
    const y2 = await req("GET", "/api/airport/sessions/session-2/presence/intents", undefined, TOKEN2);

    // The crewmate's viewer: withheld before AND after — the bit is the roster, not A's sharing.
    for (const r of [x1, x2]) {
      assert.equal(r.status, 200, r.raw);
      assert.strictEqual(r.body.counts, null);
      assert.equal(r.body.countsWithheld, "roster_visible");
    }
    // The second account: the SAME snapshot before and after, within the hour.
    assert.equal(y1.status, 200, y1.raw);
    assert.deepEqual(y2.body.counts, y1.body.counts, `the flip moved the count inside the hour: ${y1.raw} -> ${y2.raw}`);
    assert.equal(y2.body.countsAsOf, y1.body.countsAsOf);
    // The change shows only at the next hour, folded into that hour's snapshot.
    clock = HOUR0 + PRESENCE_INTENT_SNAPSHOT_MS + 1_000;
    const y3 = await req("GET", "/api/airport/sessions/session-2/presence/intents", undefined, TOKEN2);
    assert.notEqual(y3.body.countsAsOf, y1.body.countsAsOf);
    assert.equal(y3.body.counts.food, y1.body.counts.food + 1, "A is counted from the next snapshot on");
  });

  it("the count is a SNAPSHOT: a traveller arriving inside the hour moves nothing until the next hour", async () => {
    const t = stage();
    const NOW0 = Date.now();
    const HOUR0 = Math.floor(NOW0 / PRESENCE_INTENT_SNAPSHOT_MS) * PRESENCE_INTENT_SNAPSHOT_MS;
    let clock = NOW0; // computed AT the clock: never a past instant (see the probe above)
    _setIntentSnapshotClock(() => clock);
    const first = await req("GET", I);
    assert.deepEqual(first.body.counts, BASE_DISCLOSED);
    assert.equal(first.body.refreshMinutes, 60);
    t.layover_sessions.push(other("s-new", "user-new"));
    t.layover_presence.push(presence("s-new", "user-new", ["food"]));
    clock = HOUR0 + PRESENCE_INTENT_SNAPSHOT_MS - 1; // the last millisecond of the same hour
    assert.deepEqual((await req("GET", I)).body.counts, BASE_DISCLOSED, "inside the hour the snapshot does not move");
    clock = HOUR0 + PRESENCE_INTENT_SNAPSHOT_MS; // the next hour
    assert.equal((await req("GET", I)).body.counts.food, 8);
  });

  it("a trip crew with another accepted member withholds WHOLE — wherever that member is (not in the population)", async () => {
    const t = stage();
    t.layover_sessions[0].trip_id = "trip-1";
    t.trips = [{ id: "trip-1", owner_id: VIEWER }];
    t.trip_members = [{ trip_id: "trip-1", user_id: G, role: "member", status: "accepted" }];
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "roster_visible");
  });

  it("CONTROL: rosters that name nobody else — a solo trip, a crew the viewer is alone in — withhold nothing", async () => {
    const t = stage();
    t.layover_sessions[0].trip_id = "trip-1";
    t.trips = [{ id: "trip-1", owner_id: VIEWER }];
    t.trip_members = [];
    const later = new Date(Date.now() + 3 * HOUR).toISOString(), now = new Date().toISOString();
    t.layover_crews = [{ id: "crew-v", city: "taoyuan", airport_ref: null, created_by: VIEWER, created_session_id: "session-1", title: "Coffee", meeting_point_label: null, status: "open", max_members: 6, expires_at: later, created_at: now }];
    t.layover_crew_members = [{ crew_id: "crew-v", user_id: VIEWER, session_id: "session-1", role: "owner", joined_at: now, left_at: null }];
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.counts, BASE_DISCLOSED);
  });

  it("a BUDDY anywhere on the city's roster withholds whole, counted or not", async () => {
    const t = stage();
    t.rent_buddy_profiles = [{ id: "b-2", user_id: "user-local-guide", display_name: "Guide", city: "Taoyuan", status: "active" }];
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "roster_visible");
  });

  it("a BUDDY profile in the city whose owner is in the population: withheld whole (the buddy roster names them)", async () => {
    const t = stage();
    t.rent_buddy_profiles = [{ id: "b-1", user_id: "user-q3", display_name: "Q3", city: "Taoyuan", status: "active" }];
    const r = await req("GET", I);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.counts, null);
    assert.equal(r.body.countsWithheld, "roster_visible");
  });

  it("the buddy roster UNREADABLE: 503 — never 'nobody to name'", async () => {
    stage({ failures: { "rent_buddy_profiles:select": { message: "boom" } } });
    const r = await req("GET", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.counts, undefined);
  });

  it("the crew roster UNREADABLE: 503 — never counted as 'nobody to leave out'", async () => {
    stage({ failures: { "layover_crew_members:select": { message: "boom" } } });
    const r = await req("GET", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.counts, undefined);
  });

  it("the trip crew UNREADABLE: 503", async () => {
    const t = stage({ failures: { "trip_members:select": { message: "boom" } } });
    t.layover_sessions[0].trip_id = "trip-1";
    const r = await req("GET", I);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.counts, undefined);
  });

  it("discloseIntentCounts: below k (zero included) is null, k and above is the count", () => {
    assert.deepEqual(
      discloseIntentCounts({ food: 0, nightlife: 4, shopping: 5, culture: 6, meetups: 40 }),
      { food: null, nightlife: null, shopping: 5, culture: 6, meetups: 40 },
    );
  });
});

// ── D-PRESENCE-K-2: the verifier's probe, and the invariance it rests on ──────

describe("D-PRESENCE-K-2 — joining a crew can only turn a number into a withholding, never into a smaller number (verifier F1, ab67f861bb)", () => {
  const now = () => new Date().toISOString();
  function crewOfA(t: Record<string, any[]>) {
    t.layover_crews = [{ id: "crew-a", city: "taoyuan", airport_ref: null, created_by: A, created_session_id: "s-a", title: "Night market", meeting_point_label: null, status: "open", max_members: 6, expires_at: new Date(Date.now() + 3 * HOUR).toISOString(), created_at: now(), updated_at: now() }];
    t.layover_crew_members = [{ crew_id: "crew-a", user_id: A, session_id: "s-a", role: "owner", joined_at: now(), left_at: null }];
  }

  it("the probe through the REAL join route: before a number, after nothing; no intent's count differs; leaving restores the same number", async () => {
    const t = stage();
    crewOfA(t);
    const before = await req("GET", I);
    assert.equal(before.status, 200, before.raw);
    assert.deepEqual(before.body.counts, BASE_DISCLOSED);
    const joined = await req("POST", "/api/airport/sessions/session-1/crew/crew-a/join", {});
    assert.equal(joined.status, 200, joined.raw);
    assert.equal(joined.body.inCrew, true, "fixture: the crew card now names A to the viewer");
    const after = await req("GET", I);
    assert.equal(after.status, 200, after.raw);
    assert.strictEqual(after.body.counts, null, `a count beside a roster that names A: ${after.raw}`);
    assert.equal(after.body.countsWithheld, "roster_visible");
    // The verifier's comparison: no intent may read a DIFFERENT number after the join.
    for (const k of PRESENCE_INTENTS) {
      const b = before.body.counts[k];
      const a = after.body.counts === null ? null : after.body.counts[k];
      assert.ok(a === null || a === b, `${k}: ${b} -> ${a} — the difference would be A's intent`);
    }
    const left = await req("POST", "/api/airport/sessions/session-1/crew/leave", {});
    assert.equal(left.status, 200, left.raw);
    const again = await req("GET", I);
    assert.deepEqual(again.body.counts, BASE_DISCLOSED, "out of the crew, the same number as before — nothing about A moved it");
  });

  it("two viewers — one blocked by a counted traveller, one in no relation to anyone — read the SAME numbers", async () => {
    const t = stage();
    const V2 = "user-v2", TOKEN2 = "presence-intents-token-2";
    t.layover_sessions.push(sessionRow({ id: "session-2", user_id: V2, share_city_status: true, departure_time: DEPARTURE }));
    t.blocks.push({ blocker_id: A, blocked_id: V2 });
    _setTestClient(makeLayoverDb(t, { users: { [TOKEN]: VIEWER, [TOKEN2]: V2 } }), true);
    const one = await req("GET", I);
    const two = await req("GET", "/api/airport/sessions/session-2/presence/intents", undefined, TOKEN2);
    assert.equal(one.status, 200, one.raw);
    assert.equal(two.status, 200, two.raw);
    assert.deepEqual(two.body.counts, one.body.counts, "the count must not be a function of who asks");
    assert.deepEqual(one.body.counts, BASE_DISCLOSED);
  });
});

// ── D-PRESENCE-K-4 (lead ruling 2026-10-08, from V-R5 F2): EVERY presence count ──
//
// GET /:id/presence's L0 count and the overview's `othersInCity` served
// `cityPresence`'s LIVE count: blocks filtered per viewer, the viewer excluded,
// no k, recomputed per request. The verifier's probe through this router: three
// sharing, A flips sharing off → 2 at once; V blocks A → 2. Both doors now go
// through `presenceCountForViewer` (routes/airport.ts): ladder OFF → withheld
// beside the L2 roster; a non-empty roster → withheld; otherwise the hourly,
// viewer-invariant snapshot with k applied before it is stored.

const PRESENCE = "/api/airport/sessions/session-1/presence";
const OVERVIEW = "/api/airport/sessions/session-1/overview";
/**
 * The base fixture's sharing population in Taoyuan: the VIEWER (airport-resolved,
 * `airport_profiles(city)` = Taoyuan — V-R6 R6-1: the fake now resolves that
 * embed, so the viewer's own row is counted as in production), A, B, C, D, E, F,
 * Q1-Q4 (P paused, G in Osaka).
 */
const BASE_PRESENCE = 11;
const V2 = "user-v2", TOKEN2 = "presence-intents-token-2", V3 = "user-v3", TOKEN3 = "presence-intents-token-3";

function withViewers(t: Record<string, any[]>, extra: Record<string, unknown> = {}) {
  t.layover_sessions.push(sessionRow({ id: "session-2", user_id: V2, share_city_status: true, departure_time: DEPARTURE }));
  t.layover_sessions.push(sessionRow({ id: "session-3", user_id: V3, share_city_status: true, departure_time: DEPARTURE }));
  _setTestClient(makeLayoverDb(t, { users: { [TOKEN]: VIEWER, [TOKEN2]: V2, [TOKEN3]: V3 }, ...extra }), true);
}
/** A fixed instant inside the current hour, so two reads can never straddle a boundary. */
function pinClock(): { now: () => number; hour0: number; set: (ms: number) => void } {
  const NOW0 = Date.now();
  let clock = NOW0;
  _setIntentSnapshotClock(() => clock);
  return { now: () => clock, hour0: Math.floor(NOW0 / PRESENCE_INTENT_SNAPSHOT_MS) * PRESENCE_INTENT_SNAPSHOT_MS, set: (ms) => { clock = ms; } };
}

describe("D-PRESENCE-K-4 — every presence COUNT door obeys K-3 (V-R5 F2)", () => {
  it("ladder ON: GET /presence serves the city's hourly count — k applied, no identity, its hour named — and the overview serves the SAME number", async () => {
    stage();
    const r = await req("GET", PRESENCE);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.level, "L0_AGGREGATE");
    assert.equal(r.body.count, BASE_PRESENCE);
    assert.strictEqual(r.body.countWithheld, null);
    assert.equal(r.body.minimumCount, 5);
    assert.equal(r.body.countAsOf, new Date(Math.floor(Date.now() / PRESENCE_INTENT_SNAPSHOT_MS) * PRESENCE_INTENT_SNAPSHOT_MS).toISOString());
    assert.deepEqual(r.body.travelers, []);
    for (const id of [A, B, C, D, E, F, P, ...Q]) assert.ok(!r.raw.includes(id), `leaked ${id}`);
    const o = await req("GET", OVERVIEW);
    assert.equal(o.status, 200, o.raw.slice(0, 300));
    assert.equal(o.body.share.othersInCity, BASE_PRESENCE);
    assert.strictEqual(o.body.share.othersInCityWithheld, null);
  });

  it("viewer-INVARIANT on the compute path: a first requester who blocks one counted traveller and is blocked by another computes the same number as one in no relation", async () => {
    // World 1: V2, in no block relation, is the hour's first requester.
    const t1 = stage();
    withViewers(t1);
    const n1 = await req("GET", "/api/airport/sessions/session-2/presence", undefined, TOKEN2);
    // World 2 (fresh snapshot store, same population): the viewer — who blocks C — and whom A blocks, computes first.
    const t2 = stage();
    t2.blocks.push({ blocker_id: A, blocked_id: VIEWER });
    withViewers(t2);
    const n2 = await req("GET", PRESENCE);
    assert.equal(n1.status, 200, n1.raw);
    assert.equal(n2.status, 200, n2.raw);
    assert.equal(n1.body.count, BASE_PRESENCE + 2, "V2 and V3 (airport-resolved) are counted too");
    assert.equal(n2.body.count, n1.body.count, "a block relation moved the count: it is a function of who asks");
  });

  it("the verifier's probe through the router: a traveller turning sharing OFF and the viewer BLOCKING them move nothing inside the hour", async () => {
    const t = stage();
    const clk = pinClock();
    const first = await req("GET", PRESENCE);
    assert.equal(first.body.count, BASE_PRESENCE);
    t.layover_sessions.find((x: any) => x.id === "s-a").share_city_status = false; // A stops sharing
    const afterFlip = await req("GET", PRESENCE);
    t.blocks.push({ blocker_id: VIEWER, blocked_id: A }); // V blocks A and re-reads
    const afterBlock = await req("GET", PRESENCE);
    const overview = await req("GET", OVERVIEW);
    for (const r of [afterFlip, afterBlock]) {
      assert.equal(r.body.count, first.body.count, `moved inside the hour: ${first.raw} -> ${r.raw}`);
      assert.equal(r.body.countAsOf, first.body.countAsOf);
    }
    assert.equal(overview.body.share.othersInCity, first.body.count, "the overview is the same door, the same snapshot");
    clk.set(clk.hour0 + PRESENCE_INTENT_SNAPSHOT_MS + 1_000);
    const next = await req("GET", PRESENCE);
    assert.equal(next.body.count, BASE_PRESENCE - 1, "A's change shows from the next hour's snapshot, the block never");
  });

  it("below k: withheld as `below_k` on BOTH doors — never a number, zero included", async () => {
    for (const keep of [3, 0]) { // + the viewer: populations of 4 and 1
      const t = stage();
      const others = t.layover_sessions.filter((x: any) => x.id !== "session-1" && x.manual_city === "Taoyuan" && x.user_id !== P);
      const dropped = new Set(others.slice(keep).map((x: any) => x.id));
      t.layover_sessions = t.layover_sessions.filter((x: any) => !dropped.has(x.id));
      _setTestClient(makeLayoverDb(t, { users: { [TOKEN]: VIEWER } }), true);
      const r = await req("GET", PRESENCE);
      assert.equal(r.status, 200, r.raw);
      assert.strictEqual(r.body.count, null, `a population of ${keep + 1} reached the wire: ${r.raw}`);
      assert.equal(r.body.countWithheld, "below_k");
      assert.equal(r.body.degraded, false, "below k is a measurement, not an outage");
      const o = await req("GET", OVERVIEW);
      assert.strictEqual(o.body.share.othersInCity, null);
      assert.equal(o.body.share.othersInCityWithheld, "below_k");
    }
  });

  it("a non-empty roster (crew card, trip crew, buddy roster) withholds the count WHOLE on both doors", async () => {
    const later = () => new Date(Date.now() + 3 * HOUR).toISOString(), now = () => new Date().toISOString();
    const rosters: Array<[string, (t: Record<string, any[]>) => void]> = [
      ["crew card", (t) => {
        t.layover_crews = [{ id: "crew-1", city: "Taoyuan", airport_ref: null, created_by: VIEWER, created_session_id: "session-1", title: "Night market", meeting_point_label: null, status: "open", max_members: 6, expires_at: later(), created_at: now() }];
        t.layover_crew_members = [
          { crew_id: "crew-1", user_id: VIEWER, session_id: "session-1", role: "owner", joined_at: now(), left_at: null },
          { crew_id: "crew-1", user_id: G, session_id: "s-g", role: "member", joined_at: now(), left_at: null },
        ];
      }],
      ["trip crew", (t) => { t.layover_sessions[0].trip_id = "trip-1"; t.trips = [{ id: "trip-1", owner_id: VIEWER }]; t.trip_members = [{ trip_id: "trip-1", user_id: G, role: "member", status: "accepted" }]; }],
      ["buddy roster", (t) => { t.rent_buddy_profiles = [{ id: "b-1", user_id: "user-local-guide", display_name: "Guide", city: "Taoyuan", status: "active" }]; }],
    ];
    for (const [label, add] of rosters) {
      const t = stage();
      add(t);
      const r = await req("GET", PRESENCE);
      assert.equal(r.status, 200, `${label}: ${r.raw}`);
      assert.strictEqual(r.body.count, null, `${label}: a count beside a roster`);
      assert.equal(r.body.countWithheld, "roster_visible", label);
      const o = await req("GET", OVERVIEW);
      assert.strictEqual(o.body.share.othersInCity, null, label);
      assert.equal(o.body.share.othersInCityWithheld, "roster_visible", label);
    }
  });

  it("ladder OFF: the L2 roster is served as before, and NO count beside it on either door; the population is never read", async () => {
    const t = stage({ ladder: false });
    t.profiles = [{ id: A, handle: "a", name: "A", avatar_url: null }, { id: B, handle: "b", name: "B", avatar_url: null }];
    const db = makeLayoverDb(t, { users: { [TOKEN]: VIEWER } });
    const realFrom = db.from;
    let populationReads = 0;
    db.from = (name: string) => {
      const b = realFrom(name);
      if (name === "layover_sessions") { const order = b.order?.bind(b); if (order) b.order = (...a: unknown[]) => { populationReads += 1; return order(...a); }; }
      return b;
    };
    _setTestClient(db, true);
    const r = await req("GET", PRESENCE);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.level, "L2_DISCOVERY");
    assert.deepEqual(r.body.travelers.map((x: any) => x.id).sort(), [A, B], "the shipped L2 roster is unchanged");
    assert.strictEqual(r.body.count, null);
    assert.equal(r.body.countWithheld, "roster_visible");
    const o = await req("GET", OVERVIEW);
    assert.strictEqual(o.body.share.othersInCity, null);
    assert.equal(o.body.share.othersInCityWithheld, "roster_visible");
    assert.equal(populationReads, 0, "with the ladder off no count is computed at all");
  });

  it("unreadable: a failed roster or population read is no number on either door — /presence says degraded, the dashboard is still served", async () => {
    stage({ failures: { "rent_buddy_profiles:select": { message: "boom" } } });
    const r = await req("GET", PRESENCE);
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.count, null);
    assert.equal(r.body.countWithheld, "unreadable");
    assert.equal(r.body.degraded, true);
    assert.ok(r.body.degradedReasons.includes("buddies_unreadable"), r.raw);
    const o = await req("GET", OVERVIEW);
    assert.equal(o.status, 200, o.raw.slice(0, 300));
    assert.strictEqual(o.body.share.othersInCity, null);
    assert.equal(o.body.share.othersInCityWithheld, "unreadable");

    // The population's consent read (publishableUserIds, `.in`) failing — the viewer's own gate (`.eq`) still reads.
    const t = stage();
    const db = makeLayoverDb(t, { users: { [TOKEN]: VIEWER } });
    const realFrom = db.from.bind(db);
    db.from = (name: string) => {
      const b = realFrom(name);
      if (name === "location_preferences") b.in = () => ({ then: (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "boom" } }) });
      return b;
    };
    _setTestClient(db, true);
    const p2 = await req("GET", PRESENCE);
    assert.strictEqual(p2.body.count, null, p2.raw);
    assert.equal(p2.body.degraded, true);
    assert.ok(p2.body.degradedReasons.includes("sharing_preferences_unreadable"), p2.raw);
  });

  it("INVENTORY: every presence count door in routes/airport.ts goes through the K-3 doors; `cityPresence` feeds only the L2 roster", () => {
    const src = readFileSync(new URL("../routes/airport.ts", import.meta.url), "utf8");
    const calls = (name: string) => src.split("\n").filter((l) => l.includes(`${name}(`) && !l.includes(`function ${name}(`));
    const cp = calls("cityPresence").filter((l) => !/^\s*(\/\/|\*)/.test(l));
    assert.equal(cp.length, 1, `cityPresence is called from: ${cp.join(" | ")}`);
    assert.match(cp[0]!, /ladderEnabled \? null : await cityPresence\(/, "its one call is the L2 roster, read only with the ladder off");
    const pc = calls("presenceCountForViewer").filter((l) => !/^\s*(\/\/|\*)/.test(l));
    assert.equal(pc.length, 2, "GET /:id/presence and the overview");
    assert.equal((src.match(/othersInCity:/g) ?? []).length, 1);
    assert.match(src, /othersInCity: presence\.count, othersInCityWithheld: presence\.countWithheld/);
    // D-PRESENCE-K-5: ONE computation (`cityCountsSnapshot`) feeds every count door — the presence count and the intents.
    assert.equal(calls("cityPopulationSnapshot").filter((l) => !/^\s*(\/\/|\*)/.test(l)).length, 1, "one snapshot computation");
    assert.equal(calls("cityCountsSnapshot").filter((l) => !/^\s*(\/\/|\*)/.test(l)).length, 2, "read by presenceCountForViewer and the intents route");
  });
});

// ── V-R5 F4: the three snapshot invariants, pinned through the router ─────────

describe("V-R5 F4 — the snapshot's three invariants", () => {
  it("K-A/K-B: a failed computation is never cached — the counts read fails, then succeeds in the SAME hour, and the number is served", async () => {
    const t = stage();
    pinClock();
    failNthPresenceCall(t, 2); // the 1st call is the viewer's own record; the 2nd is the counts
    const failed = await req("GET", I);
    assert.equal(failed.status, 503, failed.raw);
    const served = await req("GET", I);
    assert.equal(served.status, 200, served.raw);
    assert.deepEqual(served.body.counts, BASE_DISCLOSED, "a failure was cached (as 'fewer than 5') or its in-flight promise kept");
  });

  it("K-A/K-B on the presence door: the population read fails once, then the same hour serves the number", async () => {
    const t = stage();
    pinClock();
    const db = makeLayoverDb(t, { users: { [TOKEN]: VIEWER } });
    const realFrom = db.from.bind(db);
    let fail = true;
    db.from = (name: string) => {
      const b = realFrom(name);
      if (name === "location_preferences" && fail) b.in = () => { fail = false; return { then: (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "boom" } }) }; };
      return b;
    };
    _setTestClient(db, true);
    const failed = await req("GET", PRESENCE);
    assert.strictEqual(failed.body.count, null, failed.raw);
    assert.equal(failed.body.countWithheld, "unreadable");
    const served = await req("GET", PRESENCE);
    assert.equal(served.body.count, BASE_PRESENCE, served.raw);
    assert.equal(served.body.degraded, false);
  });

  it("K-C: the snapshot is SHARED — a third account that never read before gets the second account's numbers and hour after a change", async () => {
    const t = stage();
    pinClock();
    withViewers(t);
    const y1 = await req("GET", "/api/airport/sessions/session-2/presence/intents", undefined, TOKEN2);
    const p1 = await req("GET", "/api/airport/sessions/session-2/presence", undefined, TOKEN2);
    assert.deepEqual(y1.body.counts, BASE_DISCLOSED, y1.raw);
    assert.equal(p1.body.count, BASE_PRESENCE + 2, p1.raw);
    // A new traveller, open to food and nightlife, arrives inside the hour.
    t.layover_sessions.push(other("s-new", "user-new"));
    t.layover_presence.push(presence("s-new", "user-new", ["food", "nightlife"]));
    const y3 = await req("GET", "/api/airport/sessions/session-3/presence/intents", undefined, TOKEN3);
    const p3 = await req("GET", "/api/airport/sessions/session-3/presence", undefined, TOKEN3);
    assert.deepEqual(y3.body.counts, y1.body.counts, "a per-viewer snapshot: the third account read a fresh instant");
    assert.equal(y3.body.countsAsOf, y1.body.countsAsOf);
    assert.equal(p3.body.count, p1.body.count);
    assert.equal(p3.body.countAsOf, p1.body.countAsOf);
  });
});

// ── V-R5 F1: the cap evicts STALE snapshots only, and refuses a new city at the cap ──

describe("V-R5 F1 — the snapshot cap never clears a live snapshot", () => {
  function junk(t: Record<string, any[]>, n: number) {
    for (let i = 1; i <= n; i += 1) t.layover_sessions.push(sessionRow({ id: `session-j${i}`, user_id: VIEWER, airport_id: null, manual_city: `Junk${i}`, share_city_status: true, departure_time: DEPARTURE }));
  }

  it("filling the cap with other cities inside the hour leaves the target's numbers and hour untouched; a NEW city at the cap is a 503, computed never; the next hour evicts the stale ones", async () => {
    const t = stage();
    const clk = pinClock();
    _setSnapshotCapForTest(3);
    junk(t, 3);
    const target = await req("GET", I);
    assert.deepEqual(target.body.counts, BASE_DISCLOSED, target.raw);
    // The verifier's flood, through the router: two more cities fill the cap (3 keys).
    for (const j of ["j1", "j2"]) {
      const r = await req("GET", `/api/airport/sessions/session-${j}/presence/intents`);
      assert.equal(r.status, 200, r.raw);
    }
    // A third NEW city: refused, and refused WITHOUT computing (no population read).
    const db = makeLayoverDb(t, { users: { [TOKEN]: VIEWER } });
    const realFrom = db.from;
    let populationReads = 0;
    db.from = (name: string) => {
      const b = realFrom(name);
      if (name === "layover_sessions") { const order = b.order?.bind(b); if (order) b.order = (...a: unknown[]) => { populationReads += 1; return order(...a); }; }
      return b;
    };
    _setTestClient(db, true);
    const refused = await req("GET", "/api/airport/sessions/session-j3/presence/intents");
    assert.equal(refused.status, 503, refused.raw);
    assert.equal(populationReads, 0, "a computation ran at the cap");
    // D-PRESENCE-K-5: the presence door reads the SAME city snapshot — the target's is served, from its instant…
    const pres = await req("GET", PRESENCE);
    assert.equal(pres.status, 200, pres.raw);
    assert.equal(pres.body.countAsOf, target.body.countsAsOf, pres.raw);
    // …and a NEW city through the presence door is refused at the cap too, as an unreadable count.
    const presNew = await req("GET", "/api/airport/sessions/session-j3/presence");
    assert.strictEqual(presNew.body.count, null, presNew.raw);
    assert.ok(presNew.body.degradedReasons.includes("snapshot_capacity"), presNew.raw);
    // The target's population changes; its snapshot does not — the flood forced no mid-hour recompute.
    t.layover_sessions.push(other("s-new", "user-new"));
    t.layover_presence.push(presence("s-new", "user-new", ["food"]));
    const again = await req("GET", I);
    assert.deepEqual(again.body.counts, BASE_DISCLOSED, `the target was recomputed mid-hour: ${again.raw}`);
    assert.equal(again.body.countsAsOf, target.body.countsAsOf);
    // Next hour: the earlier hour's entries are stale, evicted, and new cities are admitted again.
    clk.set(clk.hour0 + PRESENCE_INTENT_SNAPSHOT_MS + 1_000);
    const admitted = await req("GET", "/api/airport/sessions/session-j3/presence/intents");
    assert.equal(admitted.status, 200, admitted.raw);
    const fresh = await req("GET", I);
    assert.equal(fresh.body.counts.food, 8, fresh.raw);
  });

  it("at the store: k is applied BEFORE a presence count is stored (D-PRESENCE-K-4 rule 1) — a raw 4 is never in the snapshot, a raw 5 is", async () => {
    _resetIntentCountSnapshots();
    _setSnapshotCapForTest(null);
    pinClock();
    const raw = (population: number, food: number) => async () => ({ ok: true as const, population, intents: { ...emptyIntentCounts(), food } });
    const four = await cityPopulationSnapshot("Small", raw(4, 4));
    assert.ok(four.ok && four.presence === null && four.intents?.food === null, JSON.stringify(four));
    const zero = await cityPopulationSnapshot("Empty", raw(0, 0));
    assert.ok(zero.ok && zero.presence === null && zero.intents?.food === null, JSON.stringify(zero));
    const five = await cityPopulationSnapshot("Five", raw(5, 5));
    assert.ok(five.ok && five.presence === 5 && five.intents?.food === 5, JSON.stringify(five));
    const off = await cityPopulationSnapshot("IntentsOff", async () => ({ ok: true as const, population: 6, intents: null }));
    assert.ok(off.ok && off.presence === 6 && off.intents === null, JSON.stringify(off));
    _setIntentSnapshotClock(null);
  });

  it("at the store: a live key is served from memory, a new key at the cap computes NOTHING, and a stale key is evicted next hour (the verifier's capprobe)", async () => {
    _resetIntentCountSnapshots();
    _setSnapshotCapForTest(2);
    const clk = pinClock();
    let computes = 0;
    const ok = async () => { computes += 1; return { ok: true as const, population: 7, intents: emptyIntentCounts() }; };
    assert.equal((await cityPopulationSnapshot("Target", ok)).ok, true);
    assert.equal((await cityPopulationSnapshot("Other", ok)).ok, true);
    assert.equal(computes, 2);
    for (let i = 0; i < 50; i += 1) {
      const r = await cityPopulationSnapshot(`junk-${i}`, ok);
      assert.deepEqual(r, { ok: false, reason: "snapshot_capacity" });
    }
    assert.equal(computes, 2, "a new key computed at the cap");
    const target = await cityPopulationSnapshot("target", ok);
    assert.ok(target.ok && target.presence === 7);
    assert.equal(computes, 2, "the live target was recomputed");
    clk.set(clk.hour0 + PRESENCE_INTENT_SNAPSHOT_MS);
    const next = await cityPopulationSnapshot("junk-0", ok);
    assert.equal(next.ok, true, "the next hour admits a new key once the stale ones are evicted");
    assert.equal(computes, 3);
    _setSnapshotCapForTest(null);
    _setIntentSnapshotClock(null);
  });
});

// ── V-R6 R6-1 / R6-2: who is in the counted population ──────────────────────

describe("V-R6 — the counted population: the viewer's own row, and an EXACT city", () => {
  it("R6-1: the viewer's own airport-resolved session is counted, and a first requester's own membership does not move a second account's number", async () => {
    // World A: the viewer computes the hour's snapshot; V2 reads after.
    const ta = stage();
    withViewers(ta);
    const a1 = await req("GET", PRESENCE);
    const a2 = await req("GET", "/api/airport/sessions/session-2/presence", undefined, TOKEN2);
    // World B: V2 computes first.
    const tb = stage();
    withViewers(tb);
    const b2 = await req("GET", "/api/airport/sessions/session-2/presence", undefined, TOKEN2);
    for (const r of [a1, a2, b2]) assert.equal(r.status, 200, r.raw);
    assert.equal(a1.body.count, BASE_PRESENCE + 2, a1.raw);
    assert.equal(a2.body.count, a1.body.count, "the first requester's own membership moved the second account's number");
    assert.equal(b2.body.count, a1.body.count, "whoever computes first, the same number");
    // World C: the viewer's session gone — V2 reads exactly one fewer: the viewer WAS counted.
    const tc = stage();
    tc.layover_sessions = tc.layover_sessions.filter((x: any) => x.id !== "session-1");
    withViewers(tc);
    const c2 = await req("GET", "/api/airport/sessions/session-2/presence", undefined, TOKEN2);
    assert.equal(c2.body.count, a2.body.count - 1, `the viewer's own row is not in the population: ${c2.raw}`);
  });

  it("R6-2: the city match is EXACT after trim+lowercase — 'Taoyuan City' is another population with its own snapshot; ' taoyuan ' is Taoyuan", async () => {
    const t = stage();
    t.layover_sessions.push(other("s-norm", "user-norm", " taoyuan "));
    const CITY2 = ["user-tc1", "user-tc2", "user-tc3", "user-tc4"];
    for (const u of CITY2) t.layover_sessions.push(other(`s-${u}`, u, "Taoyuan City"));
    t.layover_sessions.push(sessionRow({ id: "session-tc", user_id: VIEWER, airport_id: null, manual_city: "Taoyuan City", share_city_status: true, departure_time: DEPARTURE }));
    _setTestClient(makeLayoverDb(t, { users: { [TOKEN]: VIEWER } }), true);
    const taoyuan = await req("GET", PRESENCE);
    assert.equal(taoyuan.body.count, BASE_PRESENCE + 1, `only ' taoyuan ' joins Taoyuan: ${taoyuan.raw}`);
    const city2 = await req("GET", "/api/airport/sessions/session-tc/presence");
    assert.equal(city2.status, 200, city2.raw);
    assert.equal(city2.body.city, "Taoyuan City");
    assert.equal(city2.body.count, 5, `Taoyuan City is its own population (4 + the reading session): ${city2.raw}`);
    // Separate snapshots: Taoyuan's number is not Taoyuan City's, and re-reading Taoyuan serves Taoyuan's.
    const again = await req("GET", PRESENCE);
    assert.equal(again.body.count, taoyuan.body.count);
  });
});

// ── D-PRESENCE-K-5: ONE population snapshot per city-hour feeds both kinds ────

describe("D-PRESENCE-K-5 — the presence count and the intent counts are ONE snapshot, one instant", () => {
  function countingDb(t: Record<string, any[]>) {
    const db = makeLayoverDb(t, { users: { [TOKEN]: VIEWER } });
    const realFrom = db.from;
    const reads = { population: 0 };
    db.from = (name: string) => {
      const b = realFrom(name);
      if (name === "layover_sessions") { const order = b.order?.bind(b); if (order) b.order = (...a: unknown[]) => { reads.population += 1; return order(...a); }; }
      return b;
    };
    _setTestClient(db, true);
    return reads;
  }

  for (const first of ["intents", "presence"] as const) {
    it(`${first} door first: a traveller arriving mid-hour moves NEITHER number, the population is read once, and both doors name the same hour`, async () => {
      const t = stage();
      pinClock();
      const reads = countingDb(t);
      const one = first === "intents" ? await req("GET", I) : await req("GET", PRESENCE);
      assert.equal(one.status, 200, one.raw);
      // A traveller open to food and nightlife arrives inside the hour.
      t.layover_sessions.push(other("s-new", "user-new"));
      t.layover_presence.push(presence("s-new", "user-new", ["food", "nightlife"]));
      const two = first === "intents" ? await req("GET", PRESENCE) : await req("GET", I);
      const intents = first === "intents" ? one : two;
      const pres = first === "intents" ? two : one;
      assert.deepEqual(intents.body.counts, BASE_DISCLOSED, intents.raw);
      assert.equal(pres.body.count, BASE_PRESENCE, `the second kind read a later instant: ${pres.raw}`);
      assert.equal(pres.body.countAsOf, intents.body.countsAsOf);
      assert.equal(reads.population, 1, "two computations: two instants");
    });
  }

  it("intents switched off at the snapshot's instant: the presence count is served, the intents door fails closed (never a number from another instant)", async () => {
    const t = stage();
    pinClock();
    t.feature_flags = t.feature_flags.filter((f: any) => f.flag !== PRESENCE_INTENTS_FLAG);
    countingDb(t);
    const pres = await req("GET", PRESENCE);
    assert.equal(pres.body.count, BASE_PRESENCE, pres.raw);
    t.feature_flags.push({ flag: PRESENCE_INTENTS_FLAG, enabled: true });
    const i = await req("GET", I);
    assert.equal(i.status, 503, i.raw);
  });
});
