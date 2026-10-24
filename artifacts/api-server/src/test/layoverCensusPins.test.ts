/**
 * census-layover — router-level pins for verdicts that turn on PRODUCTION'S
 * recorded state, not on the code alone.
 *
 * ── WHY A SEPARATE SUITE ────────────────────────────────────────────────────
 * The census grades a row C only when "the requirement, in the spec's words, is
 * met by code a traveller's path really reaches", and its Rule A.2 / WAVE-1
 * ruling keeps a row off C when its flag is FALSE or its storage is an
 * unapplied migration. Whether a path is reachable is therefore a fact about the
 * code AND about production's flags and migrations. The route suites stage
 * whatever flags each case needs, which is right for testing the code and
 * silent about production. This suite stages `feature_flags` FROM the
 * production snapshot the repository already holds
 * (`lib/capability/snapshots/current.ts`) and reads the applied-migration
 * ledger (`lib/capability/production-applied-migrations.json`), so each case
 * says what a production traveller is served today — and goes red when a press
 * or a snapshot refresh changes that, which is the moment the row's verdict
 * must be re-derived. The failure messages say which row and what to do.
 *
 * ── WHAT IS PINNED ──────────────────────────────────────────────────────────
 *   L232  §21.1 "Crew mixed departures → Shared constraint = earliest or
 *         explicit split": three travellers whose flights leave at three
 *         different times form a crew over the REAL router; the crew read
 *         publishes the EARLIEST member's certified return as the shared
 *         constraint and names that member, under production's flag state.
 *   L181  `reconcile` reaches a traveller only through
 *   L197  `GET`/`POST /airport/sessions/:id/observations`, and both refuse
 *         unless `layover_crowd_reports_enabled` is ON (since 2026-10-21 it is: re-pinned 2026-10-24). 3513 seeds that flag
 *         and is not applied in production, so production serves neither:
 *         the C both rows were given at census §41 (when the only gate was
 *         `airport_mode_enabled`) does not hold at HEAD.
 *
 * Loopback: binds 127.0.0.1 (run unsandboxed). No production or remote
 * database is touched; the snapshot and the ledger are files in this tree.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverCensusPins.test.ts
 */
// The observer handle is an HMAC and refuses to derive without a pepper. Read
// at call time, so setting it here (after the hoisted imports) is in time.
process.env.SESSION_SECRET ??= "layover-census-pins-session-secret";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { LAYOVER_CROWD_REPORTS_FLAG, OBSERVATION_TABLE } from "../services/layover/LayoverObservationService.js";
import { CREW_TABLE, CREW_MEMBER_TABLE } from "../services/layover/LayoverCrewStore.js";
import { PRODUCTION_SNAPSHOT_FILENAME, PRODUCTION_SNAPSHOT_URL } from "../lib/capability/snapshots/current.js";

// ── production's recorded state ──────────────────────────────────────────────

const SNAPSHOT = JSON.parse(readFileSync(PRODUCTION_SNAPSHOT_URL, "utf8")) as {
  productionMigrationWatermark: string;
  flags: Record<string, boolean>;
};
const LEDGER_FILE = "lib/capability/production-applied-migrations.json";
const LEDGER = JSON.parse(readFileSync(new URL(`../${LEDGER_FILE}`, import.meta.url), "utf8")) as {
  migrations: Array<{ version: string; name: string }>;
};
/** Is migration `<number>_…` recorded as applied to production? */
const appliedInProduction = (number: string) => LEDGER.migrations.some((m) => m.name.startsWith(`${number}_`));
/** `feature_flags` exactly as the snapshot recorded it: every row, every value, and no row it does not hold. */
const productionFlagRows = () => Object.entries(SNAPSHOT.flags).map(([flag, enabled]) => ({ flag, enabled }));

// ── the world ────────────────────────────────────────────────────────────────

const OWNER = "pin-owner";
const EARLY = "pin-early";
const MIDDLE = "pin-middle";
const TOKENS: Record<string, string> = { [OWNER]: "pin-owner-token", [EARLY]: "pin-early-token", [MIDDLE]: "pin-middle-token" };
const SESSION_OF: Record<string, string> = { [OWNER]: "pin-session-owner", [EARLY]: "pin-session-early", [MIDDLE]: "pin-session-middle" };
/**
 * Hours until each traveller's flight. Mixed, and the EARLIEST is neither the
 * founder nor the last to join, so a crew deadline read from a position (the
 * owner's, the newest member's) cannot equal the minimum by coincidence.
 */
const DEPARTS_IN_H: Record<string, number> = { [OWNER]: 9, [EARLY]: 4, [MIDDLE]: 6 };

let server: http.Server;
let base = "";
let tables: Record<string, any[]> = {};

function stage(extraFlags: Array<{ flag: string; enabled: boolean }> = []) {
  const now = Date.now();
  tables = {
    feature_flags: [...productionFlagRows().filter((r) => !extraFlags.some((e) => e.flag === r.flag)), ...extraFlags], // an extra row REPLACES production's row of the same name
    airport_profiles: [airportRow()],
    layover_sessions: [OWNER, EARLY, MIDDLE].map((u) =>
      sessionRow({ id: SESSION_OF[u], user_id: u, departure_time: new Date(now + DEPARTS_IN_H[u]! * 3_600_000).toISOString() }),
    ),
    layover_recommendations: [], layover_plan_stops: [], layover_events: [],
    location_preferences: [], trip_crew_location_preferences: [], blocks: [],
    // `passport_entry_intelligence_enabled` is TRUE in production, so the
    // viewer's own corridor is read; no passport on file is an honest unknown.
    traveler_passports: [], entry_requirements: [],
    profiles: [OWNER, EARLY, MIDDLE].map((u) => ({ id: u, handle: u, name: u, avatar_url: null, show_name_publicly: true })),
    [OBSERVATION_TABLE]: [],
    [CREW_TABLE]: [],
    [CREW_MEMBER_TABLE]: [],
  };
  _setTestClient(
    makeLayoverDb(tables, { users: Object.fromEntries(Object.entries(TOKENS).map(([u, t]) => [t, u])) }) as any,
    true,
  );
}

function request(method: "GET" | "POST", path: string, user: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${TOKENS[user]}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const crewPath = (u: string) => `/api/airport/sessions/${SESSION_OF[u]}/crew`;
const observationsPath = `/api/airport/sessions/${SESSION_OF[OWNER]}/observations`;
const aReport = () => ({ factType: "queue_report_minutes", value: 22, submissionToken: `pin-${Math.random().toString(16).slice(2)}0000` });

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => { server?.close(); _setTestClient(null as any, false); });

// ── L232 ─────────────────────────────────────────────────────────────────────

describe("census-layover L232 — §21.1 crew mixed departures, over the real router, in production's flag state", () => {
  it("PRECONDITIONS: crew storage (2984) is applied and the router's one gate is ON in the production snapshot", () => {
    assert.ok(
      appliedInProduction("2984"),
      `2984_layover_crews is no longer recorded in ${LEDGER_FILE} — no production session can form a crew; L232 (and L133, L28, L29) must be re-derived`,
    );
    assert.equal(
      SNAPSHOT.flags.airport_mode_enabled, true,
      `airport_mode_enabled is not TRUE in ${PRODUCTION_SNAPSHOT_FILENAME} — the whole Layover router refuses; every route-level C row must be re-derived`,
    );
  });

  it("three different departures → the crew's shared constraint is the EARLIEST member's certified return, and that member is named", async () => {
    stage();
    const created = await request("POST", crewPath(OWNER), OWNER, { title: "Mixed departures" });
    assert.equal(created.status, 200, `a crew could not be formed in production's flag state: ${created.raw}`);
    const crewId = created.body.crew.id;
    for (const u of [EARLY, MIDDLE]) {
      const joined = await request("POST", `${crewPath(u)}/${crewId}/join`, u);
      assert.equal(joined.status, 200, `${u} could not join in production's flag state: ${joined.raw}`);
    }

    const read = await request("GET", crewPath(OWNER), OWNER);
    assert.equal(read.status, 200, `GET /crew refused in production's flag state: ${read.raw}`);
    assert.equal(read.body.inCrew, true);
    assert.equal(read.body.crew.memberCount, 3);
    const sol = read.body.solution;
    assert.ok(sol, "the crew read published no certified solution");

    const returnOf = (u: string) => sol.members.find((m: any) => m.userId === u)?.requiredReturnBy as string | undefined;
    for (const u of [OWNER, EARLY, MIDDLE]) assert.ok(returnOf(u), `${u} has no certified return on the wire`);
    const ms = (u: string) => Date.parse(returnOf(u)!);
    // Control: the three certified returns are in departure order and differ,
    // so equality below can only mean the minimum was taken.
    assert.ok(ms(EARLY) < ms(MIDDLE) && ms(MIDDLE) < ms(OWNER), `control: certified returns are not in departure order: ${JSON.stringify(sol.members)}`);
    assert.ok(ms(EARLY) < Date.parse(tables.layover_sessions.find((s: any) => s.user_id === EARLY).departure_time), "control: a certified return after the flight");

    assert.equal(sol.sharedReturnBy, returnOf(EARLY), "the shared constraint is not the EARLIEST member's certified return");
    assert.deepEqual(sol.bindingMemberIds, [EARLY], "the member who binds the shared constraint is not named, or someone who does not bind is");
    assert.equal(sol.bindingMemberHidden, false);
  });

  it("every member reads the SAME shared constraint — the earliest — not their own", async () => {
    // The joiner who departs latest but one must not be handed their own later
    // return; the constraint is the crew's.
    stage();
    const created = await request("POST", crewPath(OWNER), OWNER, { title: "Mixed departures" });
    const crewId = created.body.crew.id;
    for (const u of [EARLY, MIDDLE]) await request("POST", `${crewPath(u)}/${crewId}/join`, u);
    const shared = new Set<string>();
    for (const u of [OWNER, EARLY, MIDDLE]) {
      const read = await request("GET", crewPath(u), u);
      assert.equal(read.status, 200, read.raw);
      shared.add(read.body.solution.sharedReturnBy);
      const mine = read.body.solution.members.find((m: any) => m.userId === u);
      if (u !== EARLY) assert.ok(Date.parse(read.body.solution.sharedReturnBy) < Date.parse(mine.requiredReturnBy), `${u} was not bound by the earlier member`);
    }
    assert.equal(shared.size, 1, `members read different shared constraints: ${[...shared].join(" | ")}`);
  });
});

// ── L181 / L197 ──────────────────────────────────────────────────────────────

describe("census-layover L181/L197 — the crowd-report channel is OPEN in production's recorded state (3513 applied 2026-10-21, flag ON)", () => {
  // Re-pinned at the 2026-10-24 capability refresh. Until then this block pinned the channel CLOSED (3513 unapplied, no
  // flag row), and its first case said what to do the day that changed: "re-derive the three rows (they may return to C),
  // and update this pin". The record moved, so the pin moves with it. Re-deriving L181/L197/L82 is the layover lane's
  // next census pass; this suite now states what a production traveller is served TODAY, and goes red when that changes.
  it("PRECONDITIONS: 3513 is recorded as applied, and the channel's flag row is present and ON in production", () => {
    assert.equal(appliedInProduction("3513"), true, `3513 is no longer recorded as applied in ${LEDGER_FILE}. Re-derive L181/L197/L82 and update this pin.`);
    assert.equal(SNAPSHOT.flags[LAYOVER_CROWD_REPORTS_FLAG], true, `${LAYOVER_CROWD_REPORTS_FLAG} is not ON in ${PRODUCTION_SNAPSHOT_FILENAME} (=${String(SNAPSHOT.flags[LAYOVER_CROWD_REPORTS_FLAG])}). Re-derive L181/L197/L82 against its value and update this pin.`);
    assert.equal(SNAPSHOT.flags.airport_mode_enabled, true, "control: the router's own gate is open too");
  });

  it("GET /observations — the ONLY production caller of reconcileAirportFact — serves a reconciled reading", async () => {
    stage();
    const r = await request("GET", observationsPath, OWNER);
    assert.equal(r.status, 200, `the reconciled reading is refused in production's flag state — L181 is not reachable: ${r.raw}`);
    assert.ok(Array.isArray(r.body.facts) && r.body.facts.length > 0, "an open channel published no reading");
  });

  it("POST /observations — the ONLY production writer of airport_fact_observations — accepts a traveller report and stores it", async () => {
    stage();
    const r = await request("POST", observationsPath, OWNER, aReport());
    assert.equal(r.status, 200, `a traveller report is refused in production's flag state — L197's table is not populated: ${r.raw}`);
    assert.equal(tables[OBSERVATION_TABLE].length, 1, "the open channel stored nothing");
  });

  it("CONTROL: in the same production state, the rest of Layover serves too", async () => {
    stage();
    const r = await request("GET", crewPath(OWNER), OWNER);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
  });

  it("CONTROL: the flag, not code, is what opens both routes — with it OFF they refuse and nothing is stored", async () => {
    stage([{ flag: LAYOVER_CROWD_REPORTS_FLAG, enabled: false }]);
    const post = await request("POST", observationsPath, OWNER, aReport());
    assert.equal(post.status, 503, `with the flag OFF the report is accepted: ${post.raw}`);
    assert.deepEqual(tables[OBSERVATION_TABLE], [], "with the flag OFF the report reached the store");
    const get = await request("GET", observationsPath, OWNER);
    assert.equal(get.status, 503, `with the flag OFF the reading is served: ${get.raw}`);
    assert.equal(get.body.facts, undefined, "a closed channel published a facts list");
  });
});
