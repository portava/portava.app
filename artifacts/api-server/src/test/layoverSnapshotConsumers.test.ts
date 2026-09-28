/**
 * census-discovery §81 (lane W10-S2) — A13: the Layover consumers read the ONE
 * certified snapshot instead of certifying inline. Register: D-W10S2-1.
 *
 * node:test + node:assert (NOT vitest). Real router, fake table-backed DB
 * (`helpers/fakeLayoverDb.ts`), frozen `Date`, no network.
 *
 * Layover `:66` — *"All surfaces consume the same certified LayoverSnapshot /
 * RecommendationContract; no duplicate time-budget logic"*; `:803` — *"One
 * canonical LayoverSnapshot drives Trips, Compass, Discovery, Map and Safe
 * Return"*. §65 gave every inline certification the snapshot's entry input;
 * this suite pins that, with `layover_snapshot_consumers_enabled` ON, each
 * consumer surface reads `certifiedLayoverSnapshot` itself, and that OFF each
 * one is byte-identical to the legacy arm.
 *
 * WHAT IS PINNED
 *   C1  the static ratchet: every production `certifySessionFeasibility(` call
 *       is the snapshot's own, a legacy arm (`?? certifySessionFeasibility(`,
 *       reached only when the snapshot read answered null), or one of the
 *       enumerated COUNTERFACTUAL certifications (a session that is not the
 *       traveller's current one). Anything else fails.
 *   C2  PARITY: for every consumer route the body with the flag ON equals the
 *       body with it OFF, in a refused and a permitted world, with the clock
 *       frozen — the snapshot certifies the same inputs through the same engine.
 *   C3  the Compass answer's usable minutes: OFF it keeps its own
 *       `cutoff − now − buffer`; ON it is the snapshot's `usableMinutes`. The
 *       two differ early in a layover (before the exit delay has elapsed), and
 *       that difference is asserted so the case is not vacuous.
 *   C4  the snapshot's `loaded` door reads neither `layover_sessions` nor
 *       `airport_profiles`, and certifies what the unloaded door certifies.
 *   C5  an unreadable `feature_flags` is OFF (the legacy arm), never a guess.
 *   C6  generateRecommendations and layoverBuddyDecision: ON equals OFF.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverSnapshotConsumers.test.ts
 */
import { describe, it, before, after, mock } from "node:test";
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
import {
  certifiedLayoverSnapshot,
  consumerLayoverSnapshot,
  LAYOVER_SNAPSHOT_CONSUMERS_FLAG,
} from "../services/airport/LayoverSnapshot.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { layoverBuddyDecision } from "../services/airport/LayoverBuddyGate.js";
import { airportRowToProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = "snapshot-consumer-token";
const USER = "user-1";
const SESSION = "session-1";
const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T02:00:00.000Z"); // 10:00 in Asia/Taipei

type Rows = Record<string, Array<Record<string, unknown>>>;
type World = "refused" | "permitted";

function at(v: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

function corridorRow(status: string) {
  return {
    id: `corr-${status}`, passport_country: "US", destination_country: "TW", status,
    allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
    official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
  };
}

interface Stage {
  world: World;
  consumers: boolean | "unreadable";
  /** Minutes from NOW to arrival. Negative = the traveller landed that long ago. */
  arrivalInMin?: number;
  departureInMin?: number;
}

function tablesFor(s: Stage): Rows {
  return {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_compass_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: true },
      { flag: ENTRY_FLAG, enabled: true },
      ...(s.consumers === true ? [{ flag: LAYOVER_SNAPSHOT_CONSUMERS_FLAG, enabled: true }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      id: SESSION, user_id: USER,
      arrival_time: new Date(NOW + (s.arrivalInMin ?? -2 * 60) * 60_000).toISOString(),
      departure_time: new Date(NOW + (s.departureInMin ?? 10 * 60) * 60_000).toISOString(),
      created_at: new Date(NOW - HOUR).toISOString(), updated_at: new Date(NOW - HOUR).toISOString(),
    })],
    layover_recommendations: [],
    layover_plan_stops: [{
      id: "stop-1", session_id: SESSION, title: "Night market", description: null,
      stop_order: 1, duration_min: 60, travel_min: 25, place_id: null, recommendation_id: null,
      lat: null, lng: null, location_label: null, inside_airport: false, source: "user",
      created_at: new Date(NOW - HOUR).toISOString(),
    }],
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
    discovery_places: [
      { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli",
        blurb: "Snacks", verified: true, city: "Taoyuan", status: "active" },
    ],
    traveler_passports: [
      { user_id: USER, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" },
    ],
    entry_requirements: [corridorRow(s.world === "permitted" ? "visa_free" : "visa_required")],
  };
}

// ── the route harness ────────────────────────────────────────────────────────

let server: http.Server;
let base = "";
let tables: Rows = {};
let reads: string[] = [];

function stage(s: Stage): SupabaseClient {
  tables = tablesFor(s);
  const fake = makeLayoverDb(tables, {
    users: { [TOKEN]: USER },
    failures: s.consumers === "unreadable" ? { "feature_flags:select": { message: "feature_flags unavailable" } } : {},
  });
  // Record every table the request reads, so C4 can say what the door did NOT read.
  const from = fake.from.bind(fake);
  reads = [];
  fake.from = (t: string) => { reads.push(t); return from(t); };
  _setTestClient(fake, true);
  return fake as unknown as SupabaseClient;
}

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; raw: string }> {
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
          resolve({ status: res.statusCode ?? 0, body: parsed, raw: acc });
        });
      },
    );
    r.on("error", reject);
    if (raw !== null) r.write(raw);
    r.end();
  });
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
  mock.timers.enable({ apis: ["Date"], now: NOW });
});
after(() => { mock.timers.reset(); server?.close(); _setTestClient(null, false); });

/** Every consumer route, as a request. */
const SURFACES: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: "GET /safety (the window rating)", method: "GET", path: `/api/airport/sessions/${SESSION}/safety` },
  { name: "GET /stops (the plan and its Map pins)", method: "GET", path: `/api/airport/sessions/${SESSION}/stops` },
  { name: "GET /overview (Trips card, Map envelope, dashboard)", method: "GET", path: `/api/airport/sessions/${SESSION}/overview` },
  { name: "POST /return-deadline (Safe Return reminder)", method: "POST", path: `/api/airport/sessions/${SESSION}/return-deadline`, body: { minutesBefore: 30 } },
  { name: "POST /return-now (Safe Return abort)", method: "POST", path: `/api/airport/sessions/${SESSION}/return-now`, body: {} },
  { name: "POST /disruption (Safe Return, a moved departure)", method: "POST", path: `/api/airport/sessions/${SESSION}/disruption`, body: { kind: "delay", newDepartureTime: new Date(NOW + 12 * HOUR).toISOString() } },
  { name: "GET /buddies (the buddy gate)", method: "GET", path: `/api/airport/sessions/${SESSION}/buddies` },
  { name: "POST /compass (in a window where both figures agree)", method: "POST", path: `/api/airport/sessions/${SESSION}/compass`, body: { question: "Can I leave the airport?" } },
];

// ── C1. the static ratchet ───────────────────────────────────────────────────

describe("C1 — every production certification is the snapshot's, a legacy arm, or a named counterfactual", () => {
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

  /** The enclosing function of an index, by the last `function NAME` before it. */
  function enclosing(src: string, index: number): string {
    const m = [...src.slice(0, index).matchAll(/function\s+([A-Za-z0-9_]+)\s*[(<]/g)].pop();
    return m?.[1] ?? "?";
  }

  /**
   * COUNTERFACTUAL certifications — the engine asked about a session that is not
   * the traveller's current one (or, for the §12.1 base, the unit a flip is
   * compared against, certified with the flips' own parameters). No snapshot of
   * the current session answers them. Keyed by file, enclosing function and the
   * binding, so a second certification inside the same function is not waved
   * through by the first one's entry.
   */
  const COUNTERFACTUAL = new Set([
    "services/airport/LayoverCompassService.ts · valueOfInformation · const base =",     // §12.1: the unit the flips are compared against
    "services/airport/LayoverCompassService.ts · valueOfInformation · const alt =",      // §12.1: the session with one answer flipped
    "services/airport/LayoverSafeReturnService.ts · recomputeForDisruption · const after =", // the session with its NEW departure
    "services/airport/LayoverEventReplanner.ts · handleEvent · const before =",          // under the session's PRIOR live conditions
    "services/airport/LayoverEventReplanner.ts · handleEvent · const after =",           // under the event's live conditions
    "routes/airport.ts · certifyCrewMemberRecord · return",                              // OTHER travellers' sessions
  ]);

  it("no consumer certifies inline without first asking the snapshot", () => {
    const root = join(HERE, "..");
    const offenders: string[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("certifySessionFeasibility")) continue;
      const rel = relative(root, file).split("\\").join("/");
      const re = /certifySessionFeasibility\s*\(/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const lineStart = src.lastIndexOf("\n", m.index) + 1;
        const before = src.slice(lineStart, m.index);
        if (/^\s*(\*|\/\/)/.test(before) || before.includes("//") || /function\s+$/.test(before) || /import|export/.test(before)) continue;
        if (/^\s*certifySessionFeasibility,?\s*$/.test(src.slice(lineStart, src.indexOf("\n", m.index)))) continue;
        total++;
        const fn = enclosing(src, m.index);
        const key = `${rel} · ${fn} · ${before.trim()}`;
        seen.add(key);
        if (rel === "services/airport/LayoverSnapshot.ts") continue;                // THE door
        if (/\?\?\s*$/.test(before)) continue;                                      // a legacy arm, reached only on a null snapshot
        if (COUNTERFACTUAL.has(key)) continue;
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length} (${fn})`);
      }
    }
    assert.ok(total >= 12, `only ${total} certification site(s) found — this test is reading the wrong tree`);
    for (const k of COUNTERFACTUAL) assert.ok(seen.has(k), `the allowlist names ${k}, which no longer certifies — shrink the list`);
    assert.deepEqual(offenders, [], `inline certification(s) that never ask the snapshot: ${offenders.join(", ")}`);
  });
});

// ── C2. parity, surface by surface ───────────────────────────────────────────

/** The recorded ledger, less the fake's own random row ids (the double mints them; the route does not). */
function ledger(): string {
  return JSON.stringify(tables.layover_events ?? []).replace(/"id":"fake-[a-z0-9]+"/g, '"id":"<row>"');
}

describe("C2 — ON equals OFF, byte for byte, on every consumer route", () => {
  for (const world of ["refused", "permitted"] as const) {
    for (const s of SURFACES) {
      it(`${world}: ${s.name}`, async () => {
        stage({ world, consumers: false });
        const off = await send(s.method, s.path, s.body);
        const offEvents = ledger();
        stage({ world, consumers: true });
        const on = await send(s.method, s.path, s.body);
        const onEvents = ledger();
        assert.equal(on.status, off.status, `${s.name}: status ${off.status} → ${on.status}: ${on.raw}`);
        assert.ok(off.status < 500, `fixture: ${s.name} answered ${off.status}: ${off.raw}`);
        assert.equal(on.raw, off.raw, `${s.name}: the snapshot arm published a different body`);
        assert.equal(onEvents, offEvents, `${s.name}: the snapshot arm recorded a different ledger`);
      });
    }
  }
});

// ── C3. the Compass answer's usable minutes come off the snapshot ───────────

describe("C3 — the in-layover Compass answer reads usableMinutes off the certified snapshot", () => {
  /** Early in a layover: landed now, the exit delay has not elapsed yet. */
  const EARLY: Omit<Stage, "consumers"> = { world: "permitted", arrivalInMin: 0, departureInMin: 9 * 60 };

  function usableIn(answer: unknown): number {
    const m = /about (\d+) minutes of usable time/.exec(String(answer));
    assert.ok(m, `the deterministic answer did not state usable minutes: ${String(answer)}`);
    return Number(m[1]);
  }

  it("OFF keeps the legacy `cutoff − now − buffer`; ON is the snapshot's figure; the two differ here", async () => {
    const dbOff = stage({ ...EARLY, consumers: false });
    const off = await send("POST", `/api/airport/sessions/${SESSION}/compass`, { question: "Can I leave the airport?" });
    assert.equal(off.status, 200, off.raw);
    const snap = await certifiedLayoverSnapshot(dbOff, USER, { nowMs: NOW });
    assert.ok(snap.ok, JSON.stringify(snap));
    if (!snap.ok) return;

    stage({ ...EARLY, consumers: true });
    const on = await send("POST", `/api/airport/sessions/${SESSION}/compass`, { question: "Can I leave the airport?" });
    assert.equal(on.status, 200, on.raw);

    assert.equal(usableIn(at(on.body, "answer")), snap.snapshot.usableMinutes, "ON must publish the snapshot's usable minutes");
    assert.notEqual(usableIn(at(off.body, "answer")), snap.snapshot.usableMinutes,
      "fixture: in this window the legacy re-derivation and the snapshot must differ, or C3 proves nothing");
    assert.equal(at(on.body, "certification", "inputHash"), snap.snapshot.certification.inputHash,
      "ON must certify exactly the snapshot's inputs");
  });
});

// ── C4. the loaded door ──────────────────────────────────────────────────────

describe("C4 — `loaded`: no session or airport read, the same certification", () => {
  it("reads neither layover_sessions nor airport_profiles, and yields the unloaded snapshot's id", async () => {
    const db = stage({ world: "refused", consumers: true });
    const plain = await certifiedLayoverSnapshot(db, USER, { nowMs: NOW });
    assert.ok(plain.ok);
    if (!plain.ok) return;
    const session = await sessionOf(db);
    const airport = airportRowToProfile(tables.airport_profiles![0]!);
    reads = [];
    const snap = await consumerLayoverSnapshot(db, airport, session, NOW);
    assert.ok(snap, "flag ON must yield a snapshot");
    assert.equal(snap?.snapshotId, plain.snapshot.snapshotId);
    assert.equal(snap?.verdict, "no");
    assert.ok(!reads.includes("layover_sessions") && !reads.includes("airport_profiles"), `the loaded door re-read: ${reads.join(",")}`);
  });
});

// ── C5. an unreadable flag is OFF ────────────────────────────────────────────

describe("C5 — an unreadable feature_flags takes the legacy arm", () => {
  it("consumerLayoverSnapshot answers null, and a route still answers from the legacy certification", async () => {
    const db = stage({ world: "permitted", consumers: "unreadable" });
    const session = await sessionOf(db);
    const airport = airportRowToProfile(tables.airport_profiles![0]!);
    assert.equal(await consumerLayoverSnapshot(db, airport, session, NOW), null);
  });
});

// ── C6. the two service consumers ────────────────────────────────────────────

describe("C6 — generateRecommendations and the buddy gate: ON equals OFF", () => {
  it("recommendations: the same cards, the same certification, in both worlds", async () => {
    for (const world of ["refused", "permitted"] as const) {
      const offDb = stage({ world, consumers: false });
      const session = await sessionOf(offDb);
      const airport = airportRowToProfile(tables.airport_profiles![0]!);
      const off = await generateRecommendations(offDb, airport, session, NOW);
      const onDb = stage({ world, consumers: true });
      const on = await generateRecommendations(onDb, airport, session, NOW);
      assert.equal(JSON.stringify(on), JSON.stringify(off), world);
    }
  });

  it("buddy gate: handed the snapshot's record it decides exactly what it decides on its own", async () => {
    for (const world of ["refused", "permitted"] as const) {
      const db = stage({ world, consumers: true });
      const session = await sessionOf(db);
      const airport = airportRowToProfile(tables.airport_profiles![0]!);
      const snap = await consumerLayoverSnapshot(db, airport, session, NOW);
      assert.ok(snap);
      if (!snap) return;
      const own = layoverBuddyDecision(airport, session, NOW, snap.certifiedRecord.inputs.entry ?? null);
      const read = layoverBuddyDecision(airport, session, NOW, null, snap.certifiedRecord);
      assert.equal(JSON.stringify(read), JSON.stringify(own), world);
    }
  });
});

async function sessionOf(db: SupabaseClient): Promise<LayoverSession> {
  const { getSession } = await import("../services/airport/LayoverSessionService.js");
  const r = await getSession(db, SESSION, USER);
  assert.ok(r.ok && r.session, "fixture: the session must read");
  if (!r.ok || !r.session) throw new Error("unreachable");
  return r.session;
}
