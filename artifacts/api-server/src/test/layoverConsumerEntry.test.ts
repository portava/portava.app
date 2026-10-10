/**
 * census-discovery §65 (lane P19) — every Layover consumer that certifies a
 * window takes the SAME border-entry input the certified snapshot takes.
 *
 * node:test + node:assert (NOT vitest). Real router where a route is the
 * consumer, fake table-backed DB, no network.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * §56.14 gave `certifiedLayoverSnapshot` the entry input
 * (`resolveLayoverEntry(db, session.userId, layoverAirportCountry(airport))`),
 * so a traveller whose border is refused certifies `no` — landside closed — in
 * every snapshot consumer and on the dashboard. The consumers that certify
 * INLINE did not get it. Each called `certifySessionFeasibility` with no
 * `entry`, which the engine reads as `unresolved`, so the same refused
 * traveller certified `entry_unverified` there — which is not a refusal:
 *   - the in-layover Compass answer said "You can leave the airport" with a
 *     `safe` note, and its clarifying question was weighed against the wrong
 *     verdict;
 *   - the recommendations generator served city cards;
 *   - the buddy gate passed and offered people to meet in the city;
 *   - a reported disruption re-certified the moved schedule without entry and
 *     published THAT verdict in place of the route's own;
 *   - the replanner certified before/after without entry, so a delay could
 *     "change the landside verdict" and notify, and landside plan stops "fit".
 *
 * ── WHAT IS PINNED ───────────────────────────────────────────────────────────
 *   - REFUSED corridor → the consumer's certified verdict is `no` and it offers
 *     no landside action;
 *   - PERMITTED corridor → the consumer still opens landside (positive control:
 *     the fix is not a blanket closure);
 *   - an UNREADABLE entry source (or the entry flag off) → `entry_unverified`,
 *     never `yes`: the resolver never answers `permitted` on a failed read.
 *     That a data gap does not itself CLOSE landside is §56.14's standing
 *     judgement (the snapshot's own exhaustive `forbidden` switch); this suite
 *     pins PARITY with the snapshot on it and decides nothing new;
 *   - PARITY: where the consumer and the snapshot can both be read for one
 *     world, their verdicts are equal;
 *   - a static ratchet: every production `certifySessionFeasibility` call names
 *     `entry`, except the crew wrapper `layoverEntryGate.test.ts` already pins
 *     as deliberate.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverConsumerEntry.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { ENTRY_FLAG } from "../lib/entryRequirements.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { certifiedLayoverSnapshot } from "../services/airport/LayoverSnapshot.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { valueOfInformation } from "../services/airport/LayoverCompassService.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { handleEvent, normalizeEvent, type LayoverEventEnvelope, type ReplanCandidate } from "../services/airport/LayoverEventReplanner.js";
import { replanExternalEvent } from "../services/airport/LayoverExternalReplanPort.js";
import { layoverBuddyDecision } from "../services/airport/LayoverBuddyGate.js";
import { safetyLabel } from "../services/airport/LayoverSafetyEngine.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = "consumer-entry-token";
const USER = "user-1";
const SESSION = "session-1";
const HOUR = 3_600_000;

type Rows = Record<string, Array<Record<string, unknown>>>;

/** Read a field path out of a parsed JSON body or a fake row, without `any`. */
function at(v: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** The fake stands in for the service client, as every suite on this tree uses it. */
const asDb = (fake: ReturnType<typeof makeLayoverDb>): SupabaseClient => fake as unknown as SupabaseClient;

// ── the world: one traveller, a US passport, an airport in Taiwan ────────────

type World = "refused" | "permitted" | "passports_unreadable" | "flag_off";
const WORLDS: World[] = ["refused", "permitted", "passports_unreadable", "flag_off"];

function corridorRow(status: string) {
  return {
    id: `corr-${status}`, passport_country: "US", destination_country: "TW", status,
    allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
    official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
  };
}

function entryTables(world: World): Rows {
  return {
    traveler_passports: [
      { user_id: USER, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" },
    ],
    entry_requirements: [corridorRow(world === "permitted" ? "visa_free" : "visa_required")],
  };
}

function entryFlags(world: World) {
  return [{ flag: ENTRY_FLAG, enabled: world !== "flag_off" }];
}

function entryFailures(world: World): Record<string, { message: string }> {
  return world === "passports_unreadable" ? { "traveler_passports:select": { message: "relation unavailable" } } : {};
}

/** What the certified snapshot says for this traveller in this world. */
async function snapshotVerdict(db: SupabaseClient, nowMs = Date.now()): Promise<{ verdict: string; landsideNotForbidden: boolean; landsideOpen: boolean }> {
  const r = await certifiedLayoverSnapshot(db, USER, { nowMs });
  assert.ok(r.ok, `fixture: a certified snapshot must exist (${JSON.stringify(r)})`);
  return { verdict: r.snapshot.verdict, landsideNotForbidden: landsideNotForbidden(r.snapshot), landsideOpen: r.snapshot.landsideOpen };
}

const REFUSED: EntryEligibility = {
  state: "refused", status: "visa_required", corridor: { passportCountry: "US", destinationCountry: "TW" },
};

// ── the route harness ────────────────────────────────────────────────────────

let server: http.Server;
let base = "";
let tables: Rows = {};
let db: SupabaseClient;

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
    if (raw !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(raw));
    }
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers },
      (res) => {
        let acc = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { acc += c; });
        res.on("end", () => {
          let parsed: unknown; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (raw !== null) r.write(raw);
    r.end();
  });
}

function stage(world: World, over: { session?: Record<string, unknown>; stops?: Array<Record<string, unknown>> } = {}) {
  const now = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_compass_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: true },
      ...entryFlags(world),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      id: SESSION, user_id: USER,
      arrival_time: new Date(now + 5 * 60_000).toISOString(),
      departure_time: new Date(now + 10 * HOUR).toISOString(),
      ...over.session,
    })],
    layover_recommendations: [],
    layover_plan_stops: over.stops ?? [],
    layover_events: [],
    trip_plan_items: [],
    trips: [],
    trip_members: [],
    blocks: [],
    rent_buddy_profiles: [
      { id: "b1", user_id: "buddy-1", display_name: "Amy", city: "Taoyuan", status: "active",
        review_count: 3, verified: true, buddy_level: "trusted", categories: ["city"] },
    ],
    rent_buddy_availability: [],
    ...entryTables(world),
  };
  const fake = makeLayoverDb(tables, { users: { [TOKEN]: USER }, failures: entryFailures(world) });
  db = asDb(fake);
  _setTestClient(fake, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { Object.assign(r, { log: { error() {}, info() {}, warn() {}, debug() {} } }); next(); });
  app.use("/api", airportRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr !== null && typeof addr === "object" ? addr.port : 0}`;
});
after(() => { server?.close(); _setTestClient(null, false); });

// ── 1. the in-layover Compass answer ─────────────────────────────────────────

describe("POST /airport/sessions/:id/compass — the answer certifies with the entry input", () => {
  it("a REFUSED corridor: the certified verdict is `no`, the note refuses, and the answer never says 'you can leave'", async () => {
    stage("refused");
    const r = await send("POST", `/api/airport/sessions/${SESSION}/compass`, { question: "Can I leave the airport?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(at(r.body, "certification", "verdict"), "no");
    assert.equal(at(r.body, "safetyNote"), safetyLabel("not_recommended"));
    assert.doesNotMatch(String(at(r.body, "answer")), /you can leave the airport/i);
    assert.match(String(at(r.body, "answer")), /staying inside the airport/i);
    assert.deepEqual(at(r.body, "boundaryViolations"), [], "the server's own refusal must satisfy its own §12 guard");
    assert.equal((await snapshotVerdict(db)).verdict, at(r.body, "certification", "verdict"), "Compass and the snapshot disagree");
  });

  it("POSITIVE CONTROL — a PERMITTED corridor still certifies `yes` and the answer may say so", async () => {
    stage("permitted");
    const r = await send("POST", `/api/airport/sessions/${SESSION}/compass`, { question: "Can I leave the airport?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(at(r.body, "certification", "verdict"), "yes");
    assert.notEqual(at(r.body, "safetyNote"), safetyLabel("not_recommended"));
    assert.equal((await snapshotVerdict(db)).verdict, "yes");
  });

  it("a data gap (passports unreadable, entry flag off) is `entry_unverified`, never `yes` — the snapshot's answer", async () => {
    for (const world of ["passports_unreadable", "flag_off"] as const) {
      stage(world);
      const r = await send("POST", `/api/airport/sessions/${SESSION}/compass`, { question: "Can I leave the airport?" });
      assert.equal(r.status, 200, `${world}: ${JSON.stringify(r.body)}`);
      assert.equal(at(r.body, "certification", "verdict"), "entry_unverified", world);
      assert.equal((await snapshotVerdict(db)).verdict, "entry_unverified", world);
    }
  });

  it("the clarifying question is weighed against the ENTRY-BEARING verdict: under a refusal no time field moves it", () => {
    const NOW = Date.parse("2026-09-13T02:00:00.000Z");
    const airport = profile();
    // Find a window where one bag flips the time-only verdict, so the control
    // below is not vacuous.
    let s: LayoverSession | null = null;
    for (let m = 200; m < 600 && !s; m += 1) {
      const cand = layoverSession(NOW, m);
      const a = certifySessionFeasibility(airport, cand, { nowMs: NOW }).verdict;
      const b = certifySessionFeasibility(airport, { ...cand, checkedBags: true }, { nowMs: NOW }).verdict;
      // Neither side `no`: a flip INTO `no` would coincide with the refusal and
      // could not tell a flip certified with entry from one certified without.
      if (a !== b && a !== "no" && b !== "no") s = cand;
    }
    assert.ok(s, "fixture: no window found where checked bags move the time-only verdict");
    const unresolved = valueOfInformation(airport, s, NOW).find((q) => q.field === "checkedBags");
    assert.equal(unresolved?.impact.verdictChanges, true, "control: without entry the bag question moves the verdict");
    const refused = valueOfInformation(airport, s, NOW, REFUSED).find((q) => q.field === "checkedBags");
    assert.notEqual(refused?.impact.verdictChanges, true, "under a refused border a bag cannot change `no`");
  });
});

// ── 2. the recommendations generator ─────────────────────────────────────────

describe("generateRecommendations — landside cards follow the entry-bearing verdict", () => {
  const NOW = Date.parse("2026-09-13T02:00:00.000Z"); // 10:00 in Asia/Taipei
  function recTables(world: World): Rows {
    return {
      feature_flags: entryFlags(world),
      discovery_places: [
        { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli",
          blurb: "Snacks", verified: true, city: "Taoyuan", status: "active" },
      ],
      layover_recommendations: [],
      layover_plan_stops: [],
      layover_events: [],
      ...entryTables(world),
    };
  }
  async function landsideCards(world: World): Promise<Array<{ title: string }>> {
    const d = asDb(makeLayoverDb(recTables(world), { failures: entryFailures(world) }));
    const r = await generateRecommendations(d, profile(), layoverSession(NOW, 9 * 60), NOW);
    if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
    return r.recommendations.filter((c) => c.insideAirport === false);
  }

  it("a REFUSED corridor gets no landside card at all — only the airport", async () => {
    assert.deepEqual((await landsideCards("refused")).map((c) => c.title), []);
  });

  it("POSITIVE CONTROL — a PERMITTED corridor still gets city cards", async () => {
    assert.ok((await landsideCards("permitted")).length > 0, "a permitted border must not close landside");
  });

  it("PARITY with the snapshot's 'not forbidden' reading (`landsideStatus` open or caution) in every world (a data gap closes neither)", async () => {
    for (const world of WORLDS) {
      stage(world);
      const snap = await snapshotVerdict(db);
      const open = (await landsideCards(world)).length > 0;
      assert.equal(open, snap.landsideNotForbidden, `${world}: recommendations open=${open}, snapshot not-forbidden=${snap.landsideNotForbidden}`); if (snap.verdict !== "yes") assert.equal(snap.landsideOpen, false, `${world}: the strict boolean is true only for a verdict of yes`);
    }
  });
});

// ── 3. the buddy gate ────────────────────────────────────────────────────────

describe("GET /airport/sessions/:id/buddies — the safety gate reads the entry-bearing verdict", () => {
  it("a REFUSED corridor does not pass the gate: nobody to meet in a city the traveller may not enter", async () => {
    stage("refused");
    const r = await send("GET", `/api/airport/sessions/${SESSION}/buddies`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(at(r.body, "reason"), "safety_gate_not_passed");
    assert.equal(at(r.body, "safetyGate", "verdict"), "no");
    assert.deepEqual(at(r.body, "buddies"), []);
  });

  it("POSITIVE CONTROL — a PERMITTED corridor passes the gate", async () => {
    stage("permitted");
    const r = await send("GET", `/api/airport/sessions/${SESSION}/buddies`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(at(r.body, "reason"), "safety_gate_not_passed");
    assert.equal(at(r.body, "safetyGate", "passed"), true);
    assert.equal(at(r.body, "safetyGate", "verdict"), "yes");
  });

  it("the gate itself: a refused entry fails it; an omitted entry is unresolved, the snapshot's data-gap answer", () => {
    const NOW = Date.parse("2026-09-13T02:00:00.000Z");
    const s = layoverSession(NOW, 10 * 60);
    assert.equal(layoverBuddyDecision(profile(), s, NOW, REFUSED).safetyGate.verdict, "no");
    assert.equal(layoverBuddyDecision(profile(), s, NOW, REFUSED).safetyGate.passed, false);
    assert.equal(layoverBuddyDecision(profile(), s, NOW, null).safetyGate.verdict, "entry_unverified");
  });
});

// ── 4. Safe Return: a reported disruption ────────────────────────────────────

describe("POST /airport/sessions/:id/disruption — the recomputed schedule keeps the entry input", () => {
  async function report(world: World) {
    stage(world);
    const r = await send("POST", `/api/airport/sessions/${SESSION}/disruption`, {
      kind: "delay", newDepartureTime: new Date(Date.now() + 12 * HOUR).toISOString(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(at(r.body, "recompute"), "fixture: a moved departure must publish a recompute");
    return r.body;
  }

  it("a REFUSED corridor stays `no` after the schedule moves — the published and recorded certification", async () => {
    const body = await report("refused");
    assert.equal(at(body, "certification", "verdict"), "no");
    const recorded = (tables.layover_events ?? []).filter((e) => at(e, "metadata", "disruption")).map((e) => at(e, "metadata"));
    assert.ok(recorded.length > 0, "fixture: the transition was not recorded");
    assert.equal(at(recorded[recorded.length - 1], "certification", "verdict"), "no", "the ledger kept a verdict certified without entry");
  });

  it("POSITIVE CONTROL — a PERMITTED corridor stays `yes`", async () => {
    assert.equal(at(await report("permitted"), "certification", "verdict"), "yes");
  });

  it("a data gap stays `entry_unverified`, never `yes`", async () => {
    assert.equal(at(await report("passports_unreadable"), "certification", "verdict"), "entry_unverified");
  });
});

// ── 5. the replanner ─────────────────────────────────────────────────────────

describe("PATCH /airport/sessions/:id — the replan certifies before/after with the entry input", () => {
  const landsideStop = {
    id: "stop-1", session_id: SESSION, title: "Old town walk", description: null,
    stop_order: 1, duration_min: 60, travel_min: 20, place_id: null, recommendation_id: null,
    lat: null, lng: null, location_label: null, inside_airport: false, source: "user",
    created_at: new Date().toISOString(),
  };
  async function delay(world: World) {
    const now = Date.now();
    stage(world, {
      session: { departure_time: new Date(now + 3 * HOUR).toISOString() },
      stops: [{ ...landsideStop }],
    });
    const r = await send("PATCH", `/api/airport/sessions/${SESSION}`, {
      departureTime: new Date(now + 10 * HOUR).toISOString(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(at(r.body, "replan", "ran"), true, JSON.stringify(at(r.body, "replan")));
    return at(r.body, "replan");
  }

  it("a REFUSED corridor: `no` before and after, the verdict does not 'change', and no landside stop 'fits'", async () => {
    const replan = await delay("refused");
    assert.equal(at(replan, "certification", "verdict"), "no");
    assert.equal(at(replan, "diff", "verdictChanged"), false);
    assert.deepEqual(at(replan, "diff", "candidatesGained"), []);
  });

  it("POSITIVE CONTROL — a PERMITTED corridor: the delay opens the window and the landside stop fits", async () => {
    const replan = await delay("permitted");
    assert.equal(at(replan, "certification", "verdict"), "yes");
    assert.deepEqual(at(replan, "diff", "candidatesGained"), ["stop-1"]);
  });

  it("handleEvent with an entry map: a refused border keeps landside candidates out, airside ones in", () => {
    const NOW = Date.parse("2026-09-13T02:00:00.000Z");
    const s = layoverSession(NOW, 10 * 60);
    const ev = envelope(NOW, "flight.departure_delayed", [{ kind: "session", ref: s.id }], { delayMinutes: 30 });
    const candidates: ReplanCandidate[] = [
      { id: "land", insideAirport: false, travelTimeMin: 20, activityTimeMin: 60 },
      { id: "air", insideAirport: true, travelTimeMin: 0, activityTimeMin: 60 },
    ];
    const run = (entries?: Record<string, EntryEligibility | null>) => handleEvent(ev, {
      airport: profile(), sessions: [{ session: s, airportRef: "TPE", status: "active" }],
      candidates: { [s.id]: candidates }, nowMs: NOW, ...(entries ? { entries } : {}),
    }).replanned[0];
    const refused = run({ [s.id]: REFUSED });
    assert.equal(refused.after.verdict, "no");
    assert.equal(refused.before.verdict, "no");
    assert.deepEqual(refused.diff.candidatesGained, []);
    assert.ok(!refused.invalidation.noLongerFeasible.includes("air"), "an airside candidate is not closed by a border");
    assert.ok(refused.invalidation.noLongerFeasible.includes("land"), "a landside candidate cannot fit a refused border");
  });
});

describe("replanExternalEvent — the external-event port certifies each session with its owner's entry", () => {
  const NOW = Date.parse("2026-09-13T02:00:00.000Z");
  const TPE = { ...airportRow(), terminal_info: {} };

  function row(depMin: number) {
    return {
      id: SESSION, user_id: USER, airport_id: "airport-tpe", manual_iata: null,
      arrival_time: new Date(NOW - HOUR).toISOString(),
      departure_time: new Date(NOW + depMin * 60_000).toISOString(),
      boarding_time: null, flight_type: "international", immigration_required: true,
      checked_bags: false, wants_to_leave: true, status: "active",
    };
  }

  /** A departure where the time-only verdict is `no` and an 8-minute delay makes it `tight`
   *  without moving usable time by the materiality threshold — so the ONLY notify trigger
   *  is "the landside verdict changed". */
  function thresholdDeparture(): number {
    const airport = profile();
    for (let m = 120; m < 600; m += 1) {
      const at = (d: number) => certifySessionFeasibility(airport, {
        id: SESSION, arrivalTime: new Date(NOW - HOUR).toISOString(),
        departureTime: new Date(NOW + d * 60_000).toISOString(), boardingTime: null,
        flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
      }, { nowMs: NOW });
      const a = at(m); const b = at(m + 8);
      if (a.verdict === "no" && b.verdict === "tight" && b.envelope.usableMinutes - a.envelope.usableMinutes < 10) return m;
    }
    assert.fail("fixture: no threshold departure found");
  }

  async function notifications(world: World): Promise<number> {
    const dep = thresholdDeparture();
    const t: Rows = {
      feature_flags: entryFlags(world),
      layover_sessions: [row(dep)],
      airport_profiles: [TPE],
      layover_plan_stops: [],
      ...entryTables(world),
    };
    const ev = envelope(NOW, "flight.departure_delayed", [{ kind: "session", ref: SESSION }], { delayMinutes: 8 });
    const r = await replanExternalEvent(asDb(makeLayoverDb(t, { failures: entryFailures(world) })), ev, { nowMs: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return -1;
    assert.equal(r.impacted, 1);
    return r.notifications;
  }

  it("a REFUSED corridor: `no` stays `no`, so the delay notifies nobody that the landside verdict changed", async () => {
    assert.equal(await notifications("refused"), 0);
  });

  it("POSITIVE CONTROL — permitted or unresolved, the same delay DOES change the verdict and notifies", async () => {
    assert.equal(await notifications("permitted"), 1);
    assert.equal(await notifications("passports_unreadable"), 1);
  });
});

// ── 6. the static ratchet ────────────────────────────────────────────────────

describe("every production certification site names the entry input", () => {
  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "test" || name === "__tests__" || name === "node_modules") continue;
        out.push(...tsFiles(p));
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
    return out;
  }

  /** Each `certifySessionFeasibility(...)` call in code (not in a comment), balanced on parentheses. */
  function callSites(src: string): Array<{ index: number; line: number; args: string }> {
    const out: Array<{ index: number; line: number; args: string }> = [];
    const re = /certifySessionFeasibility\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const before = src.slice(lineStart, m.index);
      if (/^\s*(\*|\/\/)/.test(before) || before.includes("//") || /function\s+$/.test(before)) continue;
      let depth = 1; let i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      out.push({ index: m.index, line: src.slice(0, m.index).split("\n").length, args: src.slice(m.index + m[0].length, i - 1) });
    }
    return out;
  }

  it("no call site outside the crew wrapper omits `entry`", () => {
    const root = join(HERE, "..");
    const missing: string[] = [];
    let total = 0;
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("certifySessionFeasibility")) continue;
      const rel = relative(root, file);
      // The one deliberate exception, and its reason is pinned elsewhere
      // (`layoverEntryGate.test.ts`): the crew wrapper certifies OTHER
      // travellers' sessions and must not read their passports.
      const crewAt = rel === join("routes", "airport.ts") ? src.indexOf("function certifyCrewMemberRecord") : -1;
      const crewEnd = crewAt >= 0 ? src.indexOf("\n}", crewAt) : -1;
      for (const site of callSites(src)) {
        total++;
        if (/\bentry\b/.test(site.args)) continue;
        if (crewAt >= 0 && site.index > crewAt && site.index < crewEnd) continue;
        missing.push(`${rel}:${site.line}`);
      }
    }
    assert.ok(total >= 10, `only ${total} certification site(s) found — this test is reading the wrong tree`);
    assert.deepEqual(missing, [], `certification site(s) without the entry input: ${missing.join(", ")}`);
  });

  it("the Compass answer's clarifying question re-certifies with the record's OWN entry input", () => {
    // `valueOfInformation` takes `entry` as a parameter, so the ratchet above sees
    // it named at its certification sites whatever its callers pass. This handoff
    // is what makes the parameter carry the record's corridor. (The second
    // handoff, inside the `requestConstraintClarification` tool, went with the
    // tool when lead ruling L-CL02d deleted the tool loop from the layover door;
    // no other caller of valueOfInformation exists in that file.)
    const src = readFileSync(join(HERE, "..", "services", "airport", "LayoverCompassService.ts"), "utf8");
    assert.match(src, /nextClarifyingQuestion\(airport, session, now\.getTime\(\), record\.inputs\.entry\)/);
    const callers = src.split("\n").filter((l) => /valueOfInformation\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/export function valueOfInformation\(/.test(l));
    assert.deepEqual(callers.map((l) => l.trim()), ["return valueOfInformation(airport, session, nowMs, entry)[0] ?? null;"], "a new caller must pass the record's entry");
  });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function profile(): AirportProfile {
  return {
    id: "airport-tpe", iataCode: "TPE", name: "Taiwan Taoyuan International Airport", city: "Taoyuan",
    country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.0797, lng: 121.2342,
    domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
  };
}

function layoverSession(nowMs: number, departureInMin: number): LayoverSession {
  return {
    id: SESSION, userId: USER, airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(nowMs).toISOString(),
    departureTime: new Date(nowMs + departureInMin * 60_000).toISOString(),
    boardingTime: null, layoverMinutes: departureInMin,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(),
  };
}

function envelope(
  nowMs: number,
  eventType: LayoverEventEnvelope["eventType"],
  subjectRefs: Array<{ kind: "session" | "airport"; ref: string }>,
  payload: Record<string, unknown>,
): LayoverEventEnvelope {
  const r = normalizeEvent(
    {
      eventId: `evt-${eventType}-${nowMs}`, eventType, occurredAt: new Date(nowMs - 60_000).toISOString(),
      source: "test.feed", sourceEventId: `src-${nowMs}`, subjectRefs, payload, confidence: "HIGH",
    },
    { receivedAtMs: nowMs },
  );
  if (!r.ok) assert.fail(`envelope did not normalise: ${r.reason} ${r.detail}`);
  return r.event;
}

// At the foot: lines above are cited by line (an ESM import is hoisted wherever it is written).
import { landsideNotForbidden } from "../services/airport/LayoverSnapshot.js";
